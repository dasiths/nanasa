import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

interface LockRecord {
  version: 1;
  instanceId: string;
  processId: number;
  processStartedAt: string;
  repositoryRoot: string;
  acquiredAt: string;
}

export interface DaemonInstanceGuardOptions {
  instanceId?: string;
  processId?: number;
  processStartedAt?: string;
  expectedUid?: number;
  processIdentity?: (processId: number) => string | undefined;
}

export class DaemonLeadershipError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DaemonLeadershipError";
  }
}

export function linuxProcessStartIdentity(processId: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    return startTicks === undefined ? undefined : `linux-proc-start:${startTicks}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseRecord(value: string): LockRecord {
  const parsed = JSON.parse(value) as Partial<LockRecord>;
  if (
    parsed.version !== 1 ||
    typeof parsed.instanceId !== "string" ||
    !Number.isInteger(parsed.processId) ||
    typeof parsed.processStartedAt !== "string" ||
    typeof parsed.repositoryRoot !== "string" ||
    typeof parsed.acquiredAt !== "string"
  ) {
    throw new DaemonLeadershipError("The repository daemon lock is malformed; refusing takeover");
  }
  return parsed as LockRecord;
}

export class DaemonInstanceGuard {
  public readonly instanceId: string;
  public readonly processId: number;
  public readonly processStartedAt: string;
  public readonly lockPath: string;
  readonly #descriptor: number;
  readonly #device: number;
  readonly #inode: number;
  #released = false;

  private constructor(
    lockPath: string,
    record: LockRecord,
    descriptor: number,
    device: number,
    inode: number,
  ) {
    this.lockPath = lockPath;
    this.instanceId = record.instanceId;
    this.processId = record.processId;
    this.processStartedAt = record.processStartedAt;
    this.#descriptor = descriptor;
    this.#device = device;
    this.#inode = inode;
  }

  public static acquire(
    repositoryRoot: string,
    runtimePath: string,
    options: DaemonInstanceGuardOptions = {},
  ): DaemonInstanceGuard {
    const canonicalRepositoryRoot = realpathSync(repositoryRoot);
    const canonicalRuntimePath = resolve(runtimePath);
    mkdirSync(canonicalRuntimePath, { recursive: true, mode: 0o700 });
    const directory = lstatSync(canonicalRuntimePath);
    const expectedUid = options.expectedUid ?? process.getuid?.();
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new DaemonLeadershipError("The daemon runtime path must be a regular directory");
    }
    if (expectedUid !== undefined && directory.uid !== expectedUid) {
      throw new DaemonLeadershipError("The daemon runtime path must be owned by the current user");
    }
    if (realpathSync(canonicalRuntimePath) !== canonicalRuntimePath) {
      throw new DaemonLeadershipError("The daemon runtime path must not traverse symlinks");
    }
    chmodSync(canonicalRuntimePath, 0o700);

    const processId = options.processId ?? process.pid;
    const processIdentity = options.processIdentity ?? linuxProcessStartIdentity;
    const processStartedAt = options.processStartedAt ?? processIdentity(processId);
    if (processStartedAt === undefined) {
      throw new DaemonLeadershipError("Unable to establish the daemon process start identity");
    }
    const record: LockRecord = {
      version: 1,
      instanceId: options.instanceId ?? `daemon_${randomUUID()}`,
      processId,
      processStartedAt,
      repositoryRoot: canonicalRepositoryRoot,
      acquiredAt: new Date().toISOString(),
    };
    const lockPath = join(canonicalRuntimePath, "daemon.lock");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
          fchmodSync(descriptor, 0o600);
          fsyncSync(descriptor);
          const metadata = fstatSync(descriptor);
          return new DaemonInstanceGuard(lockPath, record, descriptor, metadata.dev, metadata.ino);
        } catch (error) {
          closeSync(descriptor);
          unlinkSync(lockPath);
          throw error;
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }

      const before = lstatSync(lockPath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new DaemonLeadershipError(
          "The repository daemon lock has unsafe filesystem identity",
        );
      }
      if (expectedUid !== undefined && before.uid !== expectedUid) {
        throw new DaemonLeadershipError("The repository daemon lock is not owner-controlled");
      }
      if ((before.mode & 0o777) !== 0o600) {
        throw new DaemonLeadershipError("The repository daemon lock permissions must be 0600");
      }
      const existing = parseRecord(readFileSync(lockPath, "utf8"));
      if (existing.repositoryRoot !== canonicalRepositoryRoot) {
        throw new DaemonLeadershipError("The repository daemon lock belongs to another repository");
      }
      let currentIdentity: string | undefined;
      try {
        currentIdentity = processIdentity(existing.processId);
      } catch {
        throw new DaemonLeadershipError(
          "The existing daemon process cannot be inspected; refusing concurrent authority",
        );
      }
      if (currentIdentity === existing.processStartedAt) {
        throw new DaemonLeadershipError(
          `Repository daemon ${existing.instanceId} already holds mutable authority`,
        );
      }
      const after = lstatSync(lockPath);
      if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
        throw new DaemonLeadershipError("The repository daemon lock changed during takeover");
      }
      unlinkSync(lockPath);
    }
    throw new DaemonLeadershipError("Unable to acquire repository daemon authority");
  }

  public release(): void {
    if (this.#released) return;
    this.#released = true;
    try {
      const metadata = lstatSync(this.lockPath);
      if (metadata.dev === this.#device && metadata.ino === this.#inode && metadata.nlink === 1) {
        const record = parseRecord(readFileSync(this.lockPath, "utf8"));
        if (record.instanceId === this.instanceId) unlinkSync(this.lockPath);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    } finally {
      closeSync(this.#descriptor);
    }
  }
}
