import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DaemonInstanceGuard,
  linuxProcessStartIdentityFromStat,
} from "../src/daemon-instance-guard.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DaemonInstanceGuard", () => {
  it("treats Linux zombie process records as dead", () => {
    const fields = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "4242"];
    const active = `101 (node worker) ${fields.join(" ")}`;
    const zombie = active.replace(") S ", ") Z ");

    expect(linuxProcessStartIdentityFromStat(active)).toBe("linux-proc-start:4242");
    expect(linuxProcessStartIdentityFromStat(zombie)).toBeUndefined();
  });

  it("excludes simultaneous repository leaders before mutable services open", () => {
    const repository = mkdtempSync(join(tmpdir(), "nanasa-leader-"));
    temporaryDirectories.push(repository);
    mkdirSync(join(repository, ".git"));
    const runtime = join(repository, ".nanasa", "runtime");
    const processIdentity = () => "fixture-process-start";
    const first = DaemonInstanceGuard.acquire(repository, runtime, {
      instanceId: "daemon-first",
      processId: 101,
      processStartedAt: "fixture-process-start",
      processIdentity,
    });
    try {
      expect(() =>
        DaemonInstanceGuard.acquire(repository, runtime, {
          instanceId: "daemon-second",
          processId: 102,
          processStartedAt: "fixture-process-start-2",
          processIdentity,
        }),
      ).toThrow("already holds mutable authority");
    } finally {
      first.release();
    }
    const replacement = DaemonInstanceGuard.acquire(repository, runtime, {
      instanceId: "daemon-second",
      processId: 102,
      processStartedAt: "fixture-process-start-2",
      processIdentity: () => undefined,
    });
    replacement.release();
  });

  it("replaces a lock whose recorded owner no longer has a live identity", () => {
    const repository = mkdtempSync(join(tmpdir(), "nanasa-zombie-leader-"));
    temporaryDirectories.push(repository);
    mkdirSync(join(repository, ".git"));
    const runtime = join(repository, ".nanasa", "runtime");
    const first = DaemonInstanceGuard.acquire(repository, runtime, {
      instanceId: "daemon-zombie",
      processId: 101,
      processStartedAt: "fixture-zombie-start",
      processIdentity: () => "fixture-zombie-start",
    });
    const replacement = DaemonInstanceGuard.acquire(repository, runtime, {
      instanceId: "daemon-replacement",
      processId: 102,
      processStartedAt: "fixture-replacement-start",
      processIdentity: (processId) => (processId === 101 ? undefined : "fixture-replacement-start"),
    });
    try {
      expect(replacement.instanceId).toBe("daemon-replacement");
    } finally {
      first.release();
      replacement.release();
    }
  });
});
