import type { Checkout, GitStatusProjection } from "@nanasa/contracts";
import { GitCommandAdapter } from "./git-command-adapter.js";

export class GitStatusService {
  public constructor(private readonly git: GitCommandAdapter) {}

  public async inspect(checkout: Checkout): Promise<GitStatusProjection> {
    if (checkout.kind === "bare") {
      return {
        checkoutId: checkout.id,
        head: checkout.head,
        branch: checkout.branch,
        detached: checkout.branch === undefined,
        ahead: 0,
        behind: 0,
        staged: 0,
        modified: 0,
        untracked: 0,
        observedAt: new Date().toISOString(),
      };
    }
    const result = await this.git.run([
      "-C",
      checkout.path,
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=normal",
    ]);
    let head = checkout.head;
    let branch = checkout.branch;
    let ahead = 0;
    let behind = 0;
    let staged = 0;
    let modified = 0;
    let untracked = 0;
    for (const record of result.stdout.split("\0")) {
      if (record.startsWith("# branch.oid ")) {
        const oid = record.slice(13).trim();
        head = oid === "(initial)" ? undefined : oid;
      } else if (record.startsWith("# branch.head ")) {
        const value = record.slice(14).trim();
        branch = value === "(detached)" ? undefined : value;
      } else if (record.startsWith("# branch.ab ")) {
        const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
        if (match !== null) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      } else if (record.startsWith("? ")) {
        untracked += 1;
      } else if (/^[12u] /.test(record)) {
        const status = record.split(" ", 3)[1] ?? "..";
        if (status[0] !== ".") staged += 1;
        if (status[1] !== ".") modified += 1;
      }
    }
    return {
      checkoutId: checkout.id,
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
      detached: branch === undefined,
      ahead,
      behind,
      staged,
      modified,
      untracked,
      observedAt: new Date().toISOString(),
    };
  }
}
