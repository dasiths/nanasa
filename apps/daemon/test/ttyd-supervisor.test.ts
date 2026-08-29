import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentRun } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NanasaStore } from "../src/store.js";
import {
  TerminalEndpointRegistry,
  terminalBasePath,
  terminalEndpointKey,
} from "../src/terminal-endpoint-registry.js";
import { TtydManifestStore } from "../src/ttyd-manifest.js";
import {
  buildTtydArguments,
  restartBackoffMs,
  TtydStartupPortParser,
  TtydSupervisor,
  ttydViewSessionName,
} from "../src/ttyd-supervisor.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runningRun(store: NanasaStore): AgentRun {
  const group = store.createGroup({ name: "Terminal tests" });
  const profile = store.createInternalAgentProfile({
    name: "Fixture",
    agentType: "copilot",
    kind: "copilot",
    command: "node",
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

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  });
  return child;
}

describe("ttyd supervisor primitives", () => {
  it("derives stable bounded endpoint keys and view session names", () => {
    expect(terminalEndpointKey("run_alpha")).toBe("601db9c8de65a115801c3380db8b5d1d");
    expect(terminalBasePath(terminalEndpointKey("run_alpha"))).toBe(
      "/terminals/601db9c8de65a115801c3380db8b5d1d",
    );
    expect(ttydViewSessionName("run_alpha")).toBe("nanasa-view-601db9c8de65a115");
  });

  it("builds fixed direct ttyd and tmux argv without unsafe options", () => {
    const endpointKey = terminalEndpointKey("run_alpha");
    const args = buildTtydArguments(
      {
        runId: "run_alpha",
        serverName: "nanasa-test",
        viewSessionName: ttydViewSessionName("run_alpha"),
        endpointKey,
        basePath: terminalBasePath(endpointKey),
      },
      "/usr/bin/tmux",
    );

    expect(args).toEqual([
      "-W",
      "-i",
      "127.0.0.1",
      "-p",
      "0",
      "-O",
      "-m",
      "1",
      "--base-path",
      "/terminals/601db9c8de65a115801c3380db8b5d1d",
      "--terminal-type",
      "xterm-256color",
      "--client-option",
      "rendererType=canvas",
      "--client-option",
      "scrollback=10000",
      "--client-option",
      "scrollOnUserInput=true",
      "--client-option",
      "disableLeaveAlert=true",
      "/usr/bin/tmux",
      "-L",
      "nanasa-test",
      "-f",
      "/dev/null",
      "attach-session",
      "-E",
      "-t",
      "=nanasa-view-601db9c8de65a115",
    ]);
    expect(args).not.toEqual(expect.arrayContaining(["--url-arg", "--once", "--exit-no-conn"]));
  });

  it("parses a random port across bounded split startup chunks", () => {
    const parser = new TtydStartupPortParser(512);
    expect(
      parser.feed("[2026/08/09 10:00:00:0000] N: ttyd 1.7.7 (libwebsockets 4.3.3)\n"),
    ).toBeUndefined();
    expect(
      parser.feed("[2026/08/09 10:00:00:0001] N: Listening on port: 127.0.0."),
    ).toBeUndefined();
    expect(parser.feed("1:43127\n")).toBe(43_127);
  });

  it("parses ttyd 1.7.7's actual listening notice", () => {
    const parser = new TtydStartupPortParser();
    expect(parser.feed("[2026/08/09 20:08:24:5677] N:  Listening on port: 38839\n")).toBe(38_839);
  });

  it("rejects unbounded startup output", () => {
    const parser = new TtydStartupPortParser(256);
    expect(() => parser.feed("x".repeat(257))).toThrow("exceeded the configured limit");
  });

  it("caps exponential restart backoff", () => {
    expect([1, 2, 3, 4, 8].map((failure) => restartBackoffMs(failure, 100, 800))).toEqual([
      100, 200, 400, 800, 800,
    ]);
  });

  it("fences registry generations and never exposes loopback details in status", () => {
    const store = new NanasaStore(":memory:");
    const run = runningRun(store);
    const registry = new TerminalEndpointRegistry(store);
    const record = registry.begin(run, 4);

    expect(registry.status(run.id)).toEqual({
      runId: run.id,
      provider: "ttyd",
      state: "starting",
    });
    expect(() => registry.resolve(record.endpointKey)).toThrowError(
      expect.objectContaining({ statusCode: 503 }),
    );
    expect(registry.publishReady(run.id, 3, 41_000)).toBe(false);
    expect(registry.publishReady(run.id, 4, 41_001)).toBe(true);
    expect(registry.status(run.id)).toEqual({
      runId: run.id,
      provider: "ttyd",
      state: "ready",
      url: `${record.basePath}/`,
    });
    expect(registry.resolve(record.endpointKey)).toMatchObject({
      runId: run.id,
      generation: 4,
      upstream: "http://127.0.0.1:41001",
    });

    store.updateRunStatus(run.id, "stopped");
    expect(registry.status(run.id).state).toBe("stopped");
    expect(() => registry.resolve(record.endpointKey)).toThrowError(
      expect.objectContaining({ statusCode: 409 }),
    );
    store.close();
  });

  it("spawns direct argv and publishes readiness only after a successful probe", async () => {
    const store = new NanasaStore(":memory:");
    const run = runningRun(store);
    const registry = new TerminalEndpointRegistry(store);
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const probe = vi.fn(async () => true);
    const supervisor = new TtydSupervisor(registry, {
      ttydPath: "/opt/ttyd",
      tmuxPath: "/usr/bin/tmux",
      spawnProcess: spawnProcess as never,
      probe,
    });

    supervisor.start(run);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/ttyd",
      expect.arrayContaining(["-W", "-i", "127.0.0.1", "-p", "0", "-O", "-m", "1"]),
      expect.objectContaining({ shell: false }),
    );
    expect(registry.status(run.id).state).toBe("starting");
    child.stderr.write("[notice] Listening on port: 41234\n");
    await vi.waitFor(() => expect(registry.status(run.id).state).toBe("ready"));
    expect(probe).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:41234\/terminals\/[0-9a-f]{32}\/$/),
      expect.any(AbortSignal),
    );

    await supervisor.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(store.getRun(run.id).status).toBe("running");
    store.close();
  });

  it("schedules one replacement after an unexpected ready-process exit", async () => {
    vi.useFakeTimers();
    const store = new NanasaStore(":memory:");
    const run = runningRun(store);
    const registry = new TerminalEndpointRegistry(store);
    const children = [fakeChild(), fakeChild()];
    const spawnProcess = vi.fn(() => children.shift() as never);
    const supervisor = new TtydSupervisor(registry, {
      spawnProcess: spawnProcess as never,
      probe: async () => true,
      backoffBaseMs: 100,
      backoffCapMs: 100,
    });
    try {
      supervisor.start(run);
      const first = spawnProcess.mock.results[0]?.value as ReturnType<typeof fakeChild>;
      first.stderr.write("Listening on port: 41234\n");
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.status(run.id).state).toBe("ready");

      first.exitCode = 1;
      first.emit("close", 1, null);
      expect(registry.status(run.id)).toMatchObject({ state: "backoff", retryAfterMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect(spawnProcess).toHaveBeenCalledTimes(2);

      await supervisor.close();
      expect(spawnProcess).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("removes the validated manifest during graceful stop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-ttyd-graceful-"));
    temporaryDirectories.push(directory);
    const manifestDirectory = join(directory, "ttyd");
    const store = new NanasaStore(":memory:");
    const run = runningRun(store);
    const registry = new TerminalEndpointRegistry(store);
    const child = fakeChild() as ReturnType<typeof fakeChild> & { pid: number };
    child.pid = 4242;
    const spawnProcess = vi.fn(() => child as never);
    const supervisor = new TtydSupervisor(registry, {
      ttydPath: "/usr/bin/ttyd",
      tmuxPath: "/usr/bin/tmux",
      manifestDirectory,
      spawnProcess: spawnProcess as never,
      processInspector: {
        inspect: vi.fn(async () => {
          const call = spawnProcess.mock.calls[0]!;
          return {
            startTimeTicks: "12345",
            executablePath: "/usr/bin/ttyd",
            executableDevice: "1",
            executableInode: "2",
            uid: process.getuid?.() ?? 1000,
            argv: [call[0], ...call[1]],
          };
        }),
      },
      probe: async () => true,
    });

    supervisor.start(run);
    child.stderr.write("Listening on port: 41234\n");
    await vi.waitFor(() => expect(registry.status(run.id).state).toBe("ready"));
    const manifests = new TtydManifestStore(manifestDirectory);
    expect(await manifests.scan()).toHaveLength(1);

    await supervisor.stop(run.id);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(await manifests.scan()).toEqual([]);
    await supervisor.close();
    store.close();
  });
});
