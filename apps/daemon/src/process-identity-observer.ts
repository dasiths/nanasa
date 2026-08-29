import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProcessIdentityObservation } from "@nanasa/contracts";
import type { ProviderAdapter } from "./providers/provider-adapter.js";

const MAX_GROUP_MEMBERS = 64;

interface ProcStat {
  pid: number;
  processGroup: number;
  foregroundProcessGroup: number;
  startIdentity: string;
}

export interface ProcessIdentityObserverOptions {
  procRoot?: string;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseProcStat(value: string): ProcStat {
  const close = value.lastIndexOf(")");
  const pid = Number.parseInt(value.slice(0, value.indexOf(" ")), 10);
  const fields = value
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const processGroup = Number.parseInt(fields[2] ?? "", 10);
  const foregroundProcessGroup = Number.parseInt(fields[5] ?? "", 10);
  const startIdentity = fields[19] ?? "";
  if (
    close < 0 ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(processGroup) ||
    processGroup <= 0 ||
    startIdentity.length === 0
  ) {
    throw new Error("process_stat_malformed");
  }
  return { pid, processGroup, foregroundProcessGroup, startIdentity };
}

export class ProcessIdentityObserver {
  readonly #procRoot: string;

  public constructor(options: ProcessIdentityObserverOptions = {}) {
    this.#procRoot = options.procRoot ?? "/proc";
  }

  public async observe(
    panePid: number,
    adapter: ProviderAdapter,
  ): Promise<ProcessIdentityObservation> {
    const pane = await this.#readStat(panePid);
    const foregroundPgid =
      pane.foregroundProcessGroup > 0 ? pane.foregroundProcessGroup : pane.processGroup;
    const candidates = [foregroundPgid, panePid];
    const seen = new Set<number>();
    const group: ProcStat[] = [];
    while (candidates.length > 0 && seen.size < MAX_GROUP_MEMBERS) {
      const pid = candidates.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      try {
        const stat = await this.#readStat(pid);
        if (stat.processGroup === foregroundPgid) group.push(stat);
        const children = await readFile(
          join(this.#procRoot, String(pid), "task", String(pid), "children"),
          "utf8",
        );
        candidates.push(
          ...children
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number)
            .filter((child) => Number.isSafeInteger(child) && child > 0),
        );
      } catch {
        // Processes can exit between bounded /proc reads. Polling will recover.
      }
    }
    const members = (
      await Promise.all(
        group.map(async (stat) => {
          try {
            const [argv, executable] = await Promise.all([
              this.#readArgv(stat.pid),
              this.#readExecutable(stat.pid),
            ]);
            return { stat, argv, executable };
          } catch {
            return undefined;
          }
        }),
      )
    ).filter(
      (member): member is { stat: ProcStat; argv: string[]; executable: string } =>
        member !== undefined,
    );
    if (members.length === 0) throw new Error("foreground_process_group_missing");
    const recognized = members.find((member) => adapter.recognizeCommand(member.argv));
    const leader =
      recognized ?? members.find((member) => member.stat.pid === foregroundPgid) ?? members[0]!;
    const wrapperChain = members.map((member) =>
      basename(member.executable || member.argv[0] || "unknown"),
    );
    const executableFingerprint = fingerprint(leader.executable);
    const argvFingerprint = fingerprint(leader.argv.join("\0"));
    return {
      foregroundPgid,
      leaderPid: leader.stat.pid,
      pidStartIdentity: `${leader.stat.pid}:${leader.stat.startIdentity}`,
      executableFingerprint,
      argvFingerprint,
      processFingerprint: fingerprint(
        `${foregroundPgid}\0${leader.stat.pid}\0${leader.stat.startIdentity}\0${executableFingerprint}\0${argvFingerprint}`,
      ),
      expectedProviderMatch: recognized === undefined ? "mismatch" : "match",
      wrapperChain,
    };
  }

  async #readStat(pid: number): Promise<ProcStat> {
    return parseProcStat(await readFile(join(this.#procRoot, String(pid), "stat"), "utf8"));
  }

  async #readArgv(pid: number): Promise<string[]> {
    const value = await readFile(join(this.#procRoot, String(pid), "cmdline"));
    return value.toString("utf8").split("\0").filter(Boolean).slice(0, 64);
  }

  async #readExecutable(pid: number): Promise<string> {
    try {
      return await readlink(join(this.#procRoot, String(pid), "exe"));
    } catch {
      const argv = await this.#readArgv(pid);
      return argv[0] ?? "unknown";
    }
  }
}
