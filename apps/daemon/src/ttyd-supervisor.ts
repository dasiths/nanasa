import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { AgentRun } from "@nanasa/contracts";

import {
  TerminalEndpointRegistry,
  terminalBasePath,
  terminalBindingFingerprint,
  terminalEndpointKey,
} from "./terminal-endpoint-registry.js";
import {
  linuxProcessInspector,
  matchesExpectedTtydArgv,
  matchesManifestProcess,
  TtydManifestStore,
  type TtydProcessInspector,
  type TtydProcessManifest,
} from "./ttyd-manifest.js";

const startupPortPattern =
  /(?:Listening on port:\s*|(?:127\.0\.0\.1|localhost):)([0-9]{1,5})(?=\s*\r?\n)/;

export interface TtydSupervisorOptions {
  ttydPath?: string;
  tmuxPath?: string;
  startupOutputLimitBytes?: number;
  startupTimeoutMs?: number;
  readinessTimeoutMs?: number;
  stopGraceMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  manifestDirectory?: string;
  processInspector?: TtydProcessInspector;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  onLifecycleEvent?: (type: string, runId: string, payload: Record<string, unknown>) => void;
  spawnProcess?: typeof spawn;
  probe?: (url: string, signal: AbortSignal) => Promise<boolean>;
}

export interface TtydLaunchSpec {
  runId: string;
  serverName: string;
  viewSessionName: string;
  endpointKey: string;
  basePath: string;
}

export function ttydViewSessionName(runId: string): string {
  return `nanasa-view-${terminalEndpointKey(runId).slice(0, 16)}`;
}

export function buildTtydArguments(spec: TtydLaunchSpec, tmuxPath = "tmux"): string[] {
  if (!/^[A-Za-z0-9_.-]+$/.test(spec.serverName)) {
    throw new Error("Invalid tmux server name");
  }
  if (!/^nanasa-view-[0-9a-f]{16}$/.test(spec.viewSessionName)) {
    throw new Error("Invalid tmux view session name");
  }
  if (terminalBasePath(spec.endpointKey) !== spec.basePath) {
    throw new Error("Terminal base path does not match its endpoint key");
  }
  return [
    "-W",
    "-i",
    "127.0.0.1",
    "-p",
    "0",
    "-O",
    "-m",
    "1",
    "--base-path",
    spec.basePath,
    "--terminal-type",
    "xterm-256color",
    "--client-option",
    "rendererType=canvas",
    "--client-option",
    "disableLeaveAlert=true",
    tmuxPath,
    "-L",
    spec.serverName,
    "-f",
    "/dev/null",
    "attach-session",
    "-E",
    "-t",
    `=${spec.viewSessionName}`,
  ];
}

export class TtydStartupPortParser {
  readonly #limit: number;
  #output = "";
  #bytes = 0;

  public constructor(limit = 16_384) {
    if (!Number.isInteger(limit) || limit < 256) {
      throw new Error("Startup output limit must be at least 256 bytes");
    }
    this.#limit = limit;
  }

  public feed(chunk: Buffer | string): number | undefined {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.#bytes += Buffer.byteLength(text);
    if (this.#bytes > this.#limit) {
      throw new Error("ttyd startup output exceeded the configured limit");
    }
    this.#output += text;
    const match = startupPortPattern.exec(this.#output);
    if (match === null) {
      return undefined;
    }
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("ttyd reported an invalid startup port");
    }
    return port;
  }

  public diagnostic(): string {
    return this.#output.slice(-2_048);
  }
}

export function restartBackoffMs(consecutiveFailures: number, baseMs = 250, capMs = 8_000): number {
  const exponent = Math.max(0, Math.min(30, consecutiveFailures - 1));
  return Math.min(capMs, baseMs * 2 ** exponent);
}

interface SupervisedProcess {
  run: AgentRun;
  generation: number;
  ttydArgv?: string[];
  child?: ChildProcessWithoutNullStreams;
  failures: number;
  stopping: boolean;
  restartTimer?: NodeJS.Timeout;
}

export class TtydSupervisor {
  readonly #registry: TerminalEndpointRegistry;
  readonly #ttydPath: string;
  readonly #tmuxPath: string;
  readonly #startupOutputLimitBytes: number;
  readonly #startupTimeoutMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #backoffBaseMs: number;
  readonly #backoffCapMs: number;
  readonly #manifestStore: TtydManifestStore | undefined;
  readonly #processInspector: TtydProcessInspector;
  readonly #killProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly #onLifecycleEvent: NonNullable<TtydSupervisorOptions["onLifecycleEvent"]>;
  readonly #spawnProcess: typeof spawn;
  readonly #probe: (url: string, signal: AbortSignal) => Promise<boolean>;
  readonly #processes = new Map<string, SupervisedProcess>();
  #nextGeneration = 1;
  #manifestsReconciled = false;
  #closing = false;

  public constructor(registry: TerminalEndpointRegistry, options: TtydSupervisorOptions = {}) {
    this.#registry = registry;
    this.#ttydPath = options.ttydPath ?? "ttyd";
    this.#tmuxPath = options.tmuxPath ?? "tmux";
    this.#startupOutputLimitBytes = options.startupOutputLimitBytes ?? 16_384;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 5_000;
    this.#stopGraceMs = options.stopGraceMs ?? 1_000;
    this.#backoffBaseMs = options.backoffBaseMs ?? 250;
    this.#backoffCapMs = options.backoffCapMs ?? 8_000;
    this.#manifestStore =
      options.manifestDirectory === undefined
        ? undefined
        : new TtydManifestStore(options.manifestDirectory);
    this.#processInspector = options.processInspector ?? linuxProcessInspector;
    this.#killProcess = options.killProcess ?? process.kill.bind(process);
    this.#onLifecycleEvent = options.onLifecycleEvent ?? (() => undefined);
    this.#spawnProcess = options.spawnProcess ?? spawn;
    this.#probe =
      options.probe ??
      (async (url, signal) => {
        const response = await fetch(url, { signal, redirect: "manual" });
        return response.status >= 200 && response.status < 400;
      });
  }

  public start(run: AgentRun): void {
    if (this.#closing || run.terminal === undefined || run.status !== "running") {
      return;
    }
    const current = this.#processes.get(run.id);
    if (current !== undefined && !current.stopping) {
      return;
    }
    const record: SupervisedProcess = {
      run,
      generation: this.#nextGeneration,
      failures: current?.failures ?? 0,
      stopping: false,
    };
    this.#nextGeneration += 1;
    this.#processes.set(run.id, record);
    this.#spawn(record);
  }

  public unavailable(run: AgentRun, error: unknown): void {
    if (run.terminal === undefined) {
      return;
    }
    const generation = this.#nextGeneration;
    this.#nextGeneration += 1;
    this.#registry.begin(run, generation);
    this.#registry.publishUnavailable(run.id, generation, {
      code: "terminal_view_unavailable",
      message: error instanceof Error ? error.message : "Terminal view session is unavailable",
    });
  }

  public async reconcile(runs: readonly AgentRun[]): Promise<void> {
    const desired = new Map(
      runs
        .filter((run) => run.status === "running" && run.terminal !== undefined)
        .map((run) => [run.id, run]),
    );
    if (!this.#manifestsReconciled) {
      await this.#reconcileManifests(desired);
      this.#manifestsReconciled = true;
    }
    for (const [runId, record] of this.#processes) {
      const run = desired.get(runId);
      if (
        run === undefined ||
        run.terminal?.serverName !== record.run.terminal?.serverName ||
        run.terminal?.sessionId !== record.run.terminal?.sessionId ||
        run.terminal?.windowId !== record.run.terminal?.windowId ||
        run.terminal?.paneId !== record.run.terminal?.paneId
      ) {
        await this.stop(runId);
      }
    }
    for (const run of desired.values()) {
      this.start(run);
    }
  }

  public async stop(runId: string): Promise<void> {
    const record = this.#processes.get(runId);
    this.#registry.stop(runId);
    if (record === undefined) {
      return;
    }
    record.stopping = true;
    if (record.restartTimer !== undefined) {
      clearTimeout(record.restartTimer);
    }
    await this.#terminate(record.child);
    await this.#manifestStore?.remove(runId);
    if (this.#processes.get(runId) === record) {
      this.#processes.delete(runId);
    }
  }

  public async close(): Promise<void> {
    this.#closing = true;
    await Promise.all([...this.#processes.keys()].map((runId) => this.stop(runId)));
  }

  #spawn(record: SupervisedProcess): void {
    const terminal = record.run.terminal;
    if (terminal === undefined || record.stopping || this.#closing) {
      return;
    }
    const endpointKey = terminalEndpointKey(record.run.id);
    const basePath = terminalBasePath(endpointKey);
    this.#registry.begin(record.run, record.generation);
    const args = buildTtydArguments(
      {
        runId: record.run.id,
        serverName: terminal.serverName,
        viewSessionName: ttydViewSessionName(record.run.id),
        endpointKey,
        basePath,
      },
      this.#tmuxPath,
    );
    const parser = new TtydStartupPortParser(this.#startupOutputLimitBytes);
    const ttydArgv = [this.#ttydPath, ...args];
    const child = this.#spawnProcess(this.#ttydPath, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    record.ttydArgv = ttydArgv;
    record.child = child;
    child.stdin.end();
    child.stdout.resume();
    let startupSettled = false;
    let failureHandled = false;
    const startupTimer = setTimeout(
      () => fail(new Error("Timed out waiting for ttyd startup")),
      this.#startupTimeoutMs,
    );
    startupTimer.unref();

    const fail = (error: unknown) => {
      if (failureHandled || !this.#isCurrent(record)) {
        return;
      }
      failureHandled = true;
      clearTimeout(startupTimer);
      void this.#terminate(child);
      void this.#manifestStore?.remove(record.run.id);
      this.#scheduleRestart(record, error);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      if (startupSettled) {
        return;
      }
      try {
        const port = parser.feed(chunk);
        if (port !== undefined) {
          startupSettled = true;
          clearTimeout(startupTimer);
          void this.#probeReady(record, child, port).catch(fail);
        }
      } catch (error) {
        fail(error);
      }
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (!this.#isCurrent(record) || record.stopping || this.#closing) {
        return;
      }
      fail(
        new Error(
          `ttyd exited ${startupSettled ? "unexpectedly" : "during startup"} (${code ?? signal ?? "unknown"})`,
        ),
      );
    });
  }

  async #probeReady(
    record: SupervisedProcess,
    child: ChildProcessWithoutNullStreams,
    port: number,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#readinessTimeoutMs);
    timer.unref();
    try {
      const basePath = terminalBasePath(terminalEndpointKey(record.run.id));
      const ready = await this.#probe(`http://127.0.0.1:${port}${basePath}/`, controller.signal);
      if (!ready) {
        throw new Error("ttyd readiness probe failed");
      }
      if (!this.#isCurrent(record) || record.child !== child || record.stopping) {
        return;
      }
      await this.#writeValidatedManifest(record, child);
      if (!this.#isCurrent(record) || record.child !== child || record.stopping) {
        await this.#manifestStore?.remove(record.run.id);
        return;
      }
      record.failures = 0;
      this.#registry.publishReady(record.run.id, record.generation, port);
    } finally {
      clearTimeout(timer);
    }
  }

  #scheduleRestart(record: SupervisedProcess, error: unknown): void {
    if (!this.#isCurrent(record) || record.stopping || this.#closing) {
      return;
    }
    record.failures += 1;
    record.generation = this.#nextGeneration;
    this.#nextGeneration += 1;
    const delay = restartBackoffMs(record.failures, this.#backoffBaseMs, this.#backoffCapMs);
    this.#registry.begin(record.run, record.generation);
    this.#registry.publishBackoff(record.run.id, record.generation, delay, {
      code: "ttyd_unavailable",
      message: error instanceof Error ? error.message : "Terminal provider failed",
    });
    record.restartTimer = setTimeout(() => this.#spawn(record), delay);
    record.restartTimer.unref();
  }

  #isCurrent(record: SupervisedProcess): boolean {
    return this.#processes.get(record.run.id) === record;
  }

  async #writeValidatedManifest(
    record: SupervisedProcess,
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (this.#manifestStore === undefined) return;
    const pid = child.pid;
    const terminal = record.run.terminal;
    const ttydArgv = record.ttydArgv;
    if (pid === undefined || terminal === undefined || ttydArgv === undefined) {
      throw new Error("ttyd_process_identity_unavailable");
    }
    const identity = await this.#processInspector.inspect(pid);
    if (identity === undefined) throw new Error("ttyd_process_identity_unavailable");
    if (!matchesExpectedTtydArgv(ttydArgv, identity.argv)) {
      throw new Error("ttyd_process_argv_mismatch");
    }
    const endpointKey = terminalEndpointKey(record.run.id);
    const manifest: TtydProcessManifest = {
      version: 1,
      runId: record.run.id,
      runGeneration: record.run.generation,
      endpointKey,
      basePath: terminalBasePath(endpointKey),
      pid,
      process: identity,
      ttydArgv,
      tmux: {
        serverName: terminal.serverName,
        viewSessionName: ttydViewSessionName(record.run.id),
        bindingFingerprint: terminalBindingFingerprint(terminal),
      },
      createdAt: new Date().toISOString(),
    };
    await this.#manifestStore.write(manifest);
    this.#onLifecycleEvent("ttyd.manifest-written", record.run.id, {
      pid,
      runGeneration: record.run.generation,
    });
  }

  async #reconcileManifests(desired: ReadonlyMap<string, AgentRun>): Promise<void> {
    if (this.#manifestStore === undefined) return;
    for (const entry of await this.#manifestStore.scan()) {
      const manifest = entry.manifest;
      if (manifest === undefined) {
        this.#onLifecycleEvent("ttyd.manifest-rejected", "runtime", {
          reason: entry.rejectionReason ?? "manifest_invalid",
        });
        await this.#manifestStore.removeEntry(entry);
        continue;
      }
      const identity = await this.#processInspector.inspect(manifest.pid).catch(() => undefined);
      if (!matchesManifestProcess(manifest, identity)) {
        this.#onLifecycleEvent("ttyd.manifest-discarded", manifest.runId, {
          reason: "process_identity_mismatch",
          pid: manifest.pid,
        });
        await this.#manifestStore.removeEntry(entry);
        continue;
      }
      const run = desired.get(manifest.runId);
      const expectedArgv = run === undefined ? undefined : this.#expectedArgv(run);
      const expected =
        run !== undefined &&
        expectedArgv !== undefined &&
        run.generation === manifest.runGeneration &&
        run.terminal !== undefined &&
        terminalEndpointKey(run.id) === manifest.endpointKey &&
        terminalBasePath(manifest.endpointKey) === manifest.basePath &&
        terminalBindingFingerprint(run.terminal) === manifest.tmux.bindingFingerprint &&
        run.terminal.serverName === manifest.tmux.serverName &&
        ttydViewSessionName(run.id) === manifest.tmux.viewSessionName &&
        expectedArgv.length === manifest.ttydArgv.length &&
        expectedArgv.every((argument, index) => argument === manifest.ttydArgv[index]);
      this.#killProcess(manifest.pid, "SIGTERM");
      this.#onLifecycleEvent("ttyd.orphan-cleaned", manifest.runId, {
        reason: expected ? "safe_adoption_unavailable" : "stale_manifest_exact_identity",
        pid: manifest.pid,
      });
      await this.#manifestStore.removeEntry(entry);
    }
  }

  #expectedArgv(run: AgentRun): string[] | undefined {
    const terminal = run.terminal;
    if (terminal === undefined) return undefined;
    const endpointKey = terminalEndpointKey(run.id);
    return [
      this.#ttydPath,
      ...buildTtydArguments(
        {
          runId: run.id,
          serverName: terminal.serverName,
          viewSessionName: ttydViewSessionName(run.id),
          endpointKey,
          basePath: terminalBasePath(endpointKey),
        },
        this.#tmuxPath,
      ),
    ];
  }

  async #terminate(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, this.#stopGraceMs);
      forceTimer.unref();
      child.once("close", finish);
      child.kill("SIGTERM");
    });
  }
}
