import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  uid?: bigint;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function validatedBasename(value: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value !== basename(value) ||
    value.includes(sep) ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("Anchored file name must be a validated basename");
  }
  return value;
}

export interface AnchoredDirectoryHandle {
  createExclusive<T>(name: string, contents: string | Buffer, persist: () => T, mode?: number): T;
  readFile(name: string): Buffer;
  deleteVerified(
    name: string,
    expected: { storageReference: string; contentDigest: string; mode?: number },
    metadata: { delete: () => boolean; reconcile: () => boolean },
  ): void;
}

interface AnchoredDirectoryHooks {
  afterFinalValidation?: (name: string) => void;
  afterQuarantineMove?: (name: string, moved: boolean) => void;
}

/** Linux-only, descriptor-relative file access for a closed set of owner-controlled files. */
export class AnchoredDirectory {
  readonly #path: string;
  readonly #identity: DirectoryIdentity;

  public constructor(
    path: string,
    private readonly requiredMode = 0o700,
    private readonly hooks: AnchoredDirectoryHooks = {},
  ) {
    if (
      process.platform !== "linux" ||
      constants.O_DIRECTORY === undefined ||
      constants.O_NOFOLLOW === undefined
    ) {
      throw new Error("Descriptor-anchored file access requires Linux openat-compatible procfs");
    }
    this.#path = resolve(path);
    const descriptor = this.#openDirectory();
    try {
      this.#identity = this.#directoryIdentity(descriptor);
      this.#assertProcDescriptor(descriptor, this.#identity);
    } finally {
      closeSync(descriptor);
    }
  }

  public basenameFor(reference: string): string {
    const path = resolve(reference);
    if (dirname(path) !== this.#path || !isAbsolute(path)) {
      throw new Error("Anchored file reference escaped its directory");
    }
    return validatedBasename(basename(path));
  }

  public reference(name: string): string {
    return join(this.#path, validatedBasename(name));
  }

  public withHandle<T>(operation: (handle: AnchoredDirectoryHandle) => T): T {
    const directoryDescriptor = this.#openDirectory();
    let before: DirectoryIdentity | undefined;
    try {
      before = this.#directoryIdentity(directoryDescriptor);
      if (!sameIdentity(before, this.#identity)) {
        throw new Error("Anchored directory identity changed");
      }
      this.#assertProcDescriptor(directoryDescriptor, before);
      const childPath = (name: string) =>
        `/proc/self/fd/${directoryDescriptor}/${validatedBasename(name)}`;
      const handle: AnchoredDirectoryHandle = {
        createExclusive: (name, contents, persist, mode = 0o600) => {
          const descriptor = openSync(
            childPath(name),
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            mode,
          );
          try {
            const opened = this.#regularFileIdentity(descriptor, mode);
            writeFileSync(descriptor, contents);
            fsyncSync(descriptor);
            try {
              return persist();
            } catch (error) {
              try {
                this.#destroyOpenFile(descriptor, opened);
              } catch (destructionError) {
                throw new AggregateError(
                  [error, destructionError],
                  "Checkpoint persistence failed and its verified content could not be destroyed",
                  { cause: destructionError },
                );
              }
              throw error;
            }
          } finally {
            closeSync(descriptor);
          }
        },
        readFile: (name) => {
          const descriptor = openSync(childPath(name), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            this.#assertRegularFile(descriptor, 0o600);
            return readFileSync(descriptor);
          } finally {
            closeSync(descriptor);
          }
        },
        deleteVerified: (name, expected, metadata) => {
          const validatedName = validatedBasename(name);
          if (expected.storageReference !== this.reference(validatedName)) {
            throw new Error("Anchored file storage reference does not match its exact basename");
          }
          if (!/^[0-9a-f]{64}$/.test(expected.contentDigest)) {
            throw new Error("Anchored file content digest is invalid");
          }
          const requiredMode = expected.mode ?? 0o600;
          const path = childPath(validatedName);
          const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
          try {
            const opened = this.#regularFileIdentity(descriptor, requiredMode);
            const digest = createHash("sha256").update(readFileSync(descriptor)).digest("hex");
            if (digest !== expected.contentDigest) {
              throw new Error("Anchored file content identity does not match persistence");
            }

            const named = lstatSync(path, { bigint: true });
            this.#assertNamedFileIdentity(named, opened, requiredMode);
            this.hooks.afterFinalValidation?.(validatedName);

            const quarantineName = this.#unusedQuarantineName(childPath);
            const quarantinePath = childPath(quarantineName);
            let moved = false;
            try {
              renameSync(path, quarantinePath);
              moved = true;
            } catch {
              // Quarantine is organizational only. Destruction is bound exclusively to the open fd.
            }
            this.hooks.afterQuarantineMove?.(quarantineName, moved);

            this.#destroyOpenFile(descriptor, opened);
            let deletionError: unknown;
            try {
              if (metadata.delete()) return;
              deletionError = new Error(
                "Checkpoint persistence changed after verified content destruction",
              );
            } catch (error) {
              deletionError = error;
            }
            try {
              if (metadata.reconcile()) return;
              throw new Error("Destroyed checkpoint metadata could not be marked deleted");
            } catch (reconciliationError) {
              throw new AggregateError(
                [deletionError, reconciliationError],
                "Checkpoint content was destroyed through its verified descriptor, but metadata reconciliation failed",
                { cause: reconciliationError },
              );
            }
          } finally {
            closeSync(descriptor);
          }
        },
      };
      let result: T | undefined;
      let operationError: unknown;
      try {
        result = operation(handle);
      } catch (error) {
        operationError = error;
      }
      if (!sameIdentity(this.#directoryIdentity(directoryDescriptor), before)) {
        throw new Error("Anchored directory descriptor identity changed during operation");
      }
      if (operationError !== undefined) throw operationError;
      return result as T;
    } finally {
      closeSync(directoryDescriptor);
    }
  }

  #openDirectory(): number {
    try {
      return openSync(
        this.#path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch {
      throw new Error("Anchored directory must be an openable non-symlink directory");
    }
  }

  #directoryIdentity(descriptor: number): DirectoryIdentity {
    const metadata = fstatSync(descriptor, { bigint: true });
    const expectedUid = process.getuid?.();
    if (
      !metadata.isDirectory() ||
      (metadata.mode & 0o777n) !== BigInt(this.requiredMode) ||
      (expectedUid !== undefined && metadata.uid !== BigInt(expectedUid))
    ) {
      throw new Error("Anchored directory must be an owner-controlled directory");
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      ...(expectedUid === undefined ? {} : { uid: BigInt(expectedUid) }),
    };
  }

  #assertProcDescriptor(descriptor: number, expected: DirectoryIdentity): void {
    let metadata;
    try {
      metadata = statSync(`/proc/self/fd/${descriptor}`, { bigint: true });
    } catch {
      throw new Error("Descriptor-anchored file access requires mounted Linux procfs");
    }
    const actual: DirectoryIdentity = {
      dev: metadata.dev,
      ino: metadata.ino,
      ...(expected.uid === undefined ? {} : { uid: metadata.uid }),
    };
    if (!metadata.isDirectory() || !sameIdentity(actual, expected)) {
      throw new Error("Linux procfs directory descriptor identity mismatch");
    }
  }

  #assertRegularFile(descriptor: number, requiredMode: number): void {
    this.#regularFileIdentity(descriptor, requiredMode);
  }

  #regularFileIdentity(descriptor: number, requiredMode: number): FileIdentity {
    const metadata = fstatSync(descriptor, { bigint: true });
    const expectedUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1n ||
      (metadata.mode & 0o777n) !== BigInt(requiredMode) ||
      (expectedUid !== undefined && metadata.uid !== BigInt(expectedUid))
    ) {
      throw new Error("Anchored file must be an owner-only regular file");
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
      nlink: metadata.nlink,
    };
  }

  #assertNamedFileIdentity(
    metadata: BigIntStats,
    expected: FileIdentity,
    requiredMode: number,
  ): void {
    if (
      !metadata.isFile() ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino ||
      metadata.uid !== expected.uid ||
      metadata.mode !== expected.mode ||
      metadata.nlink !== expected.nlink ||
      (metadata.mode & 0o777n) !== BigInt(requiredMode)
    ) {
      throw new Error("Anchored file basename was substituted before quarantine");
    }
  }

  #unusedQuarantineName(childPath: (name: string) => string): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const name = validatedBasename(`.nanasa-quarantine-${randomUUID()}`);
      try {
        lstatSync(childPath(name));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return name;
        throw error;
      }
    }
    throw new Error("Unable to allocate a unique anchored quarantine basename");
  }

  #destroyOpenFile(descriptor: number, expected: FileIdentity): void {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.uid !== expected.uid
    ) {
      throw new Error("Verified checkpoint descriptor identity changed before destruction");
    }
    ftruncateSync(descriptor, 0);
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !after.isFile() ||
      after.dev !== expected.dev ||
      after.ino !== expected.ino ||
      after.uid !== expected.uid ||
      after.size !== 0n
    ) {
      throw new Error("Verified checkpoint descriptor destruction could not be confirmed");
    }
  }
}
