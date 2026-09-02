import { createHash, createPublicKey, verify } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  type ExtensionPackageSignature,
  ExtensionPackageSignatureSchema,
  type ProviderExtensionDescriptor,
  ProviderExtensionDescriptorSchema,
} from "@nanasa/contracts";
import { isScalar, parseDocument, visit } from "yaml";

const MANIFEST_PATH = "nanasa-extension.yaml";
const MAX_ARCHIVE_BYTES = 4 * 1_024 * 1_024;
const MAX_EXPANDED_BYTES = 16 * 1_024 * 1_024;
const MAX_FILE_BYTES = 1 * 1_024 * 1_024;
const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_FILES = 128;
const MAX_DEPTH = 16;
const MAX_YAML_NODES = 5_000;
const TAR_BLOCK = 512;

export class ExtensionPackageError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ExtensionPackageError";
  }
}

export interface LoadedExtensionPackage {
  readonly descriptor: ProviderExtensionDescriptor;
  readonly descriptorDigest: string;
  readonly packageDigest: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly signature?: ExtensionPackageSignature;
}

export interface ExtensionPackageLoaderOptions {
  readonly packageRoot: string;
  readonly productVersion: string;
  readonly trustKeys?: Readonly<Record<string, string | Buffer>>;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function descriptorDigest(descriptor: ProviderExtensionDescriptor): string {
  return sha256(canonicalJson(descriptor));
}

export function compareSemanticVersions(left: string, right: string): number {
  const parse = (value: string) => value.split("-", 1)[0]!.split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

export function assertCompatible(
  descriptor: ProviderExtensionDescriptor,
  productVersion: string,
): void {
  if (compareSemanticVersions(productVersion, descriptor.compatibility.minNanasaVersion) < 0) {
    throw new ExtensionPackageError(
      "extension_incompatible",
      `${descriptor.metadata.id} requires Nanasa ${descriptor.compatibility.minNanasaVersion} or newer`,
    );
  }
  if (
    descriptor.compatibility.maxNanasaVersion !== undefined &&
    compareSemanticVersions(productVersion, descriptor.compatibility.maxNanasaVersion) > 0
  ) {
    throw new ExtensionPackageError(
      "extension_incompatible",
      `${descriptor.metadata.id} supports Nanasa through ${descriptor.compatibility.maxNanasaVersion}`,
    );
  }
}

function parseOctal(field: Buffer, label: string): number {
  const source = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (source.length === 0) return 0;
  if (!/^[0-7]+$/.test(source)) {
    throw new ExtensionPackageError("extension_archive_invalid", `Invalid tar ${label}`);
  }
  const value = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(value)) {
    throw new ExtensionPackageError("extension_archive_invalid", `Tar ${label} is too large`);
  }
  return value;
}

function tarText(field: Buffer): string {
  return field.toString("utf8").replace(/\0.*$/s, "");
}

function safeArchivePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 240 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    isAbsolute(path)
  ) {
    throw new ExtensionPackageError("extension_path_unsafe", `Unsafe extension path: ${path}`);
  }
  const segments = path.split("/");
  if (
    segments.length > MAX_DEPTH ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ExtensionPackageError("extension_path_unsafe", `Unsafe extension path: ${path}`);
  }
  return segments.join("/");
}

function parseTar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const collisionKeys = new Set<string>();
  let totalBytes = 0;
  let offset = 0;
  while (offset + TAR_BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const expectedChecksum = parseOctal(header.subarray(148, 156), "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum) {
      throw new ExtensionPackageError("extension_archive_invalid", "Tar header checksum mismatch");
    }
    const prefix = tarText(header.subarray(345, 500));
    const name = tarText(header.subarray(0, 100));
    const path = safeArchivePath(prefix.length === 0 ? name : `${prefix}/${name}`);
    const type = String.fromCharCode(header[156] ?? 0);
    const size = parseOctal(header.subarray(124, 136), "file size");
    const dataOffset = offset + TAR_BLOCK;
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (dataOffset + padded > archive.length) {
      throw new ExtensionPackageError("extension_archive_invalid", `Truncated tar entry: ${path}`);
    }
    if (type === "5") {
      if (size !== 0) {
        throw new ExtensionPackageError(
          "extension_archive_invalid",
          `Directory has content: ${path}`,
        );
      }
    } else if (type === "\0" || type === "0") {
      if (size > MAX_FILE_BYTES || (path === MANIFEST_PATH && size > MAX_MANIFEST_BYTES)) {
        throw new ExtensionPackageError(
          "extension_file_limit",
          `Extension file exceeds its limit: ${path}`,
        );
      }
      const collisionKey = path.normalize("NFC").toLocaleLowerCase("en-US");
      if (collisionKeys.has(collisionKey)) {
        throw new ExtensionPackageError(
          "extension_path_collision",
          `Extension path collides: ${path}`,
        );
      }
      collisionKeys.add(collisionKey);
      files.set(path, Buffer.from(archive.subarray(dataOffset, dataOffset + size)));
      totalBytes += size;
      if (files.size > MAX_FILES || totalBytes > MAX_EXPANDED_BYTES) {
        throw new ExtensionPackageError(
          "extension_decompression_limit",
          "Extension package exceeds expanded limits",
        );
      }
    } else {
      const code = ["1", "2"].includes(type)
        ? "extension_link_forbidden"
        : "extension_device_forbidden";
      throw new ExtensionPackageError(
        code,
        `Tar entry type ${JSON.stringify(type)} is not allowed: ${path}`,
      );
    }
    offset = dataOffset + padded;
  }
  if (files.size === 0) {
    throw new ExtensionPackageError("extension_archive_invalid", "Extension archive is empty");
  }
  return files;
}

function strictYaml(source: string): unknown {
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    merge: false,
    customTags: [],
    resolveKnownTags: false,
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
  });
  if (document.errors.length > 0) {
    throw new ExtensionPackageError("extension_manifest_invalid", document.errors[0]!.message);
  }
  let nodeCount = 0;
  let problem: string | undefined;
  visit(document, {
    Node(_key, node, ancestry) {
      nodeCount += 1;
      if (nodeCount > MAX_YAML_NODES || ancestry.length > MAX_DEPTH * 2 + 2) {
        problem = "Extension manifest exceeds complexity limits";
        return visit.BREAK;
      }
      if (node.tag !== undefined && !node.tag.startsWith("tag:yaml.org,2002:")) {
        problem = `Custom YAML tag ${node.tag} is not allowed`;
        return visit.BREAK;
      }
      return undefined;
    },
    Alias() {
      problem = "YAML aliases and anchors are not allowed";
      return visit.BREAK;
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        problem = "YAML merge keys are not allowed";
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (problem !== undefined) throw new ExtensionPackageError("extension_manifest_invalid", problem);
  return document.toJS({ maxAliasCount: 0 });
}

function assertAssets(
  descriptor: ProviderExtensionDescriptor,
  files: ReadonlyMap<string, Buffer>,
): void {
  const declared = new Map(descriptor.assets.map((asset) => [asset.path, asset]));
  for (const [path, content] of files) {
    if (path === MANIFEST_PATH) continue;
    const asset = declared.get(path);
    if (asset === undefined) {
      throw new ExtensionPackageError(
        "extension_asset_undeclared",
        `Package contains undeclared asset: ${path}`,
      );
    }
    if (asset.bytes !== content.length || asset.sha256 !== sha256(content)) {
      throw new ExtensionPackageError(
        "extension_asset_digest_mismatch",
        `Asset digest or size mismatch: ${path}`,
      );
    }
  }
  for (const asset of descriptor.assets) {
    if (!files.has(asset.path)) {
      throw new ExtensionPackageError(
        "extension_asset_missing",
        `Declared asset is missing: ${asset.path}`,
      );
    }
  }
}

function assertPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new ExtensionPackageError(
      "extension_cache_unsafe",
      `Extension cache is not a regular directory: ${path}`,
    );
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new ExtensionPackageError(
      "extension_cache_unsafe",
      `Extension cache is not owned by the current user: ${path}`,
    );
  }
}

function writePackageTree(root: string, files: ReadonlyMap<string, Buffer>): void {
  assertPrivateDirectory(root);
  for (const [path, content] of files) {
    const destination = join(root, ...path.split("/"));
    const rel = relative(root, destination);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ExtensionPackageError(
        "extension_path_unsafe",
        `Extension path escaped cache: ${path}`,
      );
    }
    assertPrivateDirectory(dirname(destination));
    const descriptor = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(descriptor, content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

export class ExtensionPackageLoader {
  readonly #options: ExtensionPackageLoaderOptions;

  public constructor(options: ExtensionPackageLoaderOptions) {
    this.#options = options;
  }

  public loadArchive(
    input: Buffer,
    expectedDigest: string,
    signature?: ExtensionPackageSignature,
  ): LoadedExtensionPackage {
    if (input.length === 0 || input.length > MAX_ARCHIVE_BYTES) {
      throw new ExtensionPackageError(
        "extension_archive_limit",
        "Extension archive exceeds its compressed limit",
      );
    }
    const packageDigest = sha256(input);
    if (packageDigest !== expectedDigest) {
      throw new ExtensionPackageError(
        "extension_package_digest_mismatch",
        "Extension package digest does not match",
      );
    }
    const parsedSignature = ExtensionPackageSignatureSchema.parse(signature);
    const key = this.#options.trustKeys?.[parsedSignature.keyId];
    if (key === undefined) {
      throw new ExtensionPackageError(
        "extension_signature_untrusted",
        `Unknown extension signing key: ${parsedSignature.keyId}`,
      );
    }
    const signatureBytes = Buffer.from(parsedSignature.signature, "base64url");
    if (!verify(null, Buffer.from(packageDigest, "hex"), createPublicKey(key), signatureBytes)) {
      throw new ExtensionPackageError(
        "extension_signature_invalid",
        "Extension package signature is invalid",
      );
    }
    let expanded = input;
    if (input[0] === 0x1f && input[1] === 0x8b) {
      try {
        expanded = gunzipSync(input, { maxOutputLength: MAX_EXPANDED_BYTES });
      } catch {
        throw new ExtensionPackageError(
          "extension_decompression_limit",
          "Extension archive could not be safely decompressed",
        );
      }
    }
    if (expanded.length > MAX_EXPANDED_BYTES) {
      throw new ExtensionPackageError(
        "extension_decompression_limit",
        "Extension archive exceeds expanded limits",
      );
    }
    const files = parseTar(expanded);
    const manifest = files.get(MANIFEST_PATH);
    if (manifest === undefined) {
      throw new ExtensionPackageError("extension_manifest_missing", `${MANIFEST_PATH} is required`);
    }
    const parsed = ProviderExtensionDescriptorSchema.safeParse(
      strictYaml(manifest.toString("utf8")),
    );
    if (!parsed.success) {
      throw new ExtensionPackageError(
        "extension_manifest_invalid",
        parsed.error.issues[0]?.message ?? "Invalid extension manifest",
      );
    }
    assertCompatible(parsed.data, this.#options.productVersion);
    assertAssets(parsed.data, files);
    return Object.freeze({
      descriptor: parsed.data,
      descriptorDigest: descriptorDigest(parsed.data),
      packageDigest,
      files,
      signature: parsedSignature,
    });
  }

  public installImmutable(extension: LoadedExtensionPackage): string {
    const target = join(
      this.#options.packageRoot,
      extension.descriptor.metadata.id,
      extension.descriptor.metadata.version,
      extension.packageDigest,
    );
    assertPrivateDirectory(this.#options.packageRoot);
    assertPrivateDirectory(dirname(target));
    if (existsSync(target)) {
      const status = lstatSync(target);
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        realpathSync(target) !== resolve(target)
      ) {
        throw new ExtensionPackageError(
          "extension_cache_unsafe",
          "Immutable extension cache path is unsafe",
        );
      }
      const manifest = readFileSync(join(target, MANIFEST_PATH));
      if (
        descriptorDigest(
          ProviderExtensionDescriptorSchema.parse(strictYaml(manifest.toString("utf8"))),
        ) !== extension.descriptorDigest
      ) {
        throw new ExtensionPackageError(
          "extension_cache_corrupt",
          "Immutable extension cache is corrupt",
        );
      }
      return target;
    }
    const staging = `${target}.staging-${process.pid}-${Date.now()}`;
    try {
      writePackageTree(staging, extension.files);
      renameSync(staging, target);
      const parent = openSync(
        dirname(target),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
      return target;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
}
