import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function linuxStartTime(pid) {
  if (process.platform !== "linux") return undefined;
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
    return fields[21];
  } catch {
    return undefined;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ProcessHarness {
  constructor(name, options = {}) {
    this.runId = randomUUID();
    this.root = resolve(options.root ?? join(tmpdir(), `nanasa-harness-${name}-${this.runId}`));
    this.manifestPath = join(this.root, "ownership.json");
    this.records = [];
    this.resources = {
      sockets: [],
      tmuxServers: [],
      attachmentHelpers: [],
      databases: [],
      temporaryDirectories: [this.root],
    };
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.#write();
  }

  ownProcess(child, executable, argv) {
    if (child.pid === undefined) throw new Error("Cannot own a process before spawn");
    const record = {
      pid: child.pid,
      executable: resolve(executable),
      argv: [...argv],
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      startTime: linuxStartTime(child.pid),
    };
    this.records.push(record);
    this.#write();
    child.once("exit", () => {
      this.records = this.records.filter((candidate) => candidate.pid !== record.pid);
      this.#write();
    });
    return record;
  }

  register(kind, value) {
    if (!(kind in this.resources)) throw new Error(`Unknown harness resource: ${kind}`);
    this.resources[kind].push(value);
    this.#write();
  }

  startWatchdog() {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "process-watchdog.mjs"), this.manifestPath],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    return child.pid;
  }

  verifyOwnedProcess(record) {
    if (!processExists(record.pid)) return false;
    if (process.platform !== "linux") return true;
    const startTime = linuxStartTime(record.pid);
    if (startTime !== record.startTime) return false;
    try {
      const command = readFileSync(`/proc/${record.pid}/cmdline`)
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      const executable = command[0];
      return (
        executable !== undefined &&
        (executable === record.executable || resolve(executable) === record.executable) &&
        JSON.stringify(command.slice(1)) === JSON.stringify(record.argv)
      );
    } catch {
      return false;
    }
  }

  terminateOwned() {
    for (const record of this.records) {
      if (this.verifyOwnedProcess(record)) process.kill(record.pid, "SIGTERM");
    }
  }

  assertNoOrphans() {
    const orphans = this.records.filter((record) => this.verifyOwnedProcess(record));
    if (orphans.length > 0)
      throw new Error(`Owned processes remain: ${orphans.map((item) => item.pid).join(", ")}`);
  }

  close() {
    this.assertNoOrphans();
    rmSync(this.root, { recursive: true, force: true });
  }

  #write() {
    const manifest = {
      version: 1,
      runId: this.runId,
      ownerPid: process.pid,
      ownerStartTime: linuxStartTime(process.pid),
      nonceDigest: createHash("sha256").update(this.runId).digest("hex"),
      processes: this.records,
      resources: this.resources,
    };
    const temporary = `${this.manifestPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.manifestPath);
  }
}
