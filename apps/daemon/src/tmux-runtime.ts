import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentProfile, AgentRun, GroupMembership, TerminalBinding } from "@nanasa/contracts";

import type { AgentRuntimeProvisioner } from "./agent-runtime-provisioner.js";
import { DomainError, NanasaStore } from "./store.js";
import { ttydViewSessionName } from "./ttyd-supervisor.js";

export interface TmuxRuntimeOptions {
  serverName?: string;
  tmuxPath?: string;
  runtimeEnvironment?: (run: AgentRun) => Record<string, string>;
  runtimeProvisioner?: AgentRuntimeProvisioner;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OwnedPaneStatus {
  dead: boolean;
  inMode: boolean;
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
  readonly #runtimeEnvironment: (run: AgentRun) => Record<string, string>;
  readonly #runtimeProvisioner: AgentRuntimeProvisioner | undefined;
  readonly #reconciliations = new Set<Promise<void>>();
  #closing = false;

  public constructor(store: NanasaStore, options: TmuxRuntimeOptions = {}) {
    this.#store = store;
    this.serverName = options.serverName ?? "nanasa";
    this.#tmuxPath = options.tmuxPath ?? "tmux";
    this.#runtimeEnvironment = options.runtimeEnvironment ?? (() => ({}));
    this.#runtimeProvisioner = options.runtimeProvisioner;
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
      current.recoveryReason === "terminal_runtime_migration" &&
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
      { recoveryFrom: current },
    );
    return this.#launchCreatedRun(run, profile, membership, size);
  }

  async #launchCreatedRun(
    run: AgentRun,
    profile: AgentProfile,
    membership: GroupMembership,
    size: { cols: number; rows: number },
  ): Promise<AgentRun> {
    let binding: TerminalBinding | undefined;
    try {
      binding = await this.#launch(run, profile, membership, size);
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
    const viewSession = ttydViewSessionName(run.id);
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
    await this.#tmux(["set-option", "-g", "mouse", "on"]);
    await this.#tmux(["set-option", "-w", "-t", `${viewSession}:1`, "window-size", "latest"]);
    if (!(await this.#viewMatches(viewSession, binding))) {
      throw new Error(`tmux view session ${viewSession} does not match its owner pane`);
    }
    return viewSession;
  }

  public async removeViewSession(runId: string): Promise<void> {
    await this.#tmux(["kill-session", "-t", `=${ttydViewSessionName(runId)}`], true);
  }

  public async removeStaleViewSessions(activeRunIds: ReadonlySet<string>): Promise<void> {
    const desired = new Set([...activeRunIds].map(ttydViewSessionName));
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
    const submitInput =
      this.#store.getAgentProfile(run.agentProfileId).kind === "copilot" ? "\u001b[I\r" : "\r";
    const bufferName = `nanasa-${randomUUID()}`;
    await this.#tmux(["load-buffer", "-b", bufferName, "-"], false, text);
    try {
      await this.#tmux(["paste-buffer", "-b", bufferName, "-d", "-p", "-t", target]);
      await delay(TERMINAL_SUBMIT_DELAY_MS);
      await this.#tmux(["load-buffer", "-b", bufferName, "-"], false, submitInput);
      await this.#tmux(["paste-buffer", "-b", bufferName, "-d", "-t", target]);
    } finally {
      await this.#tmux(["delete-buffer", "-b", bufferName], true);
    }
  }

  public async isCurrentRun(run: AgentRun): Promise<boolean> {
    try {
      await this.#ownedPaneStatus(run, true);
      return true;
    } catch {
      return false;
    }
  }

  public async interruptRun(run: AgentRun): Promise<void> {
    await this.#ownedPaneStatus(run);
    await this.#tmux(["send-keys", "-t", terminalInputTarget(run.terminal!), "C-c"]);
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
  ): Promise<TerminalBinding> {
    const environmentArguments: string[] = [];
    const provisioned = this.#runtimeProvisioner?.provision(membership, profile);
    const environment = {
      ...profile.environment,
      ...this.#runtimeEnvironment(run),
      ...provisioned?.environment,
    };
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
    const launchArguments = provisioned?.command ?? [profile.command, ...profile.args];
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
      await this.#tmux(["set-option", "-g", "remain-on-exit", "on"]);
      await this.#tmux(["set-option", "-g", "mouse", "on"]);
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
      if (profile.workingDirectory !== undefined) {
        args.push("-c", profile.workingDirectory);
      }
      args.push(...environmentArguments, `exec ${launchCommand}`);
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
        "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_in_mode}\t#{pane_current_command}\t#{@nanasa-run-id}\t#{@nanasa-generation}",
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
    const [sessionId, windowId, paneId, dead, inMode, currentCommand, runId, generation] = pane;
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
    return { dead: false, inMode: inMode !== "0", currentCommand };
  }
}
