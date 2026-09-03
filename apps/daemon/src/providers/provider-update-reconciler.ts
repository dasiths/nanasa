import { ProviderUpdateRecoveryCommandSchema } from "@nanasa/contracts";
import type {
  AgentRun,
  NativeRecoveryPolicy,
  ProviderUpdateOutcome,
  ProviderUpdatePlan,
  ProviderUpdateRecoveryCommand,
  ProviderUpdateSafeError,
  StartAgentRunResult,
} from "@nanasa/contracts";

import type { NativeSessionService } from "../native-session-service.js";
import type { RuntimeLaunchConsentGate } from "../run-runtime-coordinator.js";
import { DomainError, type NanasaStore } from "../store.js";
import type { TerminalGateway } from "../terminal/terminal-gateway.js";
import type { ProviderUpdatePaneStopResult, TmuxRuntime } from "../tmux-runtime.js";
import type { ProviderUpdateDetector } from "./provider-update-detector.js";
import type { ProviderUpdateTransitionRepository } from "./provider-update-transition-repository.js";

const PROVIDER_UPDATE_TERMINAL_SIZE = { cols: 120, rows: 40 } as const;

type ConsentResult = Awaited<ReturnType<RuntimeLaunchConsentGate["resolve"]>>;

export interface ProviderUpdateReconcilerOptions {
  readonly maxAttempts?: number;
  readonly cooldownMs?: readonly number[];
  readonly now?: () => Date;
  readonly nativeSessions?: NativeSessionService;
  readonly nativeRecoveryPolicy?: (run: AgentRun) => {
    readonly integrationId: string;
    readonly policy: NativeRecoveryPolicy;
  };
}

export interface ProviderUpdateReconciliationBatch {
  readonly outcomes: readonly ProviderUpdateOutcome[];
  readonly handledRunIds: ReadonlySet<string>;
}

export class ProviderUpdateReconciler {
  readonly #store: NanasaStore;
  readonly #runtime: TmuxRuntime;
  readonly #gateway: TerminalGateway;
  readonly #detector: ProviderUpdateDetector;
  readonly #transitions: ProviderUpdateTransitionRepository;
  readonly #launchConsent: RuntimeLaunchConsentGate;
  readonly #maxAttempts: number;
  readonly #cooldownMs: readonly number[];
  readonly #now: () => Date;
  readonly #nativeSessions: NativeSessionService | undefined;
  readonly #nativeRecoveryPolicy: ProviderUpdateReconcilerOptions["nativeRecoveryPolicy"];

  public constructor(
    store: NanasaStore,
    runtime: TmuxRuntime,
    gateway: TerminalGateway,
    detector: ProviderUpdateDetector,
    transitions: ProviderUpdateTransitionRepository,
    launchConsent: RuntimeLaunchConsentGate,
    options: ProviderUpdateReconcilerOptions = {},
  ) {
    this.#store = store;
    this.#runtime = runtime;
    this.#gateway = gateway;
    this.#detector = detector;
    this.#transitions = transitions;
    this.#launchConsent = launchConsent;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#cooldownMs = options.cooldownMs ?? [1_000, 5_000, 30_000];
    this.#now = options.now ?? (() => new Date());
    this.#nativeSessions = options.nativeSessions;
    this.#nativeRecoveryPolicy = options.nativeRecoveryPolicy;
  }

  public async reconcile(runs: readonly AgentRun[]): Promise<ProviderUpdateReconciliationBatch> {
    return this.#reconcile(runs, { dryRun: false, forceIndeterminate: false }, false);
  }

  public async recover(
    runs: readonly AgentRun[],
    command: ProviderUpdateRecoveryCommand,
  ): Promise<ProviderUpdateReconciliationBatch> {
    return this.#reconcile(runs, ProviderUpdateRecoveryCommandSchema.parse(command), true);
  }

  async #reconcile(
    runs: readonly AgentRun[],
    command: ProviderUpdateRecoveryCommand,
    requireBinding: boolean,
  ): Promise<ProviderUpdateReconciliationBatch> {
    const outcomes: ProviderUpdateOutcome[] = [];
    const handledRunIds = new Set<string>();
    for (const run of runs) {
      const resumed = command.dryRun ? undefined : this.#completeRunningReplacement(run);
      const plan = this.#detector.detectIfBound({
        runId: run.id,
        generation: run.generation,
        memberId: run.memberId,
      });
      if (plan === undefined) {
        if (requireBinding) {
          throw new DomainError(
            "provider_update_binding_unavailable",
            "The agent run does not have current provider metadata",
            409,
            { runId: run.id, generation: run.generation },
          );
        }
        continue;
      }
      if (plan.status === "current") {
        outcomes.push(resumed ?? this.#outcome(plan, "retained"));
        continue;
      }
      handledRunIds.add(run.id);
      outcomes.push(
        command.dryRun
          ? await this.#previewOutdated(run, plan, command.forceIndeterminate)
          : await this.#reconcileOutdated(run, plan, command.forceIndeterminate),
      );
    }
    return { outcomes, handledRunIds };
  }

  async #previewOutdated(
    run: AgentRun,
    plan: ProviderUpdatePlan,
    forceRequested: boolean,
  ): Promise<ProviderUpdateOutcome> {
    const forceIndeterminate = this.#forceIndeterminateFor(run, plan, forceRequested);
    const pane = await this.#runtime.inspectProviderUpdatePane(run, { forceIndeterminate });
    if (pane === "ownership-uncertain") {
      return this.#outcome(
        plan,
        "ownership-uncertain",
        undefined,
        undefined,
        this.#safeError(
          "provider_update_ownership_uncertain",
          "Nanasa could not safely identify the old process",
          false,
        ),
      );
    }
    const consent = await this.#launchConsent.inspectForRecovery(run.groupId, run.memberId);
    if (consent.status === "approval-required") return this.#outcome(plan, "approval-required");
    if (consent.status === "denied") {
      return this.#outcome(
        plan,
        "failed",
        undefined,
        undefined,
        this.#safeError(
          "provider_update_launch_denied",
          "The current launch settings were denied",
          false,
        ),
      );
    }
    return this.#outcome(plan, "restarted");
  }

  #completeRunningReplacement(run: AgentRun): ProviderUpdateOutcome | undefined {
    const transition = run.providerUpdate;
    if (
      transition?.state !== "in-progress" ||
      transition.replacementRunId !== run.id ||
      run.status !== "running"
    ) {
      return undefined;
    }
    const plan: ProviderUpdatePlan = {
      runId: transition.runId,
      generation: transition.generation,
      memberId: transition.memberId,
      providerId: transition.providerId,
      previousSnapshotDigest: transition.previousSnapshotDigest,
      currentSnapshotDigest: transition.currentSnapshotDigest,
      status: "outdated",
    };
    if (run.recoveryPhase === "resuming") {
      if (
        run.nativeSessionId === undefined ||
        this.#nativeSessions?.isConfirmed(run.nativeSessionId, run.id) !== true
      ) {
        return undefined;
      }
    }
    if (run.recoveryPhase === "failed") {
      const safeError = this.#safeError(
        "provider_update_native_resume_failed",
        "The previous agent session could not be resumed",
        false,
      );
      const completed = this.#transitions.complete(transition.id, {
        outcome: "failed",
        replacementRunId: run.id,
        safeError,
        completedAt: this.#now().toISOString(),
      });
      this.#completedEvent(plan, completed.id, safeError.message, safeError);
      return this.#outcome(plan, "failed", run.id, undefined, safeError);
    }
    const completed = this.#transitions.complete(transition.id, {
      outcome: "restarted",
      replacementRunId: run.id,
      completedAt: this.#now().toISOString(),
    });
    this.#completedEvent(plan, completed.id, "The agent restarted with the latest setup");
    return this.#outcome(plan, "restarted", run.id);
  }

  async #reconcileOutdated(
    run: AgentRun,
    plan: ProviderUpdatePlan,
    forceRequested: boolean,
  ): Promise<ProviderUpdateOutcome> {
    const forceIndeterminate = this.#forceIndeterminateFor(run, plan, forceRequested);
    const begun = this.#transitions.begin(plan, this.#now().toISOString());
    let transition = begun.transition;
    if (begun.created) {
      this.#event("provider-update.detected", plan, transition.id, {
        reason: "Agent tools changed",
      });
    }

    let consent: ConsentResult | undefined;
    if (
      transition.state === "completed" &&
      !(forceIndeterminate && transition.outcome === "ownership-uncertain")
    ) {
      if (
        transition.outcome === "restarted" ||
        (transition.outcome === "ownership-uncertain" && !forceIndeterminate)
      ) {
        return this.#outcome(
          plan,
          transition.outcome,
          transition.replacementRunId,
          undefined,
          transition.safeError,
        );
      }
      if (transition.outcome === "approval-required") {
        consent = await this.#launchConsent.resolve(run.groupId, run.memberId);
        if (consent.status === "approval-required") {
          return this.#outcome(plan, "approval-required", undefined, consent);
        }
      } else if (
        transition.safeError?.retryable !== true ||
        run.recoveryAttempts >= this.#maxAttempts ||
        this.#cooldownActive(run)
      ) {
        return this.#outcome(plan, "failed", undefined, undefined, transition.safeError);
      }
    }

    transition = this.#transitions.markInProgress(transition.id, this.#now().toISOString());
    this.#event("provider-update.in-progress", plan, transition.id, {
      reason: "Nanasa is restarting the agent with the latest setup",
    });

    const pane = await this.#runtime.stopProviderUpdatePane(run, { forceIndeterminate });
    if (pane === "ownership-uncertain") {
      const safeError = this.#safeError(
        "provider_update_ownership_uncertain",
        "Nanasa could not safely identify the old process",
        false,
      );
      this.#markRunFailed(run, safeError.code);
      const completed = this.#transitions.complete(transition.id, {
        outcome: "ownership-uncertain",
        safeError,
        completedAt: this.#now().toISOString(),
      });
      this.#completedEvent(
        plan,
        completed.id,
        "Nanasa did not stop an unverified process",
        safeError,
      );
      return this.#outcome(plan, "ownership-uncertain", undefined, undefined, safeError);
    }
    await this.#detachTerminal(run, pane);

    consent ??= await this.#launchConsent.resolve(run.groupId, run.memberId);
    if (consent.status === "approval-required") {
      this.#markRunFailed(run, "provider_update_approval_required");
      const completed = this.#transitions.complete(transition.id, {
        outcome: "approval-required",
        completedAt: this.#now().toISOString(),
      });
      this.#completedEvent(plan, completed.id, "The agent needs launch approval");
      return this.#outcome(plan, "approval-required", undefined, consent);
    }
    if (consent.status === "denied") {
      return this.#completeFailure(
        run,
        plan,
        transition.id,
        this.#safeError(
          "provider_update_launch_denied",
          "The current launch settings were denied",
          false,
        ),
      );
    }

    if (run.recoveryAttempts >= this.#maxAttempts) {
      return this.#completeFailure(
        run,
        plan,
        transition.id,
        this.#safeError(
          "provider_update_attempts_exhausted",
          "Nanasa could not restart the agent after the allowed attempts",
          false,
        ),
      );
    }

    const recovery = this.#nativeRecoveryPolicy?.(run);
    const reservation =
      recovery?.policy.mode === "restart"
        ? undefined
        : this.#nativeSessions?.reserve(run.memberId, recovery?.integrationId ?? "", run.id);
    if (reservation === undefined && recovery?.policy.mode === "resume-only") {
      return this.#completeFailure(
        run,
        plan,
        transition.id,
        this.#safeError(
          "provider_update_native_session_unavailable",
          "The agent requires a previous session, but none could be confirmed",
          false,
        ),
      );
    }

    const attempt = run.recoveryAttempts + 1;
    const cooldown = this.#cooldownMs[Math.min(attempt - 1, this.#cooldownMs.length - 1)] ?? 30_000;
    const current = this.#store.transitionRunRecovery(
      run.id,
      run.generation,
      reservation === undefined ? "restarting" : "resuming",
      {
        incrementAttempt: true,
        recoveryNotBefore: new Date(this.#now().getTime() + cooldown).toISOString(),
        reason: "provider_snapshot_changed",
      },
    );
    let replacementRunId: string | undefined;
    try {
      const replacement = await this.#runtime.recoverRun(current, PROVIDER_UPDATE_TERMINAL_SIZE, {
        ...(reservation === undefined
          ? {}
          : {
              nativeSession: reservation.reference,
              nativeSessionId: reservation.session.id,
            }),
        onReplacementCreated: (created) => {
          replacementRunId = created.id;
          this.#transitions.recordReplacement(transition.id, created.id, this.#now().toISOString());
        },
      });
      if (reservation !== undefined) {
        return this.#outcome(plan, "restarted", replacement.id);
      }
      this.#store.updateRunProviderMetadata(replacement.id, {
        launchKind: "restarted",
        recoveryOutcome: "restarted",
      });
      const completed = this.#transitions.complete(transition.id, {
        outcome: "restarted",
        replacementRunId: replacement.id,
        completedAt: this.#now().toISOString(),
      });
      this.#completedEvent(plan, completed.id, "The agent restarted with the latest setup");
      return this.#outcome(plan, "restarted", replacement.id);
    } catch {
      const retryable = attempt < this.#maxAttempts;
      const safeError = this.#safeError(
        "provider_update_launch_failed",
        "The replacement agent could not be started",
        retryable,
      );
      const latest = replacementRunId === undefined ? run : this.#store.getRun(replacementRunId);
      if (latest.desiredState === "running") this.#markRunFailed(latest, safeError.code);
      const completed = this.#transitions.complete(transition.id, {
        outcome: "failed",
        ...(replacementRunId === undefined ? {} : { replacementRunId }),
        safeError,
        completedAt: this.#now().toISOString(),
      });
      this.#completedEvent(plan, completed.id, safeError.message, safeError);
      return this.#outcome(plan, "failed", replacementRunId, undefined, safeError);
    }
  }

  #forceIndeterminateFor(
    run: AgentRun,
    plan: ProviderUpdatePlan,
    forceRequested: boolean,
  ): boolean {
    if (!forceRequested) return false;
    const transition = this.#transitions.getForPair(plan);
    if (transition?.state !== "completed" || transition.outcome !== "ownership-uncertain") {
      return false;
    }
    const latest = this.#store.getLatestRunForMembership(run.groupId, run.memberId);
    if (
      latest?.id !== run.id ||
      latest.generation !== run.generation ||
      latest.desiredState !== "running"
    ) {
      throw new DomainError(
        "provider_update_target_changed",
        "The agent run changed before forced recovery",
        409,
        { runId: run.id, generation: run.generation },
      );
    }
    return true;
  }

  async #detachTerminal(run: AgentRun, pane: ProviderUpdatePaneStopResult): Promise<void> {
    await this.#gateway.stop(run.id);
    await this.#runtime.removeViewSession(run.id);
    if (pane !== "stopped" && pane !== "missing") {
      throw new Error("Provider update pane disposition is invalid");
    }
  }

  #markRunFailed(run: AgentRun, reason: string): void {
    let current = this.#store.getRun(run.id);
    if (current.status !== "failed" && current.status !== "stopped") {
      current = this.#store.updateRunStatus(current.id, "failed", { reason });
    }
    if (current.desiredState === "running" && current.recoveryPhase !== "failed") {
      this.#store.transitionRunRecovery(current.id, current.generation, "failed", { reason });
    }
    this.#store.updateRunProviderMetadata(current.id, { recoveryOutcome: "failed" });
  }

  #completeFailure(
    run: AgentRun,
    plan: ProviderUpdatePlan,
    transitionId: string,
    safeError: ProviderUpdateSafeError,
  ): ProviderUpdateOutcome {
    this.#markRunFailed(run, safeError.code);
    const completed = this.#transitions.complete(transitionId, {
      outcome: "failed",
      safeError,
      completedAt: this.#now().toISOString(),
    });
    this.#completedEvent(plan, completed.id, safeError.message, safeError);
    return this.#outcome(plan, "failed", undefined, undefined, safeError);
  }

  #cooldownActive(run: AgentRun): boolean {
    return (
      run.recoveryNotBefore !== undefined &&
      Date.parse(run.recoveryNotBefore) > this.#now().getTime()
    );
  }

  #safeError(code: string, message: string, retryable: boolean): ProviderUpdateSafeError {
    return { code, message, retryable };
  }

  #outcome(
    plan: ProviderUpdatePlan,
    status: ProviderUpdateOutcome["status"],
    replacementRunId?: string,
    consent?: Extract<StartAgentRunResult, { status: "approval-required" | "denied" }>,
    safeError?: ProviderUpdateSafeError,
  ): ProviderUpdateOutcome {
    return {
      runId: plan.runId,
      generation: plan.generation,
      memberId: plan.memberId,
      providerId: plan.providerId,
      previousSnapshotDigest: plan.previousSnapshotDigest,
      currentSnapshotDigest: plan.currentSnapshotDigest,
      status,
      ...(replacementRunId === undefined ? {} : { replacementRunId }),
      ...(consent === undefined ? {} : { consentRequest: consent.request }),
      ...(safeError === undefined ? {} : { safeError }),
    };
  }

  #completedEvent(
    plan: ProviderUpdatePlan,
    transitionId: string,
    outcome: string,
    safeError?: ProviderUpdateSafeError,
  ): void {
    this.#event("provider-update.completed", plan, transitionId, {
      outcome,
      ...(safeError === undefined ? {} : { safeError }),
    });
  }

  #event(
    type: string,
    plan: ProviderUpdatePlan,
    transitionId: string,
    metadata: Record<string, unknown>,
  ): void {
    this.#store.recordRuntimeEvent(type, "provider-update", transitionId, {
      transitionId,
      runId: plan.runId,
      generation: plan.generation,
      memberId: plan.memberId,
      providerId: plan.providerId,
      previousSnapshotDigest: plan.previousSnapshotDigest,
      currentSnapshotDigest: plan.currentSnapshotDigest,
      ...metadata,
    });
  }
}
