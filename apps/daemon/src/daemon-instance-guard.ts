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
import { setTimeout as delay } from "node:timers/promises";

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

export interface DaemonStopOptions {
  timeoutMs?: number;
  expectedUid?: number;
  processIdentity?: (processId: number) => string | undefined;
  signalProcess?: (processId: number, signal: "SIGTERM") => void;
}

export class DaemonLeadershipError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DaemonLeadershipError";
  }
}

export function linuxProcessStartIdentityFromStat(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  if (fields[0] === "Z") return undefined;
  const startTicks = fields[19];
  return startTicks === undefined ? undefined : `linux-proc-start:${startTicks}`;
}

export function linuxProcessStartIdentity(processId: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
    return linuxProcessStartIdentityFromStat(stat);
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
    (parsed.processId ?? 0) <= 0 ||
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
          `Repository daemon ${existing.instanceId} already holds mutable authority. Run nanasa stop in this repository before starting another daemon`,
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

  public static async stop(
    repositoryRoot: string,
    runtimePath: string,
    options: DaemonStopOptions = {},
  ): Promise<{ state: "stopped" | "not-running"; instanceId?: string; text: string }> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new DaemonLeadershipError(
        "Stop timeout must be an integer from 1 to 300000 milliseconds",
      );
    }
    const notRunning = { state: "not-running" as const, text: "Repository daemon is not running" };
    const canonicalRepositoryRoot = realpathSync(repositoryRoot);
    const canonicalRuntimePath = resolve(runtimePath);
    const expectedUid = options.expectedUid ?? process.getuid?.();
    const lockPath = join(canonicalRuntimePath, "daemon.lock");
    let record: LockRecord;
    try {
      const directory = lstatSync(canonicalRuntimePath);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        realpathSync(canonicalRuntimePath) !== canonicalRuntimePath ||
        (expectedUid !== undefined && directory.uid !== expectedUid)
      ) {
        throw new DaemonLeadershipError(
          "The daemon runtime path is not an owner-controlled directory",
        );
      }
      const before = lstatSync(lockPath);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        (expectedUid !== undefined && before.uid !== expectedUid)
      ) {
        throw new DaemonLeadershipError(
          "The repository daemon lock is not an owner-only regular file",
        );
      }
      const descriptor = openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(descriptor);
        if (opened.dev !== before.dev || opened.ino !== before.ino) {
          throw new DaemonLeadershipError("The repository daemon lock changed while opening");
        }
        record = parseRecord(readFileSync(descriptor, "utf8"));
      } finally {
        closeSync(descriptor);
      }
      if (record.repositoryRoot !== canonicalRepositoryRoot) {
        throw new DaemonLeadershipError("The repository daemon lock belongs to another repository");
      }
      const after = lstatSync(lockPath);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.nlink !== 1 ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new DaemonLeadershipError("The repository daemon lock changed before shutdown");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return notRunning;
      throw error;
    }
    const processIdentity = options.processIdentity ?? linuxProcessStartIdentity;
    if (processIdentity(record.processId) !== record.processStartedAt) return notRunning;
    const signalProcess = options.signalProcess ?? process.kill.bind(process);
    try {
      signalProcess(record.processId, "SIGTERM");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return notRunning;
      throw error;
    }
    const deadline = Date.now() + timeoutMs;
    while (processIdentity(record.processId) === record.processStartedAt) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new DaemonLeadershipError(
          `Timed out waiting for daemon ${record.instanceId} to stop; no force kill was attempted`,
        );
      }
      await delay(Math.min(100, remaining));
    }
    return {
      state: "stopped",
      instanceId: record.instanceId,
      text: `Stopped repository daemon ${record.instanceId}`,
    };
  }
}
