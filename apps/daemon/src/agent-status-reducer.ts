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
  ProcessIdentityObservation,
  ProcessState,
  ReporterReadinessCoverage,
  ScreenObservation,
  StatusAuthorityKind,
} from "@nanasa/contracts";

const SEMANTIC_LEASE_MS = 45_000;
const TRANSPORT_LEASE_MS = 45_000;
const MAX_HISTORY = 20;

export type ProcessStatusObservation =
  | {
      event: "process.alive";
      eventId: string;
      observedAt: string;
      process?: ProcessIdentityObservation;
      reporterAuthorityInvalid?: boolean;
    }
  | { event: "process.missing"; eventId: string; observedAt: string }
  | { event: "process.indeterminate"; eventId: string; observedAt: string }
  | {
      event: "process.exited";
      eventId: string;
      observedAt: string;
      exitCode?: number;
      signal?: string;
      operatorStopped?: boolean;
    }
  | { event: "lease.probed"; eventId: string; observedAt: string };

export interface ReporterAuthority {
  sessionId: string;
  reporterEpoch: string;
  readinessCoverage: ReporterReadinessCoverage;
  leaseExpiresAt: string;
}

export interface ProgressStatusObservation {
  event: "progress.reported";
  eventId: string;
  observedAt: string;
  report: AgentProgressReportCommand;
}

export type AgentStatusObservation =
  | {
      event: "reporter.event";
      observedAt: string;
      input: AgentStatusEventInput;
      authority: ReporterAuthority;
    }
  | ProcessStatusObservation
  | ProgressStatusObservation
  | { event: "screen.classified"; eventId: string; observedAt: string; screen: ScreenObservation };

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
  statusRevision: number;
  completionRevision: number;
  interactiveReady: boolean;
  staleAuthority: boolean;
  authorityKind: StatusAuthorityKind;
  authorityId?: string | undefined;
  processState: ProcessState;
  processFingerprint?: string | undefined;
  reporterEpoch?: string | undefined;
  reporterLeaseExpiresAt?: string | undefined;
  readinessCoverage?: ReporterReadinessCoverage | undefined;
  lastScreenObservation?: ScreenObservation | undefined;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function appendLimited<T>(items: readonly T[], item: T): T[] {
  return [...items, item].slice(-MAX_HISTORY);
}

function evidenceSource(source: AgentStatusEventInput["source"]): AgentStatusEvidence["source"] {
  void source;
  return "reporter";
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
  completion = false,
): AgentStatusReducerState {
  const revised = {
    ...next,
    statusRevision: current.statusRevision + 1,
    completionRevision: current.completionRevision + (completion ? 1 : 0),
  };
  if (
    current.state === revised.state &&
    current.phase === revised.phase &&
    current.attention === revised.attention &&
    current.outcome === revised.outcome
  ) {
    return revised;
  }
  return {
    ...revised,
    stateChangedAt: revised.observedAt,
    recentTransitions: appendLimited(revised.recentTransitions, {
      from: current.state,
      to: revised.state,
      phase: revised.phase,
      attention: revised.attention,
      occurredAt: revised.observedAt,
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
      state: "blocked",
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
    statusRevision: 0,
    completionRevision: 0,
    interactiveReady: false,
    staleAuthority: true,
    authorityKind: "none",
    processState: "indeterminate",
  };
}

export function reduceAgentStatus(
  current: AgentStatusReducerState,
  observation: AgentStatusObservation,
): AgentStatusReducerState {
  const observedAt = observation.observedAt;
  let next: AgentStatusReducerState = { ...current, observedAt };

  if (observation.event === "process.alive") {
    const processFallback =
      observation.process?.expectedProviderMatch === "match" &&
      observation.reporterAuthorityInvalid !== true &&
      current.openWaits.length === 0 &&
      (current.state === "starting" || current.state === "unknown");
    const invalidateReporter = observation.reporterAuthorityInvalid === true;
    next = withEvidence(
      {
        ...next,
        processState: "present",
        processFingerprint: observation.process?.processFingerprint,
        transportLeaseExpiresAt: addMilliseconds(observedAt, TRANSPORT_LEASE_MS),
        ...(processFallback
          ? {
              state: "idle" as const,
              phase: "settled" as const,
              confidence: "low" as const,
              attention: "none" as const,
              authorityKind: "process" as const,
              authorityId: observation.eventId,
              staleAuthority: false,
              interactiveReady: true,
            }
          : {}),
        ...(invalidateReporter
          ? {
              state: "unknown" as const,
              phase: "startup" as const,
              outcome: "unknown" as const,
              confidence: "low" as const,
              attention: "reporter_stale" as const,
              authorityKind: "none" as const,
              authorityId: undefined,
              staleAuthority: true,
              interactiveReady: false,
              reporterEpoch: undefined,
              reporterLeaseExpiresAt: undefined,
              readinessCoverage: undefined,
              semanticLeaseExpiresAt: undefined,
              lastActivityAt: undefined,
              lastActivityKind: undefined,
              lastProgressSummary: undefined,
              progressStage: undefined,
              nextStep: undefined,
              blocker: undefined,
              cleanEndSeen: false,
              openTools: [],
              openWaits: [],
              staleProbeCount: 0,
            }
          : {}),
      },
      { source: "process", kind: observation.event, observedAt, confidence: "high" },
    );
    return transition(current, next);
  }

  if (observation.event === "process.indeterminate") {
    next = withEvidence(
      {
        ...next,
        processState: "indeterminate",
        interactiveReady: false,
        ...(current.reporterLeaseExpiresAt === undefined ||
        Date.parse(observedAt) > Date.parse(current.reporterLeaseExpiresAt)
          ? {
              state: "unknown" as const,
              authorityKind: "none" as const,
              staleAuthority: true,
              attention: "reporter_stale" as const,
            }
          : {}),
      },
      { source: "process", kind: observation.event, observedAt, confidence: "low" },
    );
    return transition(current, next);
  }

  if (observation.event === "process.exited") {
    const stopped = observation.operatorStopped === true || current.cleanEndSeen;
    next = withEvidence(
      {
        ...next,
        state: stopped ? "stopped" : "failed",
        phase: "exited",
        outcome:
          observation.operatorStopped === true ? "cancelled" : stopped ? current.outcome : "failed",
        confidence: "high",
        authorityKind: "process",
        authorityId: observation.eventId,
        processState: "dead",
        interactiveReady: false,
        staleAuthority: false,
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
        state: "failed",
        phase: "exited",
        outcome: "failed",
        confidence: "medium",
        authorityKind: "process",
        authorityId: observation.eventId,
        processState: "missing",
        interactiveReady: false,
        staleAuthority: false,
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
    if (current.openWaits.length > 0) return transition(current, next);
    if (current.state === "working" && semanticExpired) {
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
        state:
          report.blocker !== undefined
            ? "blocked"
            : report.outcome === undefined
              ? "working"
              : "idle",
        phase: report.outcome === undefined ? "model" : "settled",
        outcome: report.outcome ?? current.outcome,
        confidence: "high",
        authorityKind: "reporter",
        authorityId: "status-api",
        staleAuthority: false,
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

  if (observation.event === "screen.classified") {
    const canBlock =
      observation.screen.classification === "blocked" &&
      observation.screen.visibleBlocker &&
      (current.staleAuthority || current.readinessCoverage !== "full");
    next = withEvidence(
      {
        ...next,
        lastScreenObservation: observation.screen,
        ...(canBlock
          ? {
              state: "blocked" as const,
              authorityKind: "screen" as const,
              authorityId: observation.screen.ruleId,
              confidence: "medium" as const,
              attention: "input_required" as const,
              staleAuthority: false,
            }
          : {}),
      },
      {
        source: "screen",
        kind: `screen.${observation.screen.classification}`,
        observedAt,
        confidence: observation.screen.confidence,
      },
    );
    return transition(current, next);
  }

  const input = observation.input;
  const heartbeat = input.event === "heartbeat";
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
      authorityKind: "reporter",
      authorityId: observation.authority.sessionId,
      reporterEpoch: observation.authority.reporterEpoch,
      reporterLeaseExpiresAt: observation.authority.leaseExpiresAt,
      readinessCoverage: observation.authority.readinessCoverage,
      staleAuthority: false,
      ...(heartbeat
        ? {}
        : {
            lastActivityAt: observedAt,
            lastActivityKind: input.event,
            staleProbeCount: 0,
          }),
    },
    eventEvidence,
  );

  switch (input.event) {
    case "reporter.ready":
      break;
    case "session.ready":
      next = {
        ...next,
        state: "idle",
        phase: "settled",
        confidence: "high",
        attention: "none",
        cleanEndSeen: false,
        interactiveReady: next.processState === "present",
        semanticLeaseExpiresAt: undefined,
      };
      break;
    case "turn.waiting":
      next = {
        ...next,
        state: "waiting",
        phase: "model",
        confidence: "high",
        attention: "none",
        semanticLeaseExpiresAt: addMilliseconds(observedAt, SEMANTIC_LEASE_MS),
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
        state: "blocked",
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
              state: "failed" as const,
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
          state: "idle",
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
        state: "idle",
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

  const completed =
    input.event === "turn.settled" &&
    ["working", "suspected_stuck"].includes(current.state) &&
    next.state === "idle";
  return transition(current, next, completed);
}
