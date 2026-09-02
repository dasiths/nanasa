import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { REQUIRED_PROVIDER_EXTENSION_PERMISSIONS } from "@nanasa/contracts";
import {
  ExtensionPackageError,
  ExtensionPackageLoader,
} from "../src/extensions/extension-package-loader.js";

const temporaryDirectories: string[] = [];
const keys = generateKeyPairSync("ed25519");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "nanasa.dev/provider-extension/v1",
    kind: "ProviderExtension",
    metadata: {
      id: "example.copilot",
      name: "Example Copilot",
      version: "1.0.0",
      publisher: "Example",
      description: "Reviewed declarative provider package",
    },
    compatibility: { minNanasaVersion: "0.0.0", reporterProtocol: 2 },
    providers: [
      {
        id: "example-copilot",
        displayName: "Example Copilot",
        commandNames: ["copilot"],
        strategies: {
          adapter: "copilot-adapter-v1",
          home: "copilot-home-v1",
          prompt: "copilot-agent-v1",
          mcp: "copilot-mcp-v1",
          reporter: "copilot-hooks-v2",
          control: "copilot-terminal-v1",
          nativeResume: "copilot-resume-v1",
          provisioning: ["owned-file-v1"],
        },
      },
    ],
    permissions: [...REQUIRED_PROVIDER_EXTENSION_PERMISSIONS],
    assets: [],
    ...overrides,
  };
}

function octal(value: number, length: number): Buffer {
  return Buffer.from(value.toString(8).padStart(length - 1, "0") + "\0", "ascii");
}

interface TarEntry {
  path: string;
  content?: Buffer;
  type?: string;
  link?: string;
}

function tar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    Buffer.from(entry.path).copy(header, 0, 0, 100);
    octal(0o600, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(content.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    if (entry.link !== undefined) Buffer.from(entry.link).copy(header, 157, 0, 100);
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    octal(
      header.reduce((sum, byte) => sum + byte, 0),
      8,
    ).copy(header, 148);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1_024));
  return Buffer.concat(blocks);
}

function archive(manifest = descriptor(), entries: TarEntry[] = []): Buffer {
  return tar([
    { path: "nanasa-extension.yaml", content: Buffer.from(stringify(manifest)) },
    ...entries,
  ]);
}

function loader() {
  const root = mkdtempSync(join(tmpdir(), "nanasa-extension-loader-"));
  temporaryDirectories.push(root);
  return new ExtensionPackageLoader({
    packageRoot: join(root, "packages"),
    productVersion: "0.0.0",
    trustKeys: { fixture: keys.publicKey.export({ type: "spki", format: "pem" }) },
  });
}

function signed(input: Buffer) {
  const digest = createHash("sha256").update(input).digest("hex");
  return {
    digest,
    signature: {
      algorithm: "ed25519" as const,
      keyId: "fixture",
      signature: sign(null, Buffer.from(digest, "hex"), keys.privateKey).toString("base64url"),
    },
  };
}

describe("ExtensionPackageLoader supply-chain controls", () => {
  it("verifies and reuses one immutable data-only package", () => {
    const input = archive();
    const proof = signed(input);
    const packageLoader = loader();
    const loaded = packageLoader.loadArchive(input, proof.digest, proof.signature);
    const first = packageLoader.installImmutable(loaded);
    expect(packageLoader.installImmutable(loaded)).toBe(first);
  });

  it.each([
    [
      "traversal",
      [{ path: "../escape.json", content: Buffer.from("{}") }],
      "extension_path_unsafe",
    ],
    [
      "absolute path",
      [{ path: "/escape.json", content: Buffer.from("{}") }],
      "extension_path_unsafe",
    ],
    ["symlink", [{ path: "link", type: "2", link: "target" }], "extension_link_forbidden"],
    ["hard link", [{ path: "hard", type: "1", link: "target" }], "extension_link_forbidden"],
    ["device", [{ path: "device", type: "3" }], "extension_device_forbidden"],
    [
      "case collision",
      [
        { path: "asset.json", content: Buffer.from("{}") },
        { path: "ASSET.json", content: Buffer.from("{}") },
      ],
      "extension_path_collision",
    ],
    [
      "Unicode normalization collision",
      [
        { path: "caf\u00e9.json", content: Buffer.from("{}") },
        { path: "cafe\u0301.json", content: Buffer.from("{}") },
      ],
      "extension_path_collision",
    ],
  ])("rejects malicious archive %s", (_name, entries, code) => {
    const input = archive(descriptor(), entries as TarEntry[]);
    const proof = signed(input);
    expect(() => loader().loadArchive(input, proof.digest, proof.signature)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects compressed expansion beyond the bounded package budget", () => {
    const input = gzipSync(Buffer.alloc(17 * 1_024 * 1_024));
    const proof = signed(input);
    expect(() => loader().loadArchive(input, proof.digest, proof.signature)).toThrowError(
      expect.objectContaining({ code: "extension_decompression_limit" }),
    );
  });

  it("rejects digest, signature, strategy, permission, executable asset, and compatibility attacks", () => {
    const input = archive();
    const proof = signed(input);
    expect(() => loader().loadArchive(input, "0".repeat(64), proof.signature)).toThrowError(
      expect.objectContaining({ code: "extension_package_digest_mismatch" }),
    );
    expect(() =>
      loader().loadArchive(input, proof.digest, { ...proof.signature, signature: "A".repeat(86) }),
    ).toThrowError(expect.objectContaining({ code: "extension_signature_invalid" }));
    for (const manifest of [
      descriptor({
        providers: [
          {
            ...descriptor().providers[0],
            strategies: { ...descriptor().providers[0]!.strategies, reporter: "unknown-hook" },
          },
        ],
      }),
      descriptor({ permissions: ["runtime:*"], assets: [] }),
      descriptor({
        assets: [
          {
            path: "assets/install.sh",
            mediaType: "text/plain",
            bytes: 1,
            sha256: "a".repeat(64),
          },
        ],
      }),
      descriptor({ compatibility: { minNanasaVersion: "9.0.0", reporterProtocol: 2 } }),
    ]) {
      const candidate = archive(manifest);
      const candidateProof = signed(candidate);
      expect(() =>
        loader().loadArchive(candidate, candidateProof.digest, candidateProof.signature),
      ).toThrow(ExtensionPackageError);
    }
  });

  it("refuses a symlink at an immutable cache target", () => {
    const input = archive();
    const proof = signed(input);
    const packageLoader = loader();
    const loaded = packageLoader.loadArchive(input, proof.digest, proof.signature);
    const cacheRoot = mkdtempSync(join(tmpdir(), "nanasa-extension-cache-link-"));
    temporaryDirectories.push(cacheRoot);
    const linkedLoader = new ExtensionPackageLoader({
      packageRoot: join(cacheRoot, "packages"),
      productVersion: "0.0.0",
      trustKeys: { fixture: keys.publicKey.export({ type: "spki", format: "pem" }) },
    });
    const extensionRoot = join(cacheRoot, "packages", "example.copilot", "1.0.0");
    const real = mkdtempSync(join(tmpdir(), "nanasa-extension-foreign-"));
    temporaryDirectories.push(real);
    mkdirSync(extensionRoot, { recursive: true });
    symlinkSync(real, join(extensionRoot, loaded.packageDigest));
    expect(() => linkedLoader.installImmutable(loaded)).toThrowError(
      expect.objectContaining({ code: "extension_cache_unsafe" }),
    );
  });
});
