import type {
  AgentRun,
  DeliveryMode,
  EffectiveDeliveryModes,
  GroupMembership,
  StartGroupRunsCommand,
  StartGroupRunsResult,
} from "@nanasa/contracts";

import { AgentRuntimeSupervisor } from "./agent-runtime-supervisor.js";
import { DeliveryDispatcher } from "./delivery-dispatcher.js";
import { DomainError, NanasaStore } from "./store.js";
import { TmuxRuntime } from "./tmux-runtime.js";
import { TtydSupervisor } from "./ttyd-supervisor.js";

export interface RunRuntimeCoordinatorOptions {
  reconcileIntervalMs?: number;
  recoveryMaxAttempts?: number;
  recoveryCooldownMs?: readonly number[];
  now?: () => Date;
}

const RECOVERY_TERMINAL_SIZE = { cols: 120, rows: 40 } as const;

export class RunRuntimeCoordinator {
  readonly #store: NanasaStore;
  readonly #runtime: TmuxRuntime;
  readonly #supervisor: TtydSupervisor;
  readonly #agentSupervisor: AgentRuntimeSupervisor;
  readonly #dispatcher: DeliveryDispatcher;
  readonly #reconcileTimer: NodeJS.Timeout;
  readonly #recoveryMaxAttempts: number;
  readonly #recoveryCooldownMs: readonly number[];
  readonly #now: () => Date;
  #pending: Promise<void> = Promise.resolve();
  #closing = false;

  public constructor(
    store: NanasaStore,
    runtime: TmuxRuntime,
    supervisor: TtydSupervisor,
    agentSupervisor: AgentRuntimeSupervisor,
    dispatcher: DeliveryDispatcher,
    options: RunRuntimeCoordinatorOptions = {},
  ) {
    this.#store = store;
    this.#runtime = runtime;
    this.#supervisor = supervisor;
    this.#agentSupervisor = agentSupervisor;
    this.#dispatcher = dispatcher;
    this.#recoveryMaxAttempts = options.recoveryMaxAttempts ?? 3;
    this.#recoveryCooldownMs = options.recoveryCooldownMs ?? [1_000, 5_000, 30_000];
    this.#now = options.now ?? (() => new Date());
    this.#reconcileTimer = setInterval(
      () => void this.reconcile().catch(() => undefined),
      options.reconcileIntervalMs ?? 1_000,
    );
    this.#reconcileTimer.unref();
  }

  public start(): void {
    this.#dispatcher.start();
  }

  public startRun(
    groupId: string,
    memberId: string,
    size: { cols: number; rows: number },
  ): Promise<AgentRun> {
    return this.#serialize(() => this.#startRun(groupId, memberId, size));
  }

  public startAll(
    groupId: string,
    command: StartGroupRunsCommand,
    idempotencyKey?: string,
  ): Promise<StartGroupRunsResult> {
    return this.#serialize(async () => {
      const replay = this.#store.getGroupStartAllResult(groupId, idempotencyKey);
      if (replay !== undefined) return replay;
      const outcomes: StartGroupRunsResult["outcomes"] = [];
      for (const membership of this.#store.listActiveMemberships(groupId)) {
        const active = this.#store.getActiveRun(groupId, membership.memberId);
        if (active?.status === "running" || active?.status === "starting") {
          outcomes.push({
            groupId,
            memberId: membership.memberId,
            status: "already-running",
            runId: active.id,
          });
          continue;
        }
        if (active?.status === "stopping") {
          outcomes.push({
            groupId,
            memberId: membership.memberId,
            status: "failed",
            runId: active.id,
            reason: "run_stopping",
          });
          continue;
        }
        try {
          const run = await this.#startRun(groupId, membership.memberId, command);
          outcomes.push({
            groupId,
            memberId: membership.memberId,
            status: "started",
            runId: run.id,
          });
        } catch (error) {
          const failedRun = this.#store.getLatestRunForMembership(groupId, membership.memberId);
          outcomes.push({
            groupId,
            memberId: membership.memberId,
            status: "failed",
            ...(failedRun === undefined ? {} : { runId: failedRun.id }),
            reason:
              error instanceof DomainError
                ? error.code
                : error instanceof Error
                  ? error.message
                  : "run_start_failed",
          });
        }
      }
      return this.#store.recordGroupStartAllResult({ groupId, outcomes }, idempotencyKey);
    });
  }

  public removeMembership(
    groupId: string,
    memberId: string,
    idempotencyKey?: string,
  ): Promise<GroupMembership> {
    return this.#serialize(async () => {
      if (this.#store.getActiveRun(groupId, memberId) !== undefined) {
        await this.#stopRun(groupId, memberId);
      }
      return this.#store.removeMembership(groupId, memberId, idempotencyKey);
    });
  }

  public stopRun(groupId: string, memberId: string): Promise<AgentRun> {
    return this.#serialize(() => this.#stopRun(groupId, memberId));
  }

  public interrupt(runId: string): Promise<void> {
    return this.#serialize(async () => {
      const run = this.#store.getRun(runId);
      if (run.status !== "running") {
        throw new DomainError("run_not_running", "The run is not running", 409);
      }
      const profile = this.#store.getAgentProfile(run.agentProfileId);
      if (this.#agentSupervisor.status(run, profile).readiness !== "ready") {
        throw new DomainError("adapter_unavailable", "The run adapter is unavailable", 503);
      }
      await this.#agentSupervisor.interrupt(run);
    });
  }

  public adapterStatus(runId: string) {
    const run = this.#store.getRun(runId);
    const profile = this.#store.getAgentProfile(run.agentProfileId);
    return this.#agentSupervisor.status(run, profile);
  }

  public async effectiveDeliveryModes(
    groupId: string,
    memberIds: string[],
  ): Promise<EffectiveDeliveryModes> {
    let modes = new Set<DeliveryMode>(["queue", "steer"]);
    let terminalAvailable = true;
    for (const memberId of memberIds) {
      const target = this.#store.getActiveDeliveryTarget(groupId, memberId);
      if (target === undefined) {
        return { memberIds, modes: [] };
      }
      const status = this.#agentSupervisor.status(target.run, target.profile);
      const supported =
        status.readiness === "ready" ? new Set<DeliveryMode>(status.capabilities) : new Set();
      modes = new Set([...modes].filter((mode) => supported.has(mode)));
      terminalAvailable =
        terminalAvailable && (await this.#agentSupervisor.terminalAvailable(target.run));
    }
    return { memberIds, modes: [...modes, ...(terminalAvailable ? (["terminal"] as const) : [])] };
  }

  public reconcile(markOrphanedStarting = false): Promise<void> {
    if (this.#closing) {
      return Promise.resolve();
    }
    return this.#serialize(async () => {
      await this.#runtime.reconcile(markOrphanedStarting);
      const afterTmux = this.#store.listActiveRuns();
      for (const run of afterTmux.filter((candidate) => candidate.status === "stopping")) {
        await this.#supervisor.stop(run.id);
        await this.#runtime.removeViewSession(run.id);
        await this.#runtime.stopRun(run.groupId, run.memberId);
      }
      const recoveredRuns: AgentRun[] = [];
      for (const persisted of this.#store.listDesiredRunningRuns()) {
        if (await this.#runtime.isCurrentRun(persisted)) {
          let current = persisted;
          if (markOrphanedStarting || persisted.recoveryPhase !== "recovered") {
            current = this.#store.transitionRunRecovery(
              persisted.id,
              persisted.generation,
              "reconciling",
              { reason: markOrphanedStarting ? "daemon_restart" : "runtime_reconcile" },
            );
          }
          recoveredRuns.push(current);
          continue;
        }
        const replacement = await this.#recoverMissingRun(persisted);
        if (replacement !== undefined) recoveredRuns.push(replacement);
      }
      const running = recoveredRuns.filter(
        (run) => run.status === "running" && run.terminal !== undefined,
      );
      await this.#agentSupervisor.reconcile(
        running.map((run) => ({
          run,
          profile: this.#store.getAgentProfile(run.agentProfileId),
        })),
      );
      await this.#runtime.removeStaleViewSessions(new Set(running.map((run) => run.id)));
      const readyForTtyd: AgentRun[] = [];
      for (const run of running) {
        try {
          await this.#runtime.ensureViewSession(run);
          readyForTtyd.push(run);
        } catch (error) {
          await this.#supervisor.stop(run.id);
          this.#supervisor.unavailable(run, error);
        }
      }
      await this.#supervisor.reconcile(readyForTtyd);
      for (const run of readyForTtyd) {
        const profile = this.#store.getAgentProfile(run.agentProfileId);
        const adapter = this.#agentSupervisor.status(run, profile);
        if (run.recoveryPhase === "recovered" && adapter.readiness !== "unavailable") {
          continue;
        }
        try {
          this.#store.transitionRunRecovery(
            run.id,
            run.generation,
            adapter.readiness === "unavailable" ? "failed" : "recovered",
            {
              reason:
                adapter.readiness === "unavailable"
                  ? (adapter.reason ?? "adapter_unavailable")
                  : "runtime_recovered",
            },
          );
        } catch (error) {
          if (!(error instanceof DomainError && error.code === "recovery_generation_fenced")) {
            throw error;
          }
        }
      }
    });
  }

  public async close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#reconcileTimer);
    await this.#pending;
    await this.#dispatcher.close();
    await this.#agentSupervisor.close();
    await this.#supervisor.close();
    await this.#runtime.close();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #startRun(
    groupId: string,
    memberId: string,
    size: { cols: number; rows: number },
  ): Promise<AgentRun> {
    const run = await this.#runtime.startRun(groupId, memberId, size);
    const profile = this.#store.getAgentProfile(run.agentProfileId);
    await this.#agentSupervisor.start(run, profile).catch(() => undefined);
    try {
      await this.#runtime.ensureViewSession(run);
      this.#supervisor.start(run);
    } catch (error) {
      this.#supervisor.unavailable(run, error);
    }
    return run;
  }

  async #stopRun(groupId: string, memberId: string): Promise<AgentRun> {
    const run = this.#store.getActiveRun(groupId, memberId);
    if (run === undefined) {
      const latest = this.#store.getLatestRunForMembership(groupId, memberId);
      if (latest === undefined || latest.desiredState !== "running") {
        throw new DomainError("active_run_not_found", "The member has no active run", 404);
      }
      return this.#store.stopDesiredRun(latest.id, latest.generation);
    }
    if (run.status !== "stopping") {
      this.#store.updateRunStatus(run.id, "stopping");
    }
    await this.#agentSupervisor.shutdownRun(run.id);
    await this.#supervisor.stop(run.id);
    await this.#runtime.removeViewSession(run.id);
    return this.#runtime.stopRun(groupId, memberId);
  }

  async #recoverMissingRun(run: AgentRun): Promise<AgentRun | undefined> {
    if (run.recoveryAttempts >= this.#recoveryMaxAttempts) {
      if (run.recoveryPhase !== "failed") {
        this.#store.transitionRunRecovery(run.id, run.generation, "failed", {
          reason: "recovery_attempts_exhausted",
        });
      }
      return undefined;
    }
    const now = this.#now();
    if (run.recoveryNotBefore !== undefined && Date.parse(run.recoveryNotBefore) > now.getTime()) {
      return undefined;
    }
    const profile = this.#store.getAgentProfile(run.agentProfileId);
    const policy = this.#store.getRecoveryPolicy(profile.id);
    const preserveAdapterSession =
      policy === "resume-or-restart" &&
      profile.adapter !== "terminal" &&
      run.adapterSession !== undefined;
    let current = run;
    if (run.recoveryPhase !== "reconciling") {
      current = this.#store.transitionRunRecovery(run.id, run.generation, "reconciling", {
        reason: "owner_pane_missing",
      });
    }
    const nextAttempt = current.recoveryAttempts + 1;
    const cooldown =
      this.#recoveryCooldownMs[Math.min(nextAttempt - 1, this.#recoveryCooldownMs.length - 1)] ??
      30_000;
    current = this.#store.transitionRunRecovery(
      current.id,
      current.generation,
      preserveAdapterSession ? "resuming" : "restarting",
      {
        incrementAttempt: true,
        recoveryNotBefore: new Date(now.getTime() + cooldown).toISOString(),
        reason: preserveAdapterSession ? "adapter_session_resume" : "process_restart",
      },
    );
    try {
      await this.#agentSupervisor.closeRun(current.id);
      await this.#supervisor.stop(current.id);
      await this.#runtime.removeViewSession(current.id);
      return await this.#runtime.recoverRun(
        current,
        preserveAdapterSession,
        RECOVERY_TERMINAL_SIZE,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "recovery_launch_failed";
      this.#store.recordRuntimeEvent("run.recovery-failed", "run", current.id, {
        generation: current.generation,
        reason,
      });
      const latest = this.#store
        .listDesiredRunningRuns()
        .find(
          (candidate) =>
            candidate.groupId === current.groupId && candidate.memberId === current.memberId,
        );
      if (latest !== undefined) {
        this.#store.transitionRunRecovery(
          latest.id,
          latest.generation,
          latest.recoveryAttempts >= this.#recoveryMaxAttempts ? "failed" : "reconciling",
          {
            reason,
          },
        );
      }
      return undefined;
    }
  }
}
