import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentRun } from "@nanasa/contracts";
import { z } from "zod";

import { DomainError, NanasaStore } from "./store.js";

const AgentCapabilitySchema = z
  .object({
    version: z.literal(1),
    groupId: z.string().min(1).max(128),
    memberId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    generation: z.number().int().positive(),
    issuedAt: z.number().int().nonnegative(),
    nonce: z.string().min(16),
  })
  .strict();

interface McpCredentialIssuerOptions {
  secretPath: string;
  operatorToken?: string;
  expectedUid?: number;
}

export interface McpAgentPrincipal {
  kind: "agent";
  groupId: string;
  memberId: string;
  runId: string;
  generation: number;
}

export interface McpOperatorPrincipal {
  kind: "operator";
  operatorId: "remote-operator";
}

export type McpPrincipal = McpAgentPrincipal | McpOperatorPrincipal;

function ensureSecretDirectory(path: string, expectedUid: number | undefined): void {
  const directory = resolve(dirname(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("MCP credential secret directory must be a regular directory");
  }
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error("MCP credential secret directory must be owned by the current user");
  }
  if (realpathSync(directory) !== directory) {
    throw new Error("MCP credential secret directory must not traverse symlinks");
  }
  chmodSync(directory, 0o700);
}

function readSecret(path: string, expectedUid: number | undefined): Buffer {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) {
    throw new Error("MCP credential secret must not be a symlink");
  }
  if (!before.isFile()) {
    throw new Error("MCP credential secret must be a regular file");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const nonBlocking = constants.O_NONBLOCK ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.dev !== before.dev ||
      metadata.ino !== before.ino ||
      metadata.nlink !== 1
    ) {
      throw new Error("MCP credential secret must be an unchanged regular file");
    }
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
      throw new Error("MCP credential secret must be owned by the current user");
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error("MCP credential secret permissions must be 0600");
    }
    const existing = readFileSync(descriptor);
    if (existing.length !== 32) {
      throw new Error("MCP credential secret must contain 32 bytes");
    }
    return existing;
  } finally {
    closeSync(descriptor);
  }
}

function createSecret(path: string): Buffer {
  const secret = randomBytes(32);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    writeFileSync(descriptor, secret);
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
  return secret;
}

function readOrCreateSecret(path: string, expectedUid = process.getuid?.()): Buffer {
  ensureSecretDirectory(path, process.getuid?.());
  try {
    return readSecret(path, expectedUid);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  try {
    return createSecret(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return readSecret(path, expectedUid);
  }
}

function tokenEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export class McpCredentialIssuer {
  readonly #store: NanasaStore;
  readonly #secret: Buffer;
  readonly #operatorToken: string | undefined;

  public constructor(store: NanasaStore, options: McpCredentialIssuerOptions) {
    this.#store = store;
    this.#secret = readOrCreateSecret(options.secretPath, options.expectedUid);
    this.#operatorToken = options.operatorToken;
  }

  public issueAgent(run: AgentRun): string {
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        groupId: run.groupId,
        memberId: run.memberId,
        runId: run.id,
        generation: run.generation,
        issuedAt: Date.now(),
        nonce: randomBytes(16).toString("base64url"),
      }),
    ).toString("base64url");
    return `${payload}.${this.#sign(payload)}`;
  }

  public authenticate(authorization: string | string[] | undefined): McpPrincipal {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      throw new DomainError("mcp_unauthorized", "A bearer credential is required", 401);
    }
    const token = authorization.slice("Bearer ".length);
    if (token.length === 0 || token.trim() !== token || token.includes(" ")) {
      throw new DomainError("mcp_unauthorized", "The bearer credential is invalid", 401);
    }
    if (this.#operatorToken !== undefined && tokenEquals(token, this.#operatorToken)) {
      return { kind: "operator", operatorId: "remote-operator" };
    }
    return this.#authenticateAgent(token);
  }

  #authenticateAgent(token: string): McpAgentPrincipal {
    const segments = token.split(".");
    if (segments.length !== 2) {
      throw new DomainError("mcp_unauthorized", "The bearer credential is invalid", 401);
    }
    const [payload = "", signature = ""] = segments;
    if (!tokenEquals(signature, this.#sign(payload))) {
      throw new DomainError("mcp_unauthorized", "The bearer credential is invalid", 401);
    }

    let capability: z.infer<typeof AgentCapabilitySchema>;
    try {
      capability = AgentCapabilitySchema.parse(
        JSON.parse(Buffer.from(payload, "base64url").toString()),
      );
    } catch {
      throw new DomainError("mcp_unauthorized", "The bearer credential is invalid", 401);
    }

    let run: AgentRun;
    try {
      run = this.#store.getRun(capability.runId);
    } catch {
      throw new DomainError(
        "mcp_credential_revoked",
        "The agent credential is no longer active",
        401,
      );
    }
    const membership = this.#store
      .listActiveMemberships(capability.groupId)
      .find((candidate) => candidate.memberId === capability.memberId);
    const activeRun = this.#store.getActiveRun(capability.groupId, capability.memberId);
    if (
      run.groupId !== capability.groupId ||
      run.memberId !== capability.memberId ||
      run.generation !== capability.generation ||
      run.desiredState !== "running" ||
      !["starting", "running"].includes(run.status) ||
      activeRun?.id !== run.id ||
      activeRun.generation !== run.generation ||
      membership === undefined
    ) {
      throw new DomainError(
        "mcp_credential_revoked",
        "The agent credential is no longer active",
        401,
      );
    }
    return {
      kind: "agent",
      groupId: capability.groupId,
      memberId: capability.memberId,
      runId: capability.runId,
      generation: capability.generation,
    };
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#secret).update(payload).digest("base64url");
  }
}
