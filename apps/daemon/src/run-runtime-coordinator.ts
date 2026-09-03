import type {
  AgentRun,
  DeleteGroupResult,
  GroupMembership,
  NativeRecoveryPolicy,
  ProviderUpdateOutcome,
  ProviderUpdateRecoveryCommand,
  StartAgentRunResult,
  StartGroupRunsCommand,
  StartGroupRunsResult,
} from "@nanasa/contracts";

import { DeliveryDispatcher } from "./delivery-dispatcher.js";
import { errorPayloadFromUnknown } from "./http/error-response.js";
import { NativeSessionService } from "./native-session-service.js";
import type { RuntimeObservation } from "./runtime-observation.js";
import { DomainError, NanasaStore } from "./store.js";
import { TerminalGateway } from "./terminal/terminal-gateway.js";
import { TmuxRuntime } from "./tmux-runtime.js";

export interface RuntimeLaunchConsentGate {
  resolve(
    groupId: string,
    memberId: string,
  ): Promise<
    | { readonly status: "built-in" | "trusted" }
    | Extract<StartAgentRunResult, { status: "approval-required" | "denied" }>
  >;
  resolveForAutomaticRecovery(
    groupId: string,
    memberId: string,
  ): Promise<{ readonly status: "built-in" | "trusted" | "approval-required" | "denied" }>;
  inspectForRecovery(
    groupId: string,
    memberId: string,
  ): Promise<{ readonly status: "built-in" | "trusted" | "approval-required" | "denied" }>;
}

export interface RunRuntimeCoordinatorOptions {
  reconcileIntervalMs?: number;
  recoveryMaxAttempts?: number;
  recoveryCooldownMs?: readonly number[];
  now?: () => Date;
  nativeSessions?: NativeSessionService;
  nativeRecoveryPolicy?: (run: AgentRun) => {
    integrationId: string;
    policy: NativeRecoveryPolicy;
  };
  launchConsent?: RuntimeLaunchConsentGate;
  providerUpdates?: {
    reconcile(runs: readonly AgentRun[]): Promise<{ readonly handledRunIds: ReadonlySet<string> }>;
    recover(
      runs: readonly AgentRun[],
      command: ProviderUpdateRecoveryCommand,
    ): Promise<{
      readonly outcomes: readonly ProviderUpdateOutcome[];
      readonly handledRunIds: ReadonlySet<string>;
    }>;
  };
  onRuntimeObservation?: (observation: RuntimeObservation) => void | Promise<void>;
}

const RECOVERY_TERMINAL_SIZE = { cols: 120, rows: 40 } as const;
const STATUS_PROBE_INTERVAL_MS = 15_000;

export class RunRuntimeCoordinator {
  readonly #store: NanasaStore;
  readonly #runtime: TmuxRuntime;
  readonly #supervisor: TerminalGateway;
  readonly #dispatcher: DeliveryDispatcher;
  readonly #reconcileTimer: NodeJS.Timeout;
  readonly #recoveryMaxAttempts: number;
  readonly #recoveryCooldownMs: readonly number[];
  readonly #now: () => Date;
  readonly #nativeSessions: NativeSessionService | undefined;
  readonly #nativeRecoveryPolicy: RunRuntimeCoordinatorOptions["nativeRecoveryPolicy"];
  readonly #launchConsent: RuntimeLaunchConsentGate | undefined;
  readonly #providerUpdates: RunRuntimeCoordinatorOptions["providerUpdates"];
  readonly #onRuntimeObservation: RunRuntimeCoordinatorOptions["onRuntimeObservation"];
  #pending: Promise<void> = Promise.resolve();
  #closing = false;
  #lastStatusProbeAt = 0;
  readonly #missingConfirmations = new Map<string, number>();

  public constructor(
    store: NanasaStore,
    runtime: TmuxRuntime,
    supervisor: TerminalGateway,
    dispatcher: DeliveryDispatcher,
    options: RunRuntimeCoordinatorOptions = {},
  ) {
    this.#store = store;
    this.#runtime = runtime;
    this.#supervisor = supervisor;
    this.#dispatcher = dispatcher;
    this.#recoveryMaxAttempts = options.recoveryMaxAttempts ?? 3;
    this.#recoveryCooldownMs = options.recoveryCooldownMs ?? [1_000, 5_000, 30_000];
    this.#now = options.now ?? (() => new Date());
    this.#nativeSessions = options.nativeSessions;
    this.#nativeRecoveryPolicy = options.nativeRecoveryPolicy;
    this.#launchConsent = options.launchConsent;
    this.#providerUpdates = options.providerUpdates;
    this.#onRuntimeObservation = options.onRuntimeObservation;
    this.#reconcileTimer = setInterval(
      () => void this.reconcile().catch(() => undefined),
      options.reconcileIntervalMs ?? 1_000,
    );
    this.#reconcileTimer.unref();
  }

  public start(): void {
    this.#dispatcher.start();
  }

  public recoverProviderUpdates(
    runs: readonly AgentRun[],
    command: ProviderUpdateRecoveryCommand,
  ): Promise<{ readonly outcomes: readonly ProviderUpdateOutcome[] }> {
    return this.#serialize(async () => {
      if (this.#providerUpdates === undefined) {
        throw new DomainError(
          "provider_update_recovery_unavailable",
          "Provider update recovery is not available",
          503,
        );
      }
      return this.#providerUpdates.recover(runs, command);
    });
  }

  public startRun(
    groupId: string,
    memberId: string,
    size: { cols: number; rows: number },
  ): Promise<StartAgentRunResult> {
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
          const result = await this.#startRun(groupId, membership.memberId, command);
          if (result.status === "approval-required" || result.status === "denied") {
            outcomes.push({
              groupId,
              memberId: membership.memberId,
              status: result.status,
              request: result.request,
            });
            continue;
          }
          outcomes.push({
            groupId,
            memberId: membership.memberId,
            status: "started",
            runId: result.run.id,
          });
        } catch (error) {
          const failedRun = this.#store.getLatestRunForMembership(groupId, membership.memberId);
          const failure = errorPayloadFromUnknown(
            error,
            "run_start_failed",
            "The agent could not be started",
          );
          outcomes.push({
            groupId,
            memberId: membership.memberId,
            status: "failed",
            ...(failedRun === undefined ? {} : { runId: failedRun.id }),
            reason: failure.code,
            error: failure,
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
      const active = this.#store.getActiveRun(groupId, memberId);
      const latest =
        active === undefined ? this.#store.getLatestRunForMembership(groupId, memberId) : undefined;
      if (active !== undefined || latest?.desiredState === "running") {
        await this.#stopRun(groupId, memberId);
      }
      return this.#store.removeMembership(groupId, memberId, idempotencyKey);
    });
  }

  public deleteGroup(groupId: string, idempotencyKey?: string): Promise<DeleteGroupResult> {
    return this.#serialize(async () => {
      const replay = this.#store.getDeleteGroupResult(groupId, idempotencyKey);
      if (replay !== undefined) return replay;
      for (const run of this.#store.listGroupRunsRequiringStop(groupId)) {
        await this.#stopRun(groupId, run.memberId);
      }
      return this.#store.deleteGroup(groupId, idempotencyKey);
    });
  }

  public stopRun(groupId: string, memberId: string): Promise<AgentRun> {
    return this.#serialize(() => this.#stopRun(groupId, memberId));
  }

  public restartRun(
    runId: string,
    size: { cols: number; rows: number },
  ): Promise<StartAgentRunResult> {
    return this.#serialize(async () => {
      const current = this.#store.getRun(runId);
      const active = this.#store.getActiveRun(current.groupId, current.memberId);
      if (active?.id !== current.id) {
        throw new DomainError("run_replaced", "The run was replaced", 409);
      }
      const consent = await this.#resolveConsent(current.groupId, current.memberId);
      if (consent !== undefined) return consent;
      await this.#stopRun(current.groupId, current.memberId);
      return this.#launchRun(current.groupId, current.memberId, size);
    });
  }

  public stopAll(groupId: string): Promise<AgentRun[]> {
    return this.#serialize(async () => {
      this.#store.getGroup(groupId);
      const stopped: AgentRun[] = [];
      for (const run of this.#store.listGroupRunsRequiringStop(groupId)) {
        stopped.push(await this.#stopRun(groupId, run.memberId));
      }
      return stopped;
    });
  }

  public restartAll(
    groupId: string,
    size: { cols: number; rows: number },
  ): Promise<StartGroupRunsResult> {
    return this.#serialize(async () => {
      this.#store.getGroup(groupId);
      const outcomes: StartGroupRunsResult["outcomes"] = [];
      for (const run of this.#store.listGroupRunsRequiringStop(groupId)) {
        try {
          const consent = await this.#resolveConsent(groupId, run.memberId);
          if (consent !== undefined) {
            outcomes.push({
              groupId,
              memberId: run.memberId,
              status: consent.status,
              request: consent.request,
            });
            continue;
          }
          await this.#stopRun(groupId, run.memberId);
          const result = await this.#launchRun(groupId, run.memberId, size);
          outcomes.push({
            groupId,
            memberId: run.memberId,
            status: "started",
            runId: result.run.id,
          });
        } catch (error) {
          const failure = errorPayloadFromUnknown(
            error,
            "run_restart_failed",
            "The agent could not be restarted",
          );
          outcomes.push({
            groupId,
            memberId: run.memberId,
            status: "failed",
            runId: run.id,
            reason: failure.code,
            error: failure,
          });
        }
      }
      return { groupId, outcomes };
    });
  }

  public interrupt(runId: string): Promise<void> {
    return this.#serialize(async () => {
      const run = this.#store.getRun(runId);
      if (run.status !== "running") {
        throw new DomainError("run_not_running", "The run is not running", 409);
      }
      try {
        await this.#runtime.interruptRun(run);
      } catch (error) {
        throw new DomainError(
          "terminal_unavailable",
          error instanceof Error ? error.message : "The run terminal is unavailable",
          503,
        );
      }
    });
  }

  public reconcile(markOrphanedStarting = false): Promise<void> {
    if (this.#closing) {
      return Promise.resolve();
    }
    return this.#serialize(async () => {
      await this.#runtime.reconcile(markOrphanedStarting);
      const providerUpdates = await this.#providerUpdates?.reconcile(
        this.#store.listDesiredRunningRuns(),
      );
      const afterTmux = this.#store.listActiveRuns();
      const probeNow = this.#now();
      if (probeNow.getTime() - this.#lastStatusProbeAt >= STATUS_PROBE_INTERVAL_MS) {
        const probeTime = probeNow.toISOString();
        this.#lastStatusProbeAt = probeNow.getTime();
        for (const run of afterTmux.filter((candidate) =>
          ["starting", "running"].includes(candidate.status),
        )) {
          this.#store.recordProcessStatus(run.id, {
            event: "lease.probed",
            eventId: `lease-probe-${run.generation}-${probeTime}`,
            observedAt: probeTime,
          });
        }
      }
      for (const run of afterTmux.filter((candidate) => candidate.status === "stopping")) {
        await this.#supervisor.stop(run.id);
        await this.#runtime.removeViewSession(run.id);
        await this.#runtime.stopRun(run.groupId, run.memberId);
      }
      const recoveredRuns: AgentRun[] = [];
      for (const persisted of this.#store
        .listDesiredRunningRuns()
        .filter((run) => providerUpdates?.handledRunIds.has(run.id) !== true)) {
        const observationKey = `${persisted.id}:${persisted.generation}`;
        const observation = await this.#runtime.observeRun(persisted);
        await this.#onRuntimeObservation?.(observation);
        if (observation.state === "present") {
          this.#missingConfirmations.delete(observationKey);
          let current = persisted;
          if (markOrphanedStarting && persisted.recoveryPhase !== "resuming") {
            current = this.#store.updateRunProviderMetadata(persisted.id, {
              launchKind: "adopted",
              recoveryOutcome: "retained",
            });
          }
          if (persisted.recoveryPhase === "resuming") {
            if (
              persisted.nativeSessionId !== undefined &&
              this.#nativeSessions?.isConfirmed(persisted.nativeSessionId, persisted.id) === true
            ) {
              current = this.#store.updateRunProviderMetadata(persisted.id, {
                launchKind: "resuming",
                recoveryOutcome: "resumed",
              });
              current = this.#store.transitionRunRecovery(
                current.id,
                current.generation,
                "recovered",
                { reason: "native_session_confirmed" },
              );
            } else {
              const recovery = this.#nativeRecoveryPolicy?.(persisted);
              const timeoutMs = (recovery?.policy.confirmationTimeoutSeconds ?? 30) * 1_000;
              if (this.#now().getTime() - Date.parse(persisted.startedAt) >= timeoutMs) {
                if (recovery?.policy.mode === "resume-only") {
                  this.#store.updateRunProviderMetadata(persisted.id, {
                    recoveryOutcome: "failed",
                  });
                  this.#store.transitionRunRecovery(persisted.id, persisted.generation, "failed", {
                    reason: "native_resume_confirmation_timeout",
                  });
                  continue;
                }
                const replacement = await this.#recoverMissingRun(persisted, true);
                if (replacement !== undefined) recoveredRuns.push(replacement);
                continue;
              }
            }
          }
          if (markOrphanedStarting || persisted.recoveryPhase !== "recovered") {
            if (current.recoveryPhase !== "resuming" && current.recoveryPhase !== "recovered") {
              current = this.#store.transitionRunRecovery(
                persisted.id,
                persisted.generation,
                "reconciling",
                { reason: markOrphanedStarting ? "daemon_restart" : "runtime_reconcile" },
              );
            }
          }
          recoveredRuns.push(current);
          continue;
        }
        if (observation.state === "indeterminate") {
          this.#missingConfirmations.delete(observationKey);
          continue;
        }
        if (observation.state === "missing") {
          const confirmations = (this.#missingConfirmations.get(observationKey) ?? 0) + 1;
          this.#missingConfirmations.set(observationKey, confirmations);
          if (confirmations < 2) continue;
          const finalObservation = await this.#runtime.observeRun(persisted);
          await this.#onRuntimeObservation?.(finalObservation);
          if (finalObservation.state !== "missing" && finalObservation.state !== "dead") {
            this.#missingConfirmations.delete(observationKey);
            if (finalObservation.state === "present") recoveredRuns.push(persisted);
            continue;
          }
        }
        this.#missingConfirmations.delete(observationKey);
        const replacement = await this.#recoverMissingRun(persisted);
        if (replacement !== undefined) recoveredRuns.push(replacement);
      }
      const running = recoveredRuns.filter(
        (run) => run.status === "running" && run.terminal !== undefined,
      );
      await this.#runtime.removeStaleViewSessions(new Set(running.map((run) => run.id)));
      const readyForGateway: AgentRun[] = [];
      for (const run of running) {
        try {
          await this.#runtime.ensureViewSession(run);
          readyForGateway.push(run);
        } catch {
          await this.#supervisor.stop(run.id);
          this.#supervisor.unavailable(run);
        }
      }
      await this.#supervisor.reconcile(readyForGateway);
      for (const run of readyForGateway) {
        if (run.recoveryPhase === "recovered" || run.recoveryPhase === "resuming") continue;
        try {
          this.#store.transitionRunRecovery(run.id, run.generation, "recovered", {
            reason: "runtime_recovered",
          });
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
  ): Promise<StartAgentRunResult> {
    const consent = await this.#resolveConsent(groupId, memberId);
    if (consent !== undefined) return consent;
    return this.#launchRun(groupId, memberId, size);
  }

  async #resolveConsent(
    groupId: string,
    memberId: string,
  ): Promise<Extract<StartAgentRunResult, { status: "approval-required" | "denied" }> | undefined> {
    const consent = await this.#launchConsent?.resolve(groupId, memberId);
    return consent?.status === "approval-required" || consent?.status === "denied"
      ? consent
      : undefined;
  }

  async #launchRun(
    groupId: string,
    memberId: string,
    size: { cols: number; rows: number },
  ): Promise<Extract<StartAgentRunResult, { status: "started" }>> {
    const run = await this.#runtime.startRun(groupId, memberId, size);
    try {
      await this.#runtime.ensureViewSession(run);
      this.#supervisor.start(run);
    } catch {
      this.#supervisor.unavailable(run);
    }
    return { status: "started", run };
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
    await this.#supervisor.stop(run.id);
    await this.#runtime.removeViewSession(run.id);
    return this.#runtime.stopRun(groupId, memberId);
  }

  async #recoverMissingRun(run: AgentRun, forceFresh = false): Promise<AgentRun | undefined> {
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
    const consent = await this.#launchConsent?.resolveForAutomaticRecovery(
      run.groupId,
      run.memberId,
    );
    if (consent?.status === "approval-required" || consent?.status === "denied") {
      const reason =
        consent.status === "denied" ? "launch_consent_denied" : "launch_consent_required";
      let blocked = run;
      if (blocked.status !== "failed") {
        blocked = this.#store.updateRunStatus(blocked.id, "failed", { reason });
      }
      if (blocked.recoveryPhase !== "failed") {
        this.#store.transitionRunRecovery(blocked.id, blocked.generation, "failed", { reason });
      }
      return undefined;
    }
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
    const recovery = this.#nativeRecoveryPolicy?.(current);
    const reservation =
      forceFresh || recovery?.policy.mode === "restart"
        ? undefined
        : this.#nativeSessions?.reserve(
            current.memberId,
            recovery?.integrationId ?? "",
            current.id,
          );
    if (reservation === undefined && recovery?.policy.mode === "resume-only" && !forceFresh) {
      this.#store.updateRunProviderMetadata(current.id, { recoveryOutcome: "failed" });
      this.#store.transitionRunRecovery(current.id, current.generation, "failed", {
        reason: "native_session_unavailable",
      });
      return undefined;
    }
    current = this.#store.transitionRunRecovery(
      current.id,
      current.generation,
      reservation === undefined ? "restarting" : "resuming",
      {
        incrementAttempt: true,
        recoveryNotBefore: new Date(now.getTime() + cooldown).toISOString(),
        reason:
          reservation === undefined
            ? forceFresh
              ? "native_resume_fallback_restart"
              : "process_restart"
            : "native_session_resume",
      },
    );
    try {
      await this.#supervisor.stop(current.id);
      await this.#runtime.removeViewSession(current.id);
      const replacement =
        reservation === undefined
          ? await this.#runtime.recoverRun(current, RECOVERY_TERMINAL_SIZE)
          : await this.#runtime.recoverRun(current, RECOVERY_TERMINAL_SIZE, {
              nativeSession: reservation.reference,
              nativeSessionId: reservation.session.id,
            });
      if (reservation === undefined) {
        return this.#store.updateRunProviderMetadata(replacement.id, {
          launchKind: "restarted",
          recoveryOutcome: "restarted",
        });
      }
      return replacement;
    } catch (error) {
      const failure = errorPayloadFromUnknown(
        error,
        "recovery_launch_failed",
        "The agent could not be restarted",
      );
      this.#store.recordRuntimeEvent("run.recovery-failed", "run", current.id, {
        generation: current.generation,
        error: failure,
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
            reason: failure.code,
          },
        );
      }
      return undefined;
    }
  }
}
