import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentProfile,
  AgentRun,
  GroupMembership,
  NativeSessionReference,
  TerminalBinding,
  TerminalReadRequest,
  TerminalReadResult,
} from "@nanasa/contracts";

import type {
  AgentRuntimeConfiguration,
  AgentRuntimeProvisioner,
} from "./agent-runtime-provisioner.js";
import { ProcessIdentityObserver } from "./process-identity-observer.js";
import { type RuntimeObservation, runtimeObservation } from "./runtime-observation.js";
import { DomainError, NanasaStore } from "./store.js";
import { terminalViewSessionName } from "./terminal/terminal-input-arbiter.js";

export interface TmuxRuntimeOptions {
  serverName?: string;
  tmuxPath?: string;
  runtimeEnvironment?: (run: AgentRun) => Record<string, string> | Promise<Record<string, string>>;
  runtimeProvisioner?: AgentRuntimeProvisioner;
  providerAuthority?: Pick<AgentRuntimeProvisioner, "controlPolicy" | "processRecognizer">;
  processIdentityObserver?: ProcessIdentityObserver;
  invalidationHooks?: Readonly<Record<string, string>>;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OwnedPaneStatus {
  dead: boolean;
  inMode: boolean;
  alternateOn: boolean;
  currentCommand: string;
}

interface ReconciledPaneStatus {
  sessionId: string;
  windowId: string;
  dead: string;
  runId: string;
  generation: string;
  pid: string;
  deadStatus: string;
  deadSignal: string;
  deadTime: string;
}

export type ProviderUpdatePaneStopResult = "stopped" | "missing" | "ownership-uncertain";
export type ProviderUpdatePaneInspection = "owned" | "missing" | "ownership-uncertain";

const TERMINAL_SUBMIT_DELAY_MS = 500;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sessionName(groupId: string): string {
  return `nanasa-${createHash("sha256").update(groupId).digest("hex").slice(0, 16)}`;
}

function windowName(run: AgentRun): string {
  return `run-${run.generation}-${createHash("sha256").update(run.id).digest("hex").slice(0, 8)}`;
}

function terminalInputTarget(binding: TerminalBinding): string {
  return `${binding.sessionId}:${binding.windowId}.0`;
}

function parseBinding(serverName: string, output: string): TerminalBinding {
  const [sessionId, windowId, paneId] = output.trim().split("\t");
  if (
    !/^\$\d+$/.test(sessionId ?? "") ||
    !/^@\d+$/.test(windowId ?? "") ||
    !/^%\d+$/.test(paneId ?? "")
  ) {
    throw new Error(`Unexpected tmux binding output: ${JSON.stringify(output)}`);
  }
  return {
    serverName,
    sessionId: sessionId ?? "",
    windowId: windowId ?? "",
    paneId: paneId ?? "",
  };
}

export class TmuxRuntime {
  public readonly serverName: string;
  readonly #store: NanasaStore;
  readonly #tmuxPath: string;
  readonly #runtimeEnvironment: NonNullable<TmuxRuntimeOptions["runtimeEnvironment"]>;
  readonly #runtimeProvisioner: AgentRuntimeProvisioner | undefined;
  readonly #providerAuthority:
    | Pick<AgentRuntimeProvisioner, "controlPolicy" | "processRecognizer">
    | undefined;
  readonly #processIdentityObserver: ProcessIdentityObserver;
  readonly #invalidationHooks: Readonly<Record<string, string>>;
  readonly #reconciliations = new Set<Promise<void>>();
  readonly #detachedRunIds = new Set<string>();
  readonly #provisionedRuns = new Map<string, AgentRuntimeConfiguration>();
  #serverConfiguration: Promise<void> | undefined;
  #passthroughSupported = false;
  #closing = false;

  public constructor(store: NanasaStore, options: TmuxRuntimeOptions = {}) {
    this.#store = store;
    this.serverName = options.serverName ?? "nanasa";
    this.#tmuxPath = options.tmuxPath ?? "tmux";
    this.#runtimeEnvironment = options.runtimeEnvironment ?? (() => ({}));
    this.#runtimeProvisioner = options.runtimeProvisioner;
    this.#providerAuthority = options.providerAuthority ?? options.runtimeProvisioner;
    this.#processIdentityObserver =
      options.processIdentityObserver ?? new ProcessIdentityObserver();
    this.#invalidationHooks = options.invalidationHooks ?? {};
    if (!/^[A-Za-z0-9_.-]+$/.test(this.serverName)) {
      throw new Error(
        "tmux server name may contain only letters, numbers, dot, underscore, and dash",
      );
    }
  }

  public async startRun(
    groupId: string,
    memberId: string,
    size: { cols: number; rows: number },
  ): Promise<AgentRun> {
    const { run, profile, membership } = this.#store.createRunForMembership(groupId, memberId);
    return this.#launchCreatedRun(run, profile, membership, size);
  }

  public async recoverRun(
    previous: AgentRun,
    size: { cols: number; rows: number },
    options: {
      nativeSession?: NativeSessionReference;
      nativeSessionId?: string;
      onReplacementCreated?: (run: AgentRun) => void;
    } = {},
  ): Promise<AgentRun> {
    const current = this.#store.getRun(previous.id);
    if (
      current.generation !== previous.generation ||
      current.desiredState !== "running" ||
      current.id !== previous.id
    ) {
      throw new DomainError(
        "recovery_generation_fenced",
        "The run recovery generation is no longer authoritative",
        409,
      );
    }
    if (
      current.recoveryPhase === "resuming" &&
      (current.status === "starting" || current.status === "running")
    ) {
      try {
        await this.#ownedPaneStatus(current, true, true);
        await this.#tmux(["kill-pane", "-t", current.terminal!.paneId]);
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith("terminal_owner_pane_"))) {
          throw error;
        }
      }
    }
    if (current.status !== "failed") {
      this.#store.updateRunStatus(current.id, "failed", { reason: "recovery_replaced" });
    }
    const { run, profile, membership } = this.#store.createRunForMembership(
      current.groupId,
      current.memberId,
      {
        recoveryFrom: current,
        launchKind: options.nativeSession === undefined ? "restarted" : "resuming",
        ...(options.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: options.nativeSessionId }),
      },
    );
    options.onReplacementCreated?.(run);
    return this.#launchCreatedRun(run, profile, membership, size, options.nativeSession);
  }

  public async inspectProviderUpdatePane(
    run: AgentRun,
    options: { forceIndeterminate?: boolean } = {},
  ): Promise<ProviderUpdatePaneInspection> {
    const inspection = await this.#inspectProviderUpdatePane(run);
    if (
      inspection.status === "ownership-uncertain" &&
      inspection.forceable === true &&
      options.forceIndeterminate === true
    ) {
      return "owned";
    }
    return inspection.status;
  }

  public async stopProviderUpdatePane(
    run: AgentRun,
    options: { forceIndeterminate?: boolean } = {},
  ): Promise<ProviderUpdatePaneStopResult> {
    const inspection = await this.#inspectProviderUpdatePane(run);
    if (inspection.status === "missing") return "missing";
    if (
      inspection.status === "ownership-uncertain" &&
      (inspection.forceable !== true || options.forceIndeterminate !== true)
    ) {
      return "ownership-uncertain";
    }
    const binding = run.terminal!;
    const stopped = await this.#tmux(["kill-pane", "-t", binding.paneId], true);
    if (stopped.exitCode === 0 || stopped.stderr.includes("can't find pane")) return "stopped";
    throw new Error(stopped.stderr.trim() || "tmux kill-pane failed");
  }

  async #inspectProviderUpdatePane(
    run: AgentRun,
  ): Promise<{ status: ProviderUpdatePaneInspection; forceable?: boolean }> {
    const binding = run.terminal;
    if (binding === undefined) return { status: "missing" };
    if (binding.serverName !== this.serverName) return { status: "ownership-uncertain" };
    let result: CommandOutput;
    try {
      result = await this.#tmux(
        [
          "list-panes",
          "-a",
          "-F",
          "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@nanasa-run-id}\t#{@nanasa-generation}",
        ],
        true,
      );
    } catch {
      return { status: "ownership-uncertain" };
    }
    if (result.exitCode !== 0) return { status: "missing" };
    const pane = result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\t"))
      .find((fields) => fields[2] === binding.paneId);
    if (pane === undefined) return { status: "missing" };
    const [sessionId, windowId, paneId, dead, runId, generation] = pane;
    if (
      sessionId !== binding.sessionId ||
      windowId !== binding.windowId ||
      paneId !== binding.paneId ||
      runId !== run.id ||
      generation !== String(run.generation)
    ) {
      return { status: "ownership-uncertain" };
    }
    if (dead === "1") return { status: "missing" };
    if (dead !== "0") return { status: "ownership-uncertain", forceable: true };
    return { status: "owned" };
  }

  public async startConsole(
    consoleId: string,
    workingDirectory: string,
    size: { cols: number; rows: number },
  ): Promise<AgentRun> {
    const run: AgentRun = {
      id: consoleId,
      groupId: consoleId,
      memberId: consoleId,
      agentProfileId: "console",
      generation: 1,
      status: "running",
      desiredState: "running",
      recoveryPhase: "idle",
      recoveryAttempts: 0,
      launchKind: "fresh",
      requestedModelSource: "provider-default",
      startedAt: new Date().toISOString(),
    };
    try {
      const terminal = await this.#launchCommand(run, ["bash"], workingDirectory, {}, size);
      this.#detachedRunIds.add(run.id);
      return { ...run, terminal };
    } catch (error) {
      this.#detachedRunIds.delete(run.id);
      throw error;
    }
  }

  public async stopConsole(run: AgentRun): Promise<void> {
    this.#detachedRunIds.delete(run.id);
    if (run.terminal === undefined) return;
    const result = await this.#tmux(["kill-pane", "-t", run.terminal.paneId], true);
    if (result.exitCode !== 0 && !result.stderr.includes("can't find pane")) {
      throw new Error(result.stderr.trim() || "tmux kill-pane failed");
    }
  }

  async #launchCreatedRun(
    run: AgentRun,
    profile: AgentProfile,
    membership: GroupMembership,
    size: { cols: number; rows: number },
    nativeSession?: NativeSessionReference,
  ): Promise<AgentRun> {
    let binding: TerminalBinding | undefined;
    try {
      binding = await this.#launch(run, profile, membership, size, nativeSession);
      return this.#store.updateRunStatus(run.id, "running", { terminal: binding });
    } catch (error) {
      if (binding !== undefined) {
        await this.#tmux(["kill-pane", "-t", binding.paneId], true);
      }
      this.#store.updateRunStatus(run.id, "failed", {
        reason: error instanceof Error ? error.message : "tmux_launch_failed",
      });
      throw error;
    }
  }

  public async stopRun(groupId: string, memberId: string): Promise<AgentRun> {
    const run = this.#store.getActiveRun(groupId, memberId);
    if (run === undefined) {
      throw new DomainError("active_run_not_found", "The member has no active run", 404);
    }
    const stopping = this.#store.updateRunStatus(run.id, "stopping");
    if (stopping.terminal !== undefined) {
      try {
        await this.#ownedPaneStatus(stopping, true, true);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "terminal_run_unavailable" ||
            error.message.startsWith("terminal_owner_pane_"))
        ) {
          return this.#store.updateRunStatus(run.id, "stopped", {
            reason: "terminal_binding_not_owned",
          });
        }
        throw error;
      }
      const result = await this.#tmux(["kill-pane", "-t", stopping.terminal.paneId], true);
      if (result.exitCode !== 0 && !result.stderr.includes("can't find pane")) {
        this.#store.updateRunStatus(run.id, "failed", { reason: result.stderr.trim() });
        throw new Error(result.stderr.trim() || "tmux kill-pane failed");
      }
    }
    return this.#store.updateRunStatus(run.id, "stopped", { reason: "operator_stopped" });
  }

  public async ensureViewSession(run: AgentRun): Promise<string> {
    const binding = run.terminal;
    if (binding === undefined || binding.serverName !== this.serverName) {
      throw new Error("Run does not have a binding on this tmux server");
    }
    const viewSession = terminalViewSessionName(run.id);
    if (!(await this.#viewMatches(viewSession, binding))) {
      await this.#tmux(["kill-session", "-t", `=${viewSession}`], true);
      const bootstrapWindowId = (
        await this.#tmux([
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{window_id}",
          "-s",
          viewSession,
          "-n",
          "bootstrap",
        ])
      ).stdout.trim();
      try {
        await this.#tmux([
          "link-window",
          "-s",
          `${binding.sessionId}:${binding.windowId}`,
          "-t",
          `=${viewSession}:1`,
        ]);
        await this.#tmux(["select-window", "-t", `=${viewSession}:1`]);
        await this.#tmux(["kill-window", "-t", bootstrapWindowId]);
      } catch (error) {
        await this.#tmux(["kill-session", "-t", `=${viewSession}`], true);
        throw error;
      }
    }
    await this.#tmux(["set-option", "-t", viewSession, "prefix", "None"]);
    await this.#tmux(["set-option", "-t", viewSession, "prefix2", "None"]);
    await this.#tmux(["set-option", "-t", viewSession, "status", "off"]);
    await this.#tmux(["set-option", "-t", viewSession, "destroy-unattached", "off"]);
    await this.#tmux(["set-option", "-t", viewSession, "mouse", "on"]);
    await this.#tmux(["set-option", "-w", "-t", `${viewSession}:1`, "window-size", "latest"]);
    if (!(await this.#viewMatches(viewSession, binding))) {
      throw new Error(`tmux view session ${viewSession} does not match its owner pane`);
    }
    await this.#enableOwnedPassthrough(run);
    return viewSession;
  }

  public async removeViewSession(runId: string): Promise<void> {
    await this.#tmux(["kill-session", "-t", `=${terminalViewSessionName(runId)}`], true);
  }

  public async removeStaleViewSessions(activeRunIds: ReadonlySet<string>): Promise<void> {
    const desired = new Set(
      [...activeRunIds, ...this.#detachedRunIds].map(terminalViewSessionName),
    );
    const result = await this.#tmux(["list-sessions", "-F", "#{session_name}"], true);
    if (result.exitCode !== 0) {
      return;
    }
    for (const name of result.stdout.trim().split("\n").filter(Boolean)) {
      if (name.startsWith("nanasa-view-") && !desired.has(name)) {
        await this.#tmux(["kill-session", "-t", `=${name}`], true);
      }
    }
  }

  public async pasteToRun(run: AgentRun, text: string): Promise<void> {
    await this.#ownedPaneStatus(run);
    if (Buffer.byteLength(text, "utf8") > 1_048_576) {
      throw new Error("terminal_delivery_too_large");
    }
    const target = terminalInputTarget(run.terminal!);
    if (this.#providerAuthority === undefined) {
      throw new Error("Provider snapshot authority is unavailable");
    }
    const submitInput = (await this.#providerAuthority.controlPolicy(run)).terminalSubmitSequence;
    const bufferName = `nanasa-${randomUUID()}`;
    await this.#tmux(["load-buffer", "-b", bufferName, "-"], false, text);
    try {
      await this.#tmux(["paste-buffer", "-b", bufferName, "-d", "-p", "-t", target]);
      await delay(TERMINAL_SUBMIT_DELAY_MS);
      if (submitInput === "\r") {
        await this.#tmux(["send-keys", "-t", target, "Enter"]);
      } else {
        await this.#tmux(["load-buffer", "-b", bufferName, "-"], false, submitInput);
        await this.#tmux(["paste-buffer", "-b", bufferName, "-d", "-t", target]);
      }
    } finally {
      await this.#tmux(["delete-buffer", "-b", bufferName], true);
    }
  }

  public async observeRun(run: AgentRun): Promise<RuntimeObservation> {
    const binding = run.terminal;
    if (binding === undefined || binding.serverName !== this.serverName) {
      return runtimeObservation(run, "missing", { evidenceCode: "terminal_binding_unavailable" });
    }
    let result: CommandOutput;
    try {
      result = await this.#tmux(
        [
          "list-panes",
          "-a",
          "-F",
          "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{@nanasa-run-id}\t#{@nanasa-generation}\t#{pane_pid}\t#{pane_tty}",
        ],
        true,
      );
    } catch {
      return runtimeObservation(run, "indeterminate", {
        evidenceCode: "tmux_observation_failed",
      });
    }
    if (result.exitCode !== 0) {
      return runtimeObservation(run, "missing", {
        evidenceCode: `tmux_server_unavailable_${result.exitCode}`,
      });
    }
    const pane = result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\t"))
      .find((fields) => fields[2] === binding.paneId);
    if (pane === undefined) {
      return runtimeObservation(run, "missing", { evidenceCode: "owned_pane_missing" });
    }
    const [sessionId, windowId, paneId, dead, deadStatus, deadSignal, runId, generation, panePid] =
      pane;
    if (
      sessionId !== binding.sessionId ||
      windowId !== binding.windowId ||
      paneId !== binding.paneId ||
      runId !== run.id ||
      generation !== String(run.generation)
    ) {
      return runtimeObservation(run, "missing", { evidenceCode: "owned_pane_identity_mismatch" });
    }
    if (dead === "1") {
      return runtimeObservation(run, "dead", {
        evidenceCode: "tmux_retained_exit",
        ...(/^-?\d+$/.test(deadStatus ?? "") ? { exitCode: Number(deadStatus) } : {}),
        ...(deadSignal === undefined || deadSignal.length === 0 ? {} : { signal: deadSignal }),
      });
    }
    if (dead !== "0") {
      return runtimeObservation(run, "indeterminate", {
        evidenceCode: "malformed_tmux_dead_state",
      });
    }
    if (!/^\d+$/.test(panePid ?? "")) {
      return runtimeObservation(run, "indeterminate", { evidenceCode: "pane_pid_malformed" });
    }
    try {
      if (this.#providerAuthority === undefined) {
        throw new Error("Provider snapshot authority is unavailable");
      }
      const process = await this.#processIdentityObserver.observe(
        Number(panePid),
        await this.#providerAuthority.processRecognizer(run),
      );
      return runtimeObservation(run, "present", {
        evidenceCode: "exact_owned_pane_and_process",
        process,
      });
    } catch {
      return runtimeObservation(run, "indeterminate", {
        evidenceCode: "process_identity_unavailable",
      });
    }
  }

  public async interruptRun(run: AgentRun): Promise<void> {
    await this.#ownedPaneStatus(run);
    await this.#tmux(["send-keys", "-t", terminalInputTarget(run.terminal!), "C-c"]);
  }

  public async readTerminal(request: TerminalReadRequest): Promise<TerminalReadResult> {
    const run = this.#store.getRun(request.runId);
    if (run.generation !== request.generation) {
      throw new DomainError(
        "terminal_read_generation_mismatch",
        "Terminal read generation does not match the run",
        409,
      );
    }
    const status = await this.#ownedPaneStatus(run, true, true);
    const binding = run.terminal as TerminalBinding;
    const start = request.source === "history" ? `-${request.maxLines}` : "0";
    const captured = await this.#tmux([
      "capture-pane",
      "-p",
      "-t",
      binding.paneId,
      "-S",
      start,
      "-E",
      "-",
    ]);
    const lines = captured.stdout.replaceAll("\r\n", "\n").split("\n");
    const boundedLines = lines.length > request.maxLines ? lines.slice(-request.maxLines) : lines;
    const lineTruncated = boundedLines.length !== lines.length;
    const text = boundedLines.join("\n");
    const encoded = Buffer.from(text, "utf8");
    const byteTruncated = encoded.length > request.maxBytes;
    const boundedText = byteTruncated
      ? encoded
          .subarray(encoded.length - request.maxBytes)
          .toString("utf8")
          .replace(/^\uFFFD/, "")
      : text;
    return {
      runId: run.id,
      generation: run.generation,
      binding,
      source: request.source,
      text: boundedText,
      lineCount: boundedText.length === 0 ? 0 : boundedText.split("\n").length,
      byteCount: Buffer.byteLength(boundedText, "utf8"),
      truncated: lineTruncated || byteTruncated,
      alternateScreen: status.alternateOn,
      capturedAt: new Date().toISOString(),
    };
  }

  public reconcile(markOrphanedStarting = false): Promise<void> {
    if (this.#closing) {
      return Promise.resolve();
    }
    const operation = this.#reconcile(markOrphanedStarting);
    this.#reconciliations.add(operation);
    void operation.then(
      () => this.#reconciliations.delete(operation),
      () => this.#reconciliations.delete(operation),
    );
    return operation;
  }

  async #reconcile(markOrphanedStarting: boolean): Promise<void> {
    const result = await this.#tmux(
      [
        "list-panes",
        "-a",
        "-F",
        "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@nanasa-run-id}\t#{@nanasa-generation}\t#{pane_pid}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{pane_dead_time}",
      ],
      true,
    );
    if (result.exitCode !== 0) return;
    const panes = new Map<string, ReconciledPaneStatus[]>();
    for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
      const [
        sessionId = "",
        windowId = "",
        paneId = "",
        dead = "",
        runId = "",
        generation = "",
        pid = "",
        deadStatus = "",
        deadSignal = "",
        deadTime = "",
      ] = line.split("\t");
      const records = panes.get(paneId) ?? [];
      records.push({
        sessionId,
        windowId,
        dead,
        runId,
        generation,
        pid,
        deadStatus,
        deadSignal,
        deadTime,
      });
      panes.set(paneId, records);
    }

    for (const run of this.#store.listActiveRuns()) {
      if (run.status === "stopping") {
        continue;
      }
      const binding = run.terminal;
      if (binding === undefined || binding.serverName !== this.serverName) {
        if (run.desiredState !== "running" && (run.status !== "starting" || markOrphanedStarting)) {
          this.#store.updateRunStatus(run.id, "failed", { reason: "tmux_binding_unavailable" });
        }
        continue;
      }
      const pane = panes
        .get(binding.paneId)
        ?.find(
          (candidate) =>
            candidate.sessionId === binding.sessionId &&
            candidate.windowId === binding.windowId &&
            candidate.runId === run.id &&
            candidate.generation === String(run.generation),
        );
      if (pane === undefined) {
        this.#store.recordProcessStatus(run.id, {
          event: "process.missing",
          eventId: `process-missing-${run.generation}`,
          observedAt: new Date().toISOString(),
        });
        if (run.desiredState !== "running") {
          this.#store.updateRunStatus(run.id, "stopped", { reason: "tmux_pane_exited" });
        }
        continue;
      }
      if (pane.dead === "1") {
        const parsedExitCode = /^-?\d+$/.test(pane.deadStatus)
          ? Number.parseInt(pane.deadStatus, 10)
          : undefined;
        this.#store.recordProcessStatus(run.id, {
          event: "process.exited",
          eventId: `process-exited-${run.generation}-${pane.deadTime || pane.pid || "observed"}`,
          observedAt:
            pane.deadTime.length > 0 && !Number.isNaN(Date.parse(pane.deadTime))
              ? new Date(pane.deadTime).toISOString()
              : new Date().toISOString(),
          ...(parsedExitCode === undefined ? {} : { exitCode: parsedExitCode }),
          ...(pane.deadSignal.length === 0 ? {} : { signal: pane.deadSignal }),
          operatorStopped: run.desiredState !== "running",
        });
        if (run.desiredState !== "running") {
          this.#store.updateRunStatus(run.id, "stopped", { reason: "tmux_pane_exited" });
        }
        continue;
      }
      this.#store.recordProcessStatus(run.id, {
        event: "process.alive",
        eventId: `process-alive-${run.generation}`,
        observedAt: new Date().toISOString(),
      });
      if (run.status === "starting") {
        this.#store.updateRunStatus(run.id, "running");
      }
    }
  }

  public async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled([...this.#reconciliations]);
  }

  async #viewMatches(viewSession: string, binding: TerminalBinding): Promise<boolean> {
    const result = await this.#tmux(
      ["list-panes", "-t", `=${viewSession}`, "-F", "#{window_id}\t#{pane_id}"],
      true,
    );
    if (result.exitCode !== 0) {
      return false;
    }
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    return lines.length === 1 && lines[0] === `${binding.windowId}\t${binding.paneId}`;
  }

  async #launch(
    run: AgentRun,
    profile: AgentProfile,
    membership: GroupMembership,
    size: { cols: number; rows: number },
    nativeSession?: NativeSessionReference,
  ): Promise<TerminalBinding> {
    const provisioned = await this.#runtimeProvisioner?.provision(
      run,
      membership,
      profile,
      nativeSession,
    );
    const environment = {
      ...profile.environment,
      ...(await this.#runtimeEnvironment(run)),
      ...provisioned?.environment,
    };
    const launchArguments =
      provisioned === undefined ? [profile.command, ...profile.args] : [...provisioned.command];
    if (provisioned !== undefined) {
      this.#provisionedRuns.set(run.id, provisioned);
      this.#store.updateRunProviderMetadata(run.id, {
        launchKind: nativeSession === undefined ? run.launchKind : "resuming",
        requestedModel: provisioned.desiredModel,
        requestedModelSource: provisioned.desiredModelSource,
      });
    }
    return this.#launchCommand(
      run,
      launchArguments,
      run.resolvedWorkingDirectory ?? profile.workingDirectory,
      environment,
      size,
    );
  }

  async #launchCommand(
    run: AgentRun,
    launchArguments: string[],
    workingDirectory: string | undefined,
    environment: Record<string, string>,
    size: { cols: number; rows: number },
  ): Promise<TerminalBinding> {
    const environmentArguments: string[] = [];
    for (const [name, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new DomainError(
          "invalid_profile_environment",
          `Invalid environment name ${name}`,
          400,
        );
      }
      environmentArguments.push("-e", `${name}=${value}`);
    }
    const launchCommand = launchArguments.map(shellQuote).join(" ");
    const session = sessionName(run.groupId);
    const exists = (await this.#tmux(["has-session", "-t", `=${session}`], true)).exitCode === 0;
    let bootstrapWindowId: string | undefined;
    let binding: TerminalBinding | undefined;
    if (!exists) {
      bootstrapWindowId = (
        await this.#tmux([
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{window_id}",
          "-s",
          session,
          "-n",
          "bootstrap",
          "-x",
          String(size.cols),
          "-y",
          String(size.rows),
        ])
      ).stdout.trim();
    }
    try {
      await this.#configureServer();
      const args = [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{session_id}\t#{window_id}\t#{pane_id}",
        "-t",
        `=${session}`,
        "-n",
        windowName(run),
      ];
      if (workingDirectory !== undefined) {
        args.push("-c", workingDirectory);
      }
      args.push(...environmentArguments, `stty -ixon 2>/dev/null; exec ${launchCommand}`);
      binding = parseBinding(this.serverName, (await this.#tmux(args)).stdout);
      await this.#tmux(["set-option", "-p", "-t", binding.paneId, "@nanasa-run-id", run.id]);
      await this.#tmux([
        "set-option",
        "-p",
        "-t",
        binding.paneId,
        "@nanasa-generation",
        String(run.generation),
      ]);
      await this.#tmux(["set-option", "-w", "-t", binding.windowId, "window-size", "manual"]);
      await this.#tmux([
        "resize-window",
        "-x",
        String(size.cols),
        "-y",
        String(size.rows),
        "-t",
        binding.windowId,
      ]);
      return binding;
    } catch (error) {
      if (binding !== undefined) {
        await this.#tmux(["kill-pane", "-t", binding.paneId], true);
      }
      throw error;
    } finally {
      if (bootstrapWindowId !== undefined) {
        await this.#tmux(["kill-window", "-t", bootstrapWindowId], true);
      }
    }
  }

  #configureServer(): Promise<void> {
    this.#serverConfiguration ??= (async () => {
      await this.#tmux(["set-option", "-g", "remain-on-exit", "on"]);
      await this.#tmux(["set-option", "-g", "mouse", "on"]);
      await this.#tmux(["set-option", "-g", "extended-keys", "on"]);
      await this.#tmux(["set-option", "-g", "set-clipboard", "external"]);
      const passthrough = await this.#tmux(
        ["set-option", "-w", "-g", "allow-passthrough", "off"],
        true,
      );
      if (passthrough.exitCode === 0) this.#passthroughSupported = true;
      else if (!/(?:unknown|invalid) option/i.test(passthrough.stderr)) {
        throw new Error(
          passthrough.stderr.trim() ||
            `tmux allow-passthrough probe exited with code ${passthrough.exitCode}`,
        );
      }
      for (const [hook, command] of Object.entries(this.#invalidationHooks)) {
        await this.#tmux(["set-hook", "-g", hook, `run-shell -b ${shellQuote(command)}`]);
      }
      const terminalFeatures = await this.#tmux(["show-options", "-gv", "terminal-features"], true);
      if (!terminalFeatures.stdout.includes("xterm-256color:extkeys")) {
        await this.#tmux(["set-option", "-as", "terminal-features", ",xterm-256color:extkeys"]);
      }
      // tmux 3.5+ supports CSI-u. Older supported versions use modifyOtherKeys,
      // which Pi also understands.
      await this.#tmux(["set-option", "-g", "extended-keys-format", "csi-u"], true);
    })().catch((error: unknown) => {
      this.#serverConfiguration = undefined;
      throw error;
    });
    return this.#serverConfiguration;
  }

  async #enableOwnedPassthrough(run: AgentRun): Promise<void> {
    await this.#configureServer();
    if (!this.#passthroughSupported) return;
    await this.#ownedPaneStatus(run, true, true);
    await this.#tmux(["set-option", "-w", "-t", run.terminal!.windowId, "allow-passthrough", "on"]);
  }

  async #tmux(args: string[], allowFailure = false, stdin?: string): Promise<CommandOutput> {
    const result = await new Promise<CommandOutput>((resolve, reject) => {
      const child = spawn(this.#tmuxPath, ["-L", this.serverName, "-f", "/dev/null", ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: exitCode ?? 1,
        });
      });
      child.stdin.end(stdin);
    });
    if (!allowFailure && result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim().length > 0
          ? `tmux ${args[0] ?? "command"} failed: ${result.stderr.trim()}`
          : `tmux ${args[0] ?? "command"} exited with code ${result.exitCode}`,
      );
    }
    return result;
  }

  async #ownedPaneStatus(
    run: AgentRun,
    allowCopyMode = false,
    allowStarting = false,
  ): Promise<OwnedPaneStatus> {
    const binding = run.terminal;
    if (
      (run.status !== "running" &&
        !(allowStarting && (run.status === "starting" || run.status === "stopping"))) ||
      binding === undefined ||
      binding.serverName !== this.serverName
    ) {
      throw new Error("terminal_run_unavailable");
    }
    const result = await this.#tmux(
      [
        "list-panes",
        "-t",
        `${binding.sessionId}:${binding.windowId}`,
        "-F",
        "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_in_mode}\t#{alternate_on}\t#{pane_current_command}\t#{@nanasa-run-id}\t#{@nanasa-generation}",
      ],
      true,
    );
    if (result.exitCode !== 0) throw new Error("terminal_owner_pane_unavailable");
    const pane = result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, , paneId]) => paneId === binding.paneId);
    if (pane === undefined) throw new Error("terminal_owner_pane_mismatch");
    const [
      sessionId,
      windowId,
      paneId,
      dead,
      inMode,
      alternateOn,
      currentCommand,
      runId,
      generation,
    ] = pane;
    if (
      sessionId !== binding.sessionId ||
      windowId !== binding.windowId ||
      paneId !== binding.paneId ||
      runId !== run.id ||
      generation !== String(run.generation) ||
      dead !== "0" ||
      currentCommand === undefined ||
      currentCommand.length === 0
    ) {
      throw new Error("terminal_owner_pane_mismatch");
    }
    if (inMode !== "0" && !allowCopyMode) throw new Error("terminal_pane_in_copy_mode");
    return {
      dead: false,
      inMode: inMode !== "0",
      alternateOn: alternateOn === "1",
      currentCommand,
    };
  }
}
