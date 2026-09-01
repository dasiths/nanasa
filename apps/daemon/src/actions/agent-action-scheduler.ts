import { createHash, randomUUID } from "node:crypto";
import type { AgentAction, AgentActionAttempt, AgentStatusDetail } from "@nanasa/contracts";
import type { RuntimeObservation } from "../runtime-observation.js";
import { DomainError, type NanasaStore } from "../store.js";
import type { TerminalInputArbiter } from "../terminal/terminal-input-arbiter.js";

interface ActionRuntime {
  observeRun(run: Parameters<NanasaStore["createRun"]>[0]): Promise<RuntimeObservation>;
  pasteToRun(run: Parameters<NanasaStore["createRun"]>[0], text: string): Promise<void>;
}

export type ActionReadinessDecision =
  | { kind: "dispatch" }
  | { kind: "defer"; code: "target_starting" }
  | { kind: "reject"; code: string };

export function actionReadiness(
  action: AgentAction,
  status: AgentStatusDetail,
  now: Date,
): ActionReadinessDecision {
  if (status.runId !== action.target.runId || status.generation !== action.target.generation) {
    return { kind: "reject", code: "target_identity_mismatch" };
  }
  if (status.runStatus === "starting" || status.state === "starting") {
    return { kind: "defer", code: "target_starting" };
  }
  if (status.runStatus === "failed" || status.state === "failed") {
    return { kind: "reject", code: "target_failed" };
  }
  if (status.runStatus === "stopped" || status.state === "stopped") {
    return { kind: "reject", code: "target_stopped" };
  }
  if (status.processState === "indeterminate") {
    return { kind: "reject", code: "target_process_indeterminate" };
  }
  if (status.processState !== "present") {
    return { kind: "reject", code: "target_process_unavailable" };
  }
  if (status.state === "blocked") return { kind: "reject", code: "target_blocked" };
  if (status.state === "unknown") return { kind: "reject", code: "target_unknown" };
  if (
    status.staleAuthority ||
    status.reporterEpoch !== action.target.reporterEpoch ||
    status.authorityKind !== "reporter" ||
    status.reporterLeaseExpiresAt === undefined ||
    Date.parse(status.reporterLeaseExpiresAt) <= now.getTime() ||
    status.transportLeaseExpiresAt === undefined ||
    Date.parse(status.transportLeaseExpiresAt) <= now.getTime()
  ) {
    return { kind: "reject", code: "target_reporter_stale" };
  }
  if (!status.interactiveReady) return { kind: "reject", code: "target_not_interactive_ready" };
  if (status.state === "working") {
    return action.allowWorking
      ? { kind: "dispatch" }
      : { kind: "reject", code: "target_working_override_required" };
  }
  if (status.state !== "idle") return { kind: "reject", code: "target_not_idle" };
  return { kind: "dispatch" };
}

function bindingFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function actionPrompt(action: AgentAction): string {
  return `[Nanasa Action: ${action.id} | Exact Run: ${action.target.runId} | Generation: ${action.target.generation}]\n${action.prompt ?? "Wait for the correlated result."}`;
}

export class AgentActionScheduler {
  readonly #owner = `action-scheduler_${randomUUID()}`;
  #timer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #pending: Promise<void> | undefined;
  #closing = false;

  public constructor(
    private readonly store: NanasaStore,
    private readonly runtime: ActionRuntime,
    private readonly arbiter: TerminalInputArbiter,
    private readonly now: () => Date = () => new Date(),
    private readonly pollIntervalMs = 1_000,
  ) {}

  public start(): void {
    if (this.#timer !== undefined || this.#closing) return;
    this.#unsubscribe = this.store.onEvent((event) => {
      if (
        event.type.startsWith("agent-action.") ||
        event.type === "agent-status.changed" ||
        event.type === "run.status-changed"
      ) {
        void this.tick();
      }
    });
    this.#timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.#timer.unref();
    void this.tick();
  }

  public tick(): Promise<void> {
    if (this.#closing) return Promise.resolve();
    if (this.#pending !== undefined) return this.#pending;
    const operation = Promise.resolve().then(() => this.#schedule());
    const pending = operation.finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }

  public async close(): Promise<void> {
    this.#closing = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#unsubscribe?.();
    await this.#pending;
  }

  async #schedule(): Promise<void> {
    const now = this.now();
    this.store.recoverAmbiguousActionAttempts(now);
    for (const action of this.store.listAgentActions()) {
      if (["created", "deferred"].includes(action.state)) await this.#consider(action, now);
      else if (
        action.state === "submitted" &&
        action.acceptanceDeadlineAt !== undefined &&
        Date.parse(action.acceptanceDeadlineAt) <= now.getTime()
      ) {
        this.store.transitionAgentAction(action.id, ["submitted"], "stalled", {
          error: {
            code: "agent_prompt_stalled",
            message: "The exact reporter did not acknowledge submission before the deadline",
            retryable: false,
          },
        });
      } else if (
        ["accepted", "started", "blocked"].includes(action.state) &&
        action.completionDeadlineAt !== undefined &&
        Date.parse(action.completionDeadlineAt) <= now.getTime()
      ) {
        this.store.transitionAgentAction(action.id, [action.state], "timed-out", {
          error: {
            code: "agent_action_timed_out",
            message: "The correlated provider work did not settle before the deadline",
            retryable: false,
          },
        });
      }
    }
  }

  async #consider(action: AgentAction, now: Date): Promise<void> {
    if (Date.parse(action.queueDeadlineAt) <= now.getTime()) {
      this.store.transitionAgentAction(action.id, [action.state], "expired", {
        error: {
          code: "agent_action_queue_expired",
          message: "The exact target did not become eligible before the queue deadline",
          retryable: false,
        },
      });
      return;
    }
    const run = this.store.getActiveRun(action.target.groupId, action.target.memberId);
    const reporter = this.store.getCurrentReporterSession(
      action.target.runId,
      action.target.generation,
    );
    if (
      run?.id !== action.target.runId ||
      run.generation !== action.target.generation ||
      reporter?.id !== action.target.reporterSessionId ||
      reporter.reporterEpoch !== action.target.reporterEpoch
    ) {
      this.store.transitionAgentAction(action.id, [action.state], "superseded", {
        error: {
          code: "run_replaced",
          message: "The exact target run or reporter was replaced",
          retryable: false,
        },
      });
      return;
    }
    const status = this.store.getAgentStatus(action.target.groupId, action.target.memberId);
    const decision = actionReadiness(action, status, now);
    if (decision.kind === "defer") {
      if (action.state !== "deferred") {
        this.store.transitionAgentAction(action.id, [action.state], "deferred");
      }
      return;
    }
    if (decision.kind === "reject") {
      this.store.transitionAgentAction(action.id, [action.state], "rejected", {
        error: {
          code: decision.code,
          message: "The exact target is not dispatch eligible",
          retryable: false,
        },
      });
      return;
    }
    if (run.terminal === undefined) {
      this.store.transitionAgentAction(action.id, [action.state], "rejected", {
        error: {
          code: "target_terminal_unavailable",
          message: "The exact target has no terminal binding",
          retryable: false,
        },
      });
      return;
    }
    const attemptNumber = this.store.listActionAttempts(action.id).length + 1;
    const leaseExpiresAt = new Date(now.getTime() + 30_000).toISOString();
    const attempt: AgentActionAttempt = {
      id: `attempt_${randomUUID()}`,
      actionId: action.id,
      attempt: attemptNumber,
      effect: "terminal-injection",
      state: "submitting",
      daemonEpoch: action.target.daemonEpoch,
      groupId: action.target.groupId,
      memberId: action.target.memberId,
      runId: action.target.runId,
      generation: action.target.generation,
      reporterSessionId: action.target.reporterSessionId,
      reporterId: action.target.reporterId,
      reporterEpoch: action.target.reporterEpoch,
      nativeSessionId: action.target.nativeSessionId,
      baselineStatusRevision: status.statusRevision,
      baselineCompletionRevision: status.completionRevision,
      terminalBinding: run.terminal,
      terminalBindingFingerprint: bindingFingerprint(run.terminal),
      leaseOwner: this.#owner,
      leaseExpiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.store.beginAgentActionAttempt(attempt);
    let writeCompleted = false;
    try {
      const refreshedStatus = this.store.getAgentStatus(
        action.target.groupId,
        action.target.memberId,
      );
      const refreshedDecision = actionReadiness(action, refreshedStatus, this.now());
      if (refreshedDecision.kind !== "dispatch") {
        throw new DomainError(
          "agent_action_readiness_changed",
          "The exact target readiness changed before terminal input",
          409,
        );
      }
      await this.arbiter.dispatchAutomated(run.id, async () => {
        const currentStatus = this.store.getAgentStatus(
          action.target.groupId,
          action.target.memberId,
        );
        const currentDecision = actionReadiness(action, currentStatus, this.now());
        if (currentDecision.kind !== "dispatch") {
          throw new DomainError(
            "agent_action_readiness_changed",
            "The exact target readiness changed before terminal input",
            409,
          );
        }
        const observation = await this.runtime.observeRun(run);
        if (
          observation.state !== "present" ||
          observation.process?.expectedProviderMatch !== "match" ||
          observation.process.processFingerprint !== currentStatus.processFingerprint ||
          observation.process.processFingerprint !==
            this.store.getCurrentReporterSession(run.id, run.generation)?.processFingerprint
        ) {
          throw new DomainError(
            observation.state === "indeterminate"
              ? "target_process_indeterminate"
              : "target_identity_mismatch",
            "The exact target process is not current",
            409,
          );
        }
        const finalAction = this.store.getAgentAction(action.id);
        const finalStatus = this.store.getAgentStatus(
          action.target.groupId,
          action.target.memberId,
        );
        const finalReporter = this.store.getCurrentReporterSession(run.id, run.generation);
        if (
          !["created", "deferred"].includes(finalAction.state) ||
          actionReadiness(action, finalStatus, this.now()).kind !== "dispatch" ||
          finalReporter?.id !== action.target.reporterSessionId ||
          finalReporter.reporterEpoch !== action.target.reporterEpoch ||
          finalReporter.processFingerprint !== observation.process.processFingerprint
        ) {
          throw new DomainError(
            "agent_action_readiness_changed",
            "The exact target readiness changed during process verification",
            409,
          );
        }
        await this.runtime.pasteToRun(run, actionPrompt(action));
      });
      writeCompleted = true;
      this.store.markAgentActionSubmitted(action.id, attempt.id, this.#owner);
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "agent_action_submission_failed";
      const currentAction = this.store.getAgentAction(action.id);
      if (
        [
          "completed",
          "settled-unverified",
          "failed",
          "stalled",
          "timed-out",
          "cancelled",
          "expired",
          "superseded",
          "rejected",
        ].includes(currentAction.state)
      ) {
        this.store.abandonAgentActionAttempt(action.id, attempt.id, this.#owner, code);
        return;
      }
      if (writeCompleted) {
        this.store.failAgentActionAttempt(action.id, attempt.id, this.#owner, "stalled", {
          code: "submission_commit_indeterminate",
          message: "Terminal input succeeded but durable submission confirmation failed",
          retryable: false,
        });
        this.store.transitionAgentAction(action.id, ["stalled"], "settled-unverified", {
          error: {
            code: "submission_commit_indeterminate",
            message: "Terminal input may have been accepted before the durable commit failed",
            retryable: false,
          },
        });
        return;
      }
      const state =
        code.includes("replaced") || code.includes("mismatch") ? "superseded" : "failed";
      this.store.failAgentActionAttempt(action.id, attempt.id, this.#owner, state, {
        code,
        message: error instanceof Error ? error.message : "Action submission failed",
        retryable: false,
      });
    }
  }
}
