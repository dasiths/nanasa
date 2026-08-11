import type {
  AgentProgressReportCommand,
  AgentStatusAttention,
  AgentStatusConfidence,
  AgentStatusEventInput,
  AgentStatusEvidence,
  AgentStatusOutcome,
  AgentStatusPhase,
  AgentStatusState,
  AgentStatusTransition,
  AgentStatusWait,
} from "@nanasa/contracts";

const SEMANTIC_LEASE_MS = 45_000;
const TRANSPORT_LEASE_MS = 45_000;
const MAX_HISTORY = 20;

export type ProcessStatusObservation =
  | { event: "process.alive"; eventId: string; observedAt: string }
  | { event: "process.missing"; eventId: string; observedAt: string }
  | {
      event: "process.exited";
      eventId: string;
      observedAt: string;
      exitCode?: number;
      signal?: string;
      operatorStopped?: boolean;
    }
  | { event: "lease.probed"; eventId: string; observedAt: string };

export interface ProgressStatusObservation {
  event: "progress.reported";
  eventId: string;
  observedAt: string;
  report: AgentProgressReportCommand;
}

export type AgentStatusObservation =
  | { event: "reporter.event"; observedAt: string; input: AgentStatusEventInput }
  | ProcessStatusObservation
  | ProgressStatusObservation;

export interface AgentStatusReducerState {
  runId: string;
  generation: number;
  state: AgentStatusState;
  phase: AgentStatusPhase;
  outcome: AgentStatusOutcome;
  confidence: AgentStatusConfidence;
  attention: AgentStatusAttention;
  observedAt: string;
  stateChangedAt: string;
  lastActivityAt?: string | undefined;
  lastActivityKind?: string | undefined;
  semanticLeaseExpiresAt?: string | undefined;
  transportLeaseExpiresAt?: string | undefined;
  lastProgressSummary?: string | undefined;
  progressStage?: string | undefined;
  nextStep?: string | undefined;
  blocker?: string | undefined;
  processExitCode?: number | undefined;
  processSignal?: string | undefined;
  cleanEndSeen: boolean;
  openTools: string[];
  openWaits: AgentStatusWait[];
  staleProbeCount: number;
  evidence: AgentStatusEvidence[];
  recentTransitions: AgentStatusTransition[];
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function appendLimited<T>(items: readonly T[], item: T): T[] {
  return [...items, item].slice(-MAX_HISTORY);
}

function evidenceSource(source: AgentStatusEventInput["source"]): AgentStatusEvidence["source"] {
  if (source === "opencode") return "sse";
  return "hook";
}

function waitPhase(wait: AgentStatusWait): AgentStatusPhase {
  return wait.kind === "elicitation" ? "question" : wait.kind;
}

function waitAttention(wait: AgentStatusWait): AgentStatusAttention {
  return wait.kind === "permission" || wait.kind === "plan_approval"
    ? "decision_required"
    : "input_required";
}

function transition(
  current: AgentStatusReducerState,
  next: AgentStatusReducerState,
): AgentStatusReducerState {
  if (
    current.state === next.state &&
    current.phase === next.phase &&
    current.attention === next.attention &&
    current.outcome === next.outcome
  ) {
    return next;
  }
  return {
    ...next,
    stateChangedAt: next.observedAt,
    recentTransitions: appendLimited(next.recentTransitions, {
      from: current.state,
      to: next.state,
      phase: next.phase,
      attention: next.attention,
      occurredAt: next.observedAt,
    }),
  };
}

function withEvidence(
  current: AgentStatusReducerState,
  evidence: AgentStatusEvidence,
): AgentStatusReducerState {
  return { ...current, evidence: appendLimited(current.evidence, evidence) };
}

function resumeAfterWait(current: AgentStatusReducerState): AgentStatusReducerState {
  const wait = current.openWaits[0];
  if (wait !== undefined) {
    return {
      ...current,
      state: "waiting",
      phase: waitPhase(wait),
      attention: waitAttention(wait),
      confidence: "high",
    };
  }
  return {
    ...current,
    state: "working",
    phase: current.openTools.length > 0 ? "tool" : "model",
    attention: "none",
    confidence: "high",
  };
}

export function createAgentStatusReducerState(
  runId: string,
  generation: number,
  observedAt: string,
): AgentStatusReducerState {
  return {
    runId,
    generation,
    state: "starting",
    phase: "startup",
    outcome: "unknown",
    confidence: "low",
    attention: "none",
    observedAt,
    stateChangedAt: observedAt,
    cleanEndSeen: false,
    openTools: [],
    openWaits: [],
    staleProbeCount: 0,
    evidence: [
      {
        source: "scheduler",
        kind: "spawn.requested",
        observedAt,
        confidence: "high",
      },
    ],
    recentTransitions: [],
  };
}

export function reduceAgentStatus(
  current: AgentStatusReducerState,
  observation: AgentStatusObservation,
): AgentStatusReducerState {
  const observedAt = observation.observedAt;
  let next: AgentStatusReducerState = { ...current, observedAt };

  if (observation.event === "process.alive") {
    next = withEvidence(
      {
        ...next,
        transportLeaseExpiresAt: addMilliseconds(observedAt, TRANSPORT_LEASE_MS),
      },
      { source: "process", kind: observation.event, observedAt, confidence: "high" },
    );
    return transition(current, next);
  }

  if (observation.event === "process.exited") {
    const stopped = observation.operatorStopped === true || current.cleanEndSeen;
    next = withEvidence(
      {
        ...next,
        state: stopped ? "stopped" : "crashed",
        phase: "exited",
        outcome:
          observation.operatorStopped === true ? "cancelled" : stopped ? current.outcome : "failed",
        confidence: "high",
        attention: stopped ? "none" : "process_failed",
        processExitCode: observation.exitCode,
        processSignal: observation.signal,
        openTools: [],
        openWaits: [],
        staleProbeCount: 0,
      },
      {
        source: "process",
        kind: observation.event,
        observedAt,
        confidence: "high",
        summary:
          observation.signal ??
          (observation.exitCode === undefined ? undefined : `exit ${observation.exitCode}`),
      },
    );
    return transition(current, next);
  }

  if (observation.event === "process.missing") {
    next = withEvidence(
      {
        ...next,
        state: "crashed",
        phase: "exited",
        outcome: "failed",
        confidence: "medium",
        attention: "process_failed",
        openTools: [],
        openWaits: [],
        staleProbeCount: 0,
      },
      { source: "process", kind: observation.event, observedAt, confidence: "medium" },
    );
    return transition(current, next);
  }

  if (observation.event === "lease.probed") {
    const semanticExpired =
      current.semanticLeaseExpiresAt !== undefined &&
      Date.parse(observedAt) > Date.parse(current.semanticLeaseExpiresAt);
    const transportExpired =
      current.transportLeaseExpiresAt !== undefined &&
      Date.parse(observedAt) > Date.parse(current.transportLeaseExpiresAt);
    if (current.openWaits.length > 0) return transition(current, next);
    if (current.state === "starting" && transportExpired) {
      next = {
        ...next,
        state: "waiting",
        phase: "settled",
        attention: "none",
        confidence: "low",
      };
    } else if (current.state === "working" && semanticExpired) {
      const staleProbeCount = current.staleProbeCount + 1;
      next = {
        ...next,
        staleProbeCount,
        ...(staleProbeCount >= 2
          ? {
              state: "suspected_stuck" as const,
              attention: "progress_stale" as const,
              confidence: "low" as const,
            }
          : {}),
      };
    }
    return transition(current, next);
  }

  if (observation.event === "progress.reported") {
    const report = observation.report;
    next = withEvidence(
      {
        ...next,
        state: report.outcome === undefined ? "working" : "waiting",
        phase: report.outcome === undefined ? "model" : "settled",
        outcome: report.outcome ?? current.outcome,
        confidence: "high",
        attention: report.blocker === undefined ? "none" : "input_required",
        lastActivityAt: observedAt,
        lastActivityKind: observation.event,
        semanticLeaseExpiresAt: addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
        lastProgressSummary: report.summary,
        progressStage: report.stage,
        nextStep: report.nextStep,
        blocker: report.blocker,
        cleanEndSeen: false,
        staleProbeCount: 0,
      },
      {
        source: "status_api",
        kind: observation.event,
        observedAt,
        confidence: "high",
        summary: report.summary,
      },
    );
    if (current.openWaits.length > 0) {
      next = resumeAfterWait({ ...next, openWaits: current.openWaits });
    }
    return transition(current, next);
  }

  const input = observation.input;
  const eventEvidence: AgentStatusEvidence = {
    source: evidenceSource(input.source),
    kind: input.event,
    observedAt,
    confidence: "high",
    summary: input.data.summary,
  };
  next = withEvidence(
    {
      ...next,
      lastActivityAt: observedAt,
      lastActivityKind: input.event,
      transportLeaseExpiresAt: addMilliseconds(observedAt, TRANSPORT_LEASE_MS),
      staleProbeCount: 0,
    },
    eventEvidence,
  );

  switch (input.event) {
    case "reporter.ready":
      break;
    case "session.ready":
      next = {
        ...next,
        state: "waiting",
        phase: "settled",
        confidence: "high",
        attention: "none",
        cleanEndSeen: false,
        semanticLeaseExpiresAt: undefined,
      };
      break;
    case "turn.started":
      next = {
        ...next,
        state: "working",
        phase: "model",
        confidence: "high",
        attention: "none",
        cleanEndSeen: false,
        semanticLeaseExpiresAt: addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
      };
      break;
    case "tool.started":
      next = {
        ...next,
        state: "working",
        phase: "tool",
        confidence: "high",
        attention: "none",
        cleanEndSeen: false,
        openTools: [...new Set([...next.openTools, input.operationId!])],
        semanticLeaseExpiresAt: addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
      };
      break;
    case "tool.finished":
    case "tool.failed":
      next = resumeAfterWait({
        ...next,
        openTools: next.openTools.filter((toolId) => toolId !== input.operationId),
        openWaits: next.openWaits.filter((wait) => wait.requestId !== input.operationId),
        semanticLeaseExpiresAt: addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
      });
      break;
    case "wait.opened": {
      const wait: AgentStatusWait = {
        requestId: input.requestId!,
        kind: input.data.waitKind!,
        summary: input.data.summary!,
        replyChannel: input.data.replyChannel!,
        openedAt: observedAt,
      };
      next = {
        ...next,
        state: "waiting",
        phase: waitPhase(wait),
        confidence: "high",
        attention: waitAttention(wait),
        openWaits: [...next.openWaits.filter((item) => item.requestId !== wait.requestId), wait],
        semanticLeaseExpiresAt: undefined,
      };
      break;
    }
    case "wait.closed":
      if (next.openWaits.some((wait) => wait.requestId === input.requestId)) {
        next = resumeAfterWait({
          ...next,
          openWaits: next.openWaits.filter((wait) => wait.requestId !== input.requestId),
          semanticLeaseExpiresAt: addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
        });
      }
      break;
    case "compaction.started":
      next = {
        ...next,
        state: "working",
        phase: "compaction",
        attention: "none",
        semanticLeaseExpiresAt: addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
      };
      break;
    case "compaction.finished":
      next = {
        ...next,
        state: "working",
        phase: "model",
        semanticLeaseExpiresAt: addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
      };
      break;
    case "retry.observed":
      next = {
        ...next,
        state: "working",
        phase: "retry",
        attention: "none",
        semanticLeaseExpiresAt:
          input.data.retryAt ?? addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
      };
      break;
    case "failure.observed":
      next = {
        ...next,
        ...(input.data.fatal === true
          ? {
              state: "waiting" as const,
              phase: "settled" as const,
              outcome: "failed" as const,
              attention: "process_failed" as const,
            }
          : { attention: "none" as const }),
      };
      break;
    case "turn.settled":
      if (next.openWaits.length > 0) {
        next = resumeAfterWait(next);
      } else if ((input.data.activeCount ?? 0) > 0 || next.openTools.length > 0) {
        next = {
          ...next,
          state: "working",
          phase: next.openTools.length > 0 ? "tool" : "model",
          semanticLeaseExpiresAt: addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
        };
      } else {
        next = {
          ...next,
          state: "waiting",
          phase: "settled",
          confidence: "high",
          attention: "none",
          semanticLeaseExpiresAt: undefined,
        };
      }
      break;
    case "session.ended":
      next = {
        ...next,
        state: "waiting",
        phase: "settled",
        confidence: "high",
        attention: "none",
        cleanEndSeen: true,
        openTools: [],
        openWaits: [],
        semanticLeaseExpiresAt: undefined,
      };
      break;
    case "heartbeat":
      break;
  }

  if (
    next.openWaits.length > 0 &&
    input.event !== "wait.closed" &&
    input.event !== "session.ended" &&
    !(input.event === "failure.observed" && input.data.fatal === true)
  ) {
    next = resumeAfterWait(next);
  }

  return transition(current, next);
}
