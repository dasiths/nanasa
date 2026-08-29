import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonInstanceGuard } from "../src/daemon-instance-guard.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DaemonInstanceGuard", () => {
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
});
