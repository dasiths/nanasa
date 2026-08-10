import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRun } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NanasaStore } from "../src/store.js";
import {
  TerminalEndpointRegistry,
  terminalBasePath,
  terminalBindingFingerprint,
  terminalEndpointKey,
} from "../src/terminal-endpoint-registry.js";
import {
  matchesExpectedTtydArgv,
  matchesManifestProcess,
  TtydManifestStore,
  type TtydProcessIdentity,
  type TtydProcessManifest,
} from "../src/ttyd-manifest.js";
import { buildTtydArguments, TtydSupervisor, ttydViewSessionName } from "../src/ttyd-supervisor.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identity(argv: string[]): TtydProcessIdentity {
  return {
    startTimeTicks: "998877",
    executablePath: "/usr/bin/ttyd",
    executableDevice: "2049",
    executableInode: "12345",
    uid: process.getuid?.() ?? 1000,
    argv,
  };
}

function manifest(run: AgentRun, pid = 4242): TtydProcessManifest {
  const endpointKey = terminalEndpointKey(run.id);
  const ttydArgv = [
    "/usr/bin/ttyd",
    ...buildTtydArguments(
      {
        runId: run.id,
        serverName: run.terminal!.serverName,
        viewSessionName: ttydViewSessionName(run.id),
        endpointKey,
        basePath: terminalBasePath(endpointKey),
      },
      "/usr/bin/tmux",
    ),
  ];
  return {
    version: 1,
    runId: run.id,
    runGeneration: run.generation,
    endpointKey,
    basePath: terminalBasePath(endpointKey),
    pid,
    process: identity(ttydArgv),
    ttydArgv,
    tmux: {
      serverName: run.terminal!.serverName,
      viewSessionName: ttydViewSessionName(run.id),
      bindingFingerprint: terminalBindingFingerprint(run.terminal!),
    },
    createdAt: "2026-08-10T12:00:00.000Z",
  };
}

function runningRun(store: NanasaStore): AgentRun {
  const group = store.createGroup({ name: "Manifest" });
  const profile = store.createInternalAgentProfile({
    name: "Terminal",
    agentType: "opencode",
    kind: "opencode",
    adapter: "terminal",
    capabilities: ["queue"],
    command: "opencode",
    args: [],
    environment: {},
  });
  store.addMembership(group.id, {
    memberId: "alpha",
    agentProfileId: profile.id,
    alias: "Alpha",
  });
  const { run } = store.createRunForMembership(group.id, "alpha");
  return store.updateRunStatus(run.id, "running", {
    terminal: {
      serverName: "nanasa-test",
      sessionId: "$1",
      windowId: "@2",
      paneId: "%3",
    },
  });
}

describe("ttyd manifest security", () => {
  it("atomically serializes a private manifest and validates exact process identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-ttyd-manifest-"));
    temporaryDirectories.push(directory);
    const store = new NanasaStore(":memory:");
    const run = runningRun(store);
    const manifests = new TtydManifestStore(join(directory, "ttyd"));
    const expected = manifest(run);

    await manifests.write(expected);

    const path = manifests.pathForRun(run.id);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(expected);
    expect(await manifests.scan()).toMatchObject([{ manifest: expected }]);
    expect(matchesManifestProcess(expected, expected.process)).toBe(true);
    expect(
      matchesManifestProcess(expected, { ...expected.process, startTimeTicks: "998878" }),
    ).toBe(false);
    expect(
      matchesExpectedTtydArgv(
        ["ttyd", "--client-option", "rendererType=canvas"],
        ["ttyd", "--client-option", "rendererType", "canvas"],
      ),
    ).toBe(true);
    expect(
      matchesExpectedTtydArgv(
        ["ttyd", "--base-path", "/expected"],
        ["ttyd", "--base-path", "/other"],
      ),
    ).toBe(false);
    store.close();
  });

  it("rejects corrupt, wrong-mode, and symlink manifests without following them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-ttyd-reject-"));
    temporaryDirectories.push(directory);
    const manifests = new TtydManifestStore(join(directory, "ttyd"));
    await manifests.write({
      ...manifest({
        id: "run-valid",
        groupId: "group",
        memberId: "member",
        agentProfileId: "profile",
        generation: 1,
        status: "running",
        desiredState: "running",
        recoveryPhase: "idle",
        recoveryAttempts: 0,
        terminal: { serverName: "test", sessionId: "$1", windowId: "@1", paneId: "%1" },
        startedAt: "2026-08-10T12:00:00.000Z",
      }),
      runId: "run-valid",
    });
    const validPath = manifests.pathForRun("run-valid");
    chmodSync(validPath, 0o644);
    symlinkSync(validPath, join(dirname(validPath), "c3ltbGluaw.json"));
    writeFileSync(join(dirname(validPath), "Y29ycnVwdA.json"), "{", { mode: 0o600 });
    writeFileSync(join(dirname(validPath), "b3ZlcnNpemVk.json"), "x".repeat(65 * 1024), {
      mode: 0o600,
    });

    const entries = await manifests.scan();

    expect(entries.map((entry) => entry.rejectionReason).sort()).toEqual([
      "manifest_oversized",
      "manifest_symlink",
      "manifest_unreadable",
      "manifest_wrong_mode",
    ]);
  });

  it("signals only exact validated stale processes and discards PID reuse without signaling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-ttyd-cleanup-"));
    temporaryDirectories.push(directory);
    const database = new NanasaStore(":memory:");
    const run = runningRun(database);
    const registry = new TerminalEndpointRegistry(database);
    const manifests = new TtydManifestStore(join(directory, "ttyd"));
    const persisted = manifest(run);
    await manifests.write(persisted);
    const killProcess = vi.fn();
    const child = {
      stdin: { end: vi.fn() },
      stdout: { resume: vi.fn() },
      stderr: { on: vi.fn() },
      once: vi.fn(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    };
    const spawnProcess = vi.fn(() => child as never);
    const supervisor = new TtydSupervisor(registry, {
      ttydPath: "/usr/bin/ttyd",
      tmuxPath: "/usr/bin/tmux",
      manifestDirectory: join(directory, "ttyd"),
      processInspector: { inspect: vi.fn(async () => persisted.process) },
      killProcess,
      spawnProcess: spawnProcess as never,
    });

    await supervisor.reconcile([run]);

    expect(killProcess).toHaveBeenCalledWith(persisted.pid, "SIGTERM");
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(await manifests.scan()).toEqual([]);
    (child as { exitCode: number | null }).exitCode = 0;
    await supervisor.close();

    await manifests.write(persisted);
    const reusedKill = vi.fn();
    const reused = new TtydSupervisor(registry, {
      ttydPath: "/usr/bin/ttyd",
      tmuxPath: "/usr/bin/tmux",
      manifestDirectory: join(directory, "ttyd"),
      processInspector: {
        inspect: vi.fn(async () => ({ ...persisted.process, startTimeTicks: "1" })),
      },
      killProcess: reusedKill,
      spawnProcess: vi.fn(() => child as never) as never,
    });

    await reused.reconcile([run]);

    expect(reusedKill).not.toHaveBeenCalled();
    expect(await manifests.scan()).toEqual([]);
    await reused.close();
    database.close();
  });
});
