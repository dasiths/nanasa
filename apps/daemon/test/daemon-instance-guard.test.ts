import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("stops only the recorded process and waits for its exit", async () => {
    const repository = mkdtempSync(join(tmpdir(), "nanasa-stop-"));
    temporaryDirectories.push(repository);
    const runtime = join(repository, ".nanasa", "runtime");
    const guard = DaemonInstanceGuard.acquire(repository, runtime, {
      processId: 101,
      processStartedAt: "original-start",
    });
    let identity: string | undefined = "original-start";
    const signalProcess = vi.fn(() => {
      guard.release();
      identity = undefined;
    });
    expect(
      await DaemonInstanceGuard.stop(repository, runtime, {
        processIdentity: () => identity,
        signalProcess,
      }),
    ).toMatchObject({ state: "stopped", instanceId: guard.instanceId });
    expect(signalProcess).toHaveBeenCalledExactlyOnceWith(101, "SIGTERM");
    expect(existsSync(guard.lockPath)).toBe(false);
  });

  it.each([undefined, "reused-pid-start"])(
    "does not signal a stale owner (%s)",
    async (identity) => {
      const repository = mkdtempSync(join(tmpdir(), "nanasa-stop-stale-"));
      temporaryDirectories.push(repository);
      const runtime = join(repository, ".nanasa", "runtime");
      const signalProcess = vi.fn();
      expect(await DaemonInstanceGuard.stop(repository, runtime, { signalProcess })).toMatchObject({
        state: "not-running",
      });
      const guard = DaemonInstanceGuard.acquire(repository, runtime, {
        processId: 101,
        processStartedAt: "original-start",
      });
      try {
        expect(
          await DaemonInstanceGuard.stop(repository, runtime, {
            processIdentity: () => identity,
            signalProcess,
          }),
        ).toMatchObject({ state: "not-running" });
        expect(signalProcess).not.toHaveBeenCalled();
        expect(existsSync(guard.lockPath)).toBe(true);
      } finally {
        guard.release();
      }
    },
  );

  it("refuses unsafe locks and process group IDs", async () => {
    const repository = mkdtempSync(join(tmpdir(), "nanasa-stop-unsafe-"));
    temporaryDirectories.push(repository);
    const runtime = join(repository, ".nanasa", "runtime");
    const guard = DaemonInstanceGuard.acquire(repository, runtime);
    const original = readFileSync(guard.lockPath, "utf8");
    const signalProcess = vi.fn();
    try {
      chmodSync(guard.lockPath, 0o644);
      await expect(
        DaemonInstanceGuard.stop(repository, runtime, { signalProcess }),
      ).rejects.toThrow("owner-only");
      chmodSync(guard.lockPath, 0o600);
      for (const processId of [0, -1]) {
        writeFileSync(guard.lockPath, JSON.stringify({ ...JSON.parse(original), processId }));
        await expect(
          DaemonInstanceGuard.stop(repository, runtime, { signalProcess }),
        ).rejects.toThrow("malformed");
      }
      writeFileSync(
        guard.lockPath,
        JSON.stringify({ ...JSON.parse(original), repositoryRoot: "/other-repository" }),
      );
      await expect(
        DaemonInstanceGuard.stop(repository, runtime, { signalProcess }),
      ).rejects.toThrow("another repository");
      expect(signalProcess).not.toHaveBeenCalled();
    } finally {
      writeFileSync(guard.lockPath, original);
      guard.release();
    }
  });

  it("times out without escalating or removing the live lock", async () => {
    const repository = mkdtempSync(join(tmpdir(), "nanasa-stop-timeout-"));
    temporaryDirectories.push(repository);
    const runtime = join(repository, ".nanasa", "runtime");
    const guard = DaemonInstanceGuard.acquire(repository, runtime, {
      processId: 101,
      processStartedAt: "original-start",
    });
    const signalProcess = vi.fn();
    try {
      await expect(
        DaemonInstanceGuard.stop(repository, runtime, {
          timeoutMs: 1,
          processIdentity: () => "original-start",
          signalProcess,
        }),
      ).rejects.toThrow("no force kill");
      expect(signalProcess).toHaveBeenCalledExactlyOnceWith(101, "SIGTERM");
      expect(existsSync(guard.lockPath)).toBe(true);
    } finally {
      guard.release();
    }
  });

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
