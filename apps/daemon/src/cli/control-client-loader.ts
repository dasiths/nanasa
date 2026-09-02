import { constants, fstatSync, lstatSync, openSync, readFileSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { NanasaControlClient, NanasaControlResources } from "@nanasa/control-client";
import { loadNanasaConfig } from "../config-loader.js";

export interface LoadedControlClient {
  readonly transport: NanasaControlClient;
  readonly resources: NanasaControlResources;
  readonly apiUrl: string;
  readonly operatorToken: string;
}

function readOwnerCredential(path: string): string {
  const resolved = resolve(path);
  const metadata = lstatSync(resolved);
  const expectedUid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && metadata.uid !== expectedUid)
  ) {
    throw new Error("Operator credential must be an owner-only regular file");
  }
  const descriptor = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error("Operator credential changed while opening");
    }
    const value = readFileSync(descriptor);
    if (value.length !== 32) throw new Error("Operator credential must contain 32 bytes");
    return value.toString("base64url");
  } finally {
    closeSync(descriptor);
  }
}

export function loadControlClient(
  repositoryRoot: string,
  options: { apiUrl?: string; operatorTokenFile?: string } = {},
): LoadedControlClient {
  const loaded = loadNanasaConfig(repositoryRoot);
  const apiUrl = (options.apiUrl ?? process.env.NANASA_API_URL ?? "http://127.0.0.1:3210").replace(
    /\/$/,
    "",
  );
  const parsed = new URL(apiUrl);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("The operator control API must use an explicit loopback HTTP URL");
  }
  const operatorToken = readOwnerCredential(
    options.operatorTokenFile ?? join(loaded.runtimeDirectory, "operator-secret"),
  );
  const transport = new NanasaControlClient({ baseUrl: apiUrl, operatorToken });
  return {
    transport,
    resources: new NanasaControlResources(transport),
    apiUrl,
    operatorToken,
  };
}
