import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ExtensionLockSchema,
  ExtensionTrustReceiptSchema,
  type ExtensionLock,
  type ExtensionTrustReceipt,
} from "@nanasa/contracts";
import { parseDocument, stringify } from "yaml";
import { ExtensionPackageError } from "./extension-package-loader.js";

const MAX_LOCK_BYTES = 2 * 1_024 * 1_024;
const MAX_TRUST_BYTES = 1 * 1_024 * 1_024;

function ensureOwnedDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new ExtensionPackageError(
      "extension_lock_unsafe",
      `Extension directory is unsafe: ${path}`,
    );
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new ExtensionPackageError(
      "extension_lock_unsafe",
      `Extension directory has a foreign owner: ${path}`,
    );
  }
}

function assertOwnedFile(path: string, maxBytes: number): void {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size > maxBytes) {
    throw new ExtensionPackageError(
      "extension_lock_unsafe",
      `Extension state file is unsafe: ${path}`,
    );
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new ExtensionPackageError(
      "extension_lock_unsafe",
      `Extension state file has a foreign owner: ${path}`,
    );
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomic(path: string, contents: string, mode: number): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode, flag: "wx" });
    const descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function emptyLock(): ExtensionLock {
  return { version: 1, revision: 0, extensions: {} };
}

export class ExtensionLockRepository {
  public readonly lockPath: string;
  public readonly trustPath: string;
  readonly #mutationLockPath: string;

  public constructor(repositoryRoot: string) {
    this.lockPath = join(repositoryRoot, ".nanasa", "extensions.lock.yaml");
    this.trustPath = join(repositoryRoot, ".nanasa", "state", "extensions", "trust.json");
    this.#mutationLockPath = join(repositoryRoot, ".nanasa", "runtime", "extensions.lock");
    ensureOwnedDirectory(dirname(this.lockPath));
    ensureOwnedDirectory(dirname(this.trustPath));
    ensureOwnedDirectory(dirname(this.#mutationLockPath));
  }

  public read(): ExtensionLock {
    if (!existsSync(this.lockPath)) return emptyLock();
    assertOwnedFile(this.lockPath, MAX_LOCK_BYTES);
    const source = readFileSync(this.lockPath, "utf8");
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
    if (document.errors.length > 0 || source.includes("&") || source.includes("*")) {
      throw new ExtensionPackageError(
        "extension_lock_invalid",
        "Extension lock is not strict YAML",
      );
    }
    const parsed = ExtensionLockSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    if (!parsed.success) {
      throw new ExtensionPackageError(
        "extension_lock_invalid",
        parsed.error.issues[0]?.message ?? "Extension lock is invalid",
      );
    }
    return parsed.data;
  }

  public mutate(
    expectedRevision: number,
    mutation: (current: ExtensionLock) => ExtensionLock,
  ): ExtensionLock {
    try {
      mkdirSync(this.#mutationLockPath, { mode: 0o700 });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new ExtensionPackageError(
          "extension_lock_busy",
          "Another extension operation is active",
        );
      }
      throw error;
    }
    try {
      const current = this.read();
      if (current.revision !== expectedRevision) {
        throw new ExtensionPackageError(
          "extension_lock_revision_stale",
          `Expected extension lock revision ${expectedRevision}, found ${current.revision}`,
        );
      }
      const candidate = ExtensionLockSchema.parse(mutation(structuredClone(current)));
      if (candidate.revision !== current.revision + 1) {
        throw new ExtensionPackageError(
          "extension_lock_revision_invalid",
          "Extension lock mutations must advance exactly one revision",
        );
      }
      writeAtomic(this.lockPath, stringify(candidate, { lineWidth: 100 }), 0o644);
      return candidate;
    } finally {
      rmSync(this.#mutationLockPath, { recursive: true, force: true });
    }
  }

  public initialize(mutation: (current: ExtensionLock) => ExtensionLock): ExtensionLock {
    const current = this.read();
    return mutation(structuredClone(current)).revision === current.revision
      ? current
      : this.mutate(current.revision, mutation);
  }

  public listTrust(): ExtensionTrustReceipt[] {
    if (!existsSync(this.trustPath)) return [];
    assertOwnedFile(this.trustPath, MAX_TRUST_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.trustPath, "utf8"));
    } catch {
      throw new ExtensionPackageError(
        "extension_trust_invalid",
        "Extension trust store is invalid",
      );
    }
    const parsed = ExtensionTrustReceiptSchema.array().max(1_024).safeParse(value);
    if (!parsed.success) {
      throw new ExtensionPackageError(
        "extension_trust_invalid",
        "Extension trust store is invalid",
      );
    }
    return parsed.data;
  }

  public findTrust(extensionId: string, planDigest: string): ExtensionTrustReceipt | undefined {
    return this.listTrust().find(
      (receipt) => receipt.extensionId === extensionId && receipt.planDigest === planDigest,
    );
  }

  public saveTrust(receipt: ExtensionTrustReceipt): ExtensionTrustReceipt {
    const parsed = ExtensionTrustReceiptSchema.parse(receipt);
    const receipts = this.listTrust().filter(
      (item) => item.extensionId !== parsed.extensionId || item.version !== parsed.version,
    );
    receipts.push(parsed);
    receipts.sort((left, right) => left.extensionId.localeCompare(right.extensionId));
    writeAtomic(this.trustPath, `${JSON.stringify(receipts, null, 2)}\n`, 0o600);
    return parsed;
  }

  public removeTrust(extensionId: string): void {
    const receipts = this.listTrust().filter((receipt) => receipt.extensionId !== extensionId);
    writeAtomic(this.trustPath, `${JSON.stringify(receipts, null, 2)}\n`, 0o600);
  }
}
