import { describe, expect, it } from "vitest";

import {
  type AgentStatusReducerState,
  createAgentStatusReducerState,
  reduceAgentStatus,
} from "../src/agent-status-reducer.js";

const startedAt = "2026-08-11T12:00:00.000Z";

function reporterEvent(
  current: AgentStatusReducerState,
  event: string,
  options: {
    observedAt?: string;
    operationId?: string;
    requestId?: string;
    data?: Record<string, unknown>;
  } = {},
) {
  return reduceAgentStatus(current, {
    event: "reporter.event",
    observedAt: options.observedAt ?? "2026-08-11T12:00:01.000Z",
    input: {
      version: 2,
      eventId: `event-${event}-${options.operationId ?? options.requestId ?? "one"}`,
      providerId: "claude-code",
      adapterId: "claude-code",
      reporterId: "claude-hooks",
      source: "claude-code",
      protocolVersion: 2,
      reporterVersion: "2",
      runId: current.runId,
      generation: current.generation,
      reporterEpoch: "epoch-one",
      sourceSequence: current.statusRevision + 1,
      event: event as never,
      operationId: options.operationId,
      requestId: options.requestId,
      data: options.data ?? {},
    },
    authority: {
      sessionId: "reporter-one",
      reporterEpoch: "epoch-one",
      readinessCoverage: "full",
      leaseExpiresAt: "2026-08-11T13:00:00.000Z",
    },
  });
}

describe("agent status reducer", () => {
  it("tracks correlated tools and settles only after all work closes", () => {
    let state = createAgentStatusReducerState("run_1", 1, startedAt);
    state = reporterEvent(state, "session.ready");
    expect(state.state).toBe("idle");

    state = reporterEvent(state, "tool.started", { operationId: "tool_1" });
    state = reporterEvent(state, "tool.started", { operationId: "tool_2" });
    state = reporterEvent(state, "tool.finished", { operationId: "tool_1" });
    expect(state).toMatchObject({ state: "working", phase: "tool", openTools: ["tool_2"] });

    state = reporterEvent(state, "turn.settled");
    expect(state.state).toBe("working");
    state = reporterEvent(state, "tool.finished", { operationId: "tool_2" });
    state = reporterEvent(state, "turn.settled");
    expect(state).toMatchObject({ state: "idle", phase: "settled", openTools: [] });
  });

  it("clears an orphaned tool when the provider confirms no active work remains", () => {
    let state = createAgentStatusReducerState("run_1", 1, startedAt);
    state = reporterEvent(state, "turn.started");
    state = reporterEvent(state, "tool.started", { operationId: "rejected-tool" });

    state = reporterEvent(state, "turn.settled", { data: { activeCount: 0 } });

    expect(state).toMatchObject({
      state: "idle",
      phase: "settled",
      attention: "none",
      openTools: [],
      completionRevision: 1,
    });
  });

  it("keeps explicit waits out of stuck inference until the matching request closes", () => {
    let state = createAgentStatusReducerState("run_1", 1, startedAt);
    state = reporterEvent(state, "turn.started");
    state = reporterEvent(state, "wait.opened", {
      requestId: "request_1",
      data: {
        waitKind: "permission",
        summary: "Permission required",
        replyChannel: "terminal",
      },
    });
    state = reduceAgentStatus(state, {
      event: "lease.probed",
      eventId: "probe_1",
      observedAt: "2026-08-11T13:00:00.000Z",
    });
    state = reduceAgentStatus(state, {
      event: "lease.probed",
      eventId: "probe_2",
      observedAt: "2026-08-11T13:01:00.000Z",
    });
    expect(state).toMatchObject({ state: "blocked", attention: "decision_required" });

    state = reporterEvent(state, "tool.started", { operationId: "parallel-tool" });
    state = reduceAgentStatus(state, {
      event: "progress.reported",
      eventId: "progress-during-wait",
      observedAt: "2026-08-11T13:02:00.000Z",
      report: { stage: "blocked", summary: "Waiting for approval" },
    });
    expect(state).toMatchObject({ state: "blocked", attention: "decision_required" });

    state = reporterEvent(state, "wait.closed", { requestId: "request_1" });
    expect(state).toMatchObject({ state: "working", attention: "none", openWaits: [] });
  });

  it.each([
    ["question", "input_required"],
    ["elicitation", "input_required"],
    ["permission", "decision_required"],
    ["plan_approval", "decision_required"],
  ] as const)("classifies an explicit %s wait as %s", (waitKind, attention) => {
    const state = reporterEvent(
      createAgentStatusReducerState("run_1", 1, startedAt),
      "wait.opened",
      {
        requestId: `request-${waitKind}`,
        data: {
          waitKind,
          summary: "Agent requires operator input",
          replyChannel: "terminal",
        },
      },
    );

    expect(state).toMatchObject({ state: "blocked", attention });
  });

  it("requires two expired progress probes before suspecting a stuck agent", () => {
    let state = createAgentStatusReducerState("run_1", 1, startedAt);
    state = reporterEvent(state, "turn.started");
    state = reduceAgentStatus(state, {
      event: "lease.probed",
      eventId: "probe_1",
      observedAt: "2026-08-11T12:01:00.000Z",
    });
    expect(state.state).toBe("working");
    state = reduceAgentStatus(state, {
      event: "lease.probed",
      eventId: "probe_2",
      observedAt: "2026-08-11T12:02:00.000Z",
    });
    expect(state).toMatchObject({
      state: "suspected_stuck",
      attention: "progress_stale",
      confidence: "low",
    });
  });

  it("does not let heartbeats suppress progress-stuck detection", () => {
    let state = reporterEvent(createAgentStatusReducerState("run_1", 1, startedAt), "turn.started");
    state = reduceAgentStatus(state, {
      event: "lease.probed",
      eventId: "probe_1",
      observedAt: "2026-08-11T12:01:00.000Z",
    });
    state = reporterEvent(state, "heartbeat", {
      observedAt: "2026-08-11T12:01:15.000Z",
    });
    expect(state.staleProbeCount).toBe(1);
    state = reduceAgentStatus(state, {
      event: "lease.probed",
      eventId: "probe_2",
      observedAt: "2026-08-11T12:02:00.000Z",
    });

    expect(state).toMatchObject({
      state: "suspected_stuck",
      attention: "progress_stale",
      confidence: "low",
    });
  });

  it("uses a recognized live process as a low-confidence idle fallback", () => {
    let state = createAgentStatusReducerState("run_1", 1, startedAt);
    state = reduceAgentStatus(state, {
      event: "process.alive",
      eventId: "alive_1",
      observedAt: startedAt,
      process: {
        foregroundPgid: 100,
        leaderPid: 100,
        pidStartIdentity: "100:50",
        executableFingerprint: "a".repeat(64),
        argvFingerprint: "b".repeat(64),
        processFingerprint: "c".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["claude"],
      },
    });
    state = reduceAgentStatus(state, {
      event: "lease.probed",
      eventId: "probe_1",
      observedAt: "2026-08-11T12:01:00.000Z",
    });
    expect(state).toMatchObject({
      state: "idle",
      phase: "settled",
      confidence: "low",
      attention: "none",
      authorityKind: "process",
      processState: "present",
      interactiveReady: true,
    });
  });

  it("does not treat a mismatched foreground process as an idle provider", () => {
    const state = reduceAgentStatus(createAgentStatusReducerState("run_1", 1, startedAt), {
      event: "process.alive",
      eventId: "alive_mismatch",
      observedAt: startedAt,
      process: {
        foregroundPgid: 100,
        leaderPid: 100,
        pidStartIdentity: "100:50",
        executableFingerprint: "a".repeat(64),
        argvFingerprint: "b".repeat(64),
        processFingerprint: "c".repeat(64),
        expectedProviderMatch: "mismatch",
        wrapperChain: ["bash"],
      },
    });

    expect(state).toMatchObject({
      state: "starting",
      phase: "startup",
      processState: "present",
      interactiveReady: false,
      staleAuthority: true,
    });
  });

  it("clears reporter semantics when process authority is invalidated", () => {
    let reporterState = reporterEvent(
      createAgentStatusReducerState("run_1", 1, startedAt),
      "turn.started",
    );
    reporterState = reporterEvent(reporterState, "tool.started", {
      operationId: "tool-before-replacement",
    });
    reporterState = reporterEvent(reporterState, "wait.opened", {
      requestId: "wait-before-replacement",
      data: {
        waitKind: "permission",
        summary: "Old process permission",
        replyChannel: "terminal",
      },
    });
    reporterState = {
      ...reporterState,
      outcome: "failed",
      cleanEndSeen: true,
      lastProgressSummary: "Old process progress",
      progressStage: "implementation",
      nextStep: "Old process next step",
      blocker: "Old process blocker",
    };
    const invalidated = reduceAgentStatus(reporterState, {
      event: "process.alive",
      eventId: "replacement",
      observedAt: "2026-08-11T12:00:15.000Z",
      reporterAuthorityInvalid: true,
      process: {
        foregroundPgid: 200,
        leaderPid: 200,
        pidStartIdentity: "200:75",
        executableFingerprint: "d".repeat(64),
        argvFingerprint: "e".repeat(64),
        processFingerprint: "f".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["claude"],
      },
    });

    expect(invalidated).toMatchObject({
      state: "unknown",
      phase: "startup",
      attention: "reporter_stale",
      confidence: "low",
      authorityKind: "none",
      staleAuthority: true,
      interactiveReady: false,
      processState: "present",
      outcome: "unknown",
      cleanEndSeen: false,
      openTools: [],
      openWaits: [],
      staleProbeCount: 0,
    });
    expect(invalidated.reporterEpoch).toBeUndefined();
    expect(invalidated.reporterLeaseExpiresAt).toBeUndefined();
    expect(invalidated.readinessCoverage).toBeUndefined();
    expect(invalidated.lastProgressSummary).toBeUndefined();
    expect(invalidated.blocker).toBeUndefined();
  });

  it("does not erase healthy idle reporter authority because time passes", () => {
    let state = reporterEvent(
      createAgentStatusReducerState("run_1", 1, startedAt),
      "session.ready",
    );
    state = reduceAgentStatus(state, {
      event: "lease.probed",
      eventId: "probe_after_reporter_lease",
      observedAt: "2026-08-11T13:01:00.000Z",
    });

    expect(state).toMatchObject({
      state: "idle",
      attention: "none",
      confidence: "high",
      authorityKind: "reporter",
      staleAuthority: false,
    });
  });

  it("classifies unexpected exit as failed and operator exit as stopped", () => {
    const working = reporterEvent(
      createAgentStatusReducerState("run_1", 1, startedAt),
      "turn.started",
    );
    expect(
      reduceAgentStatus(working, {
        event: "process.exited",
        eventId: "exit_1",
        observedAt: "2026-08-11T12:00:05.000Z",
        exitCode: 0,
      }),
    ).toMatchObject({ state: "failed", outcome: "failed", processExitCode: 0 });
    expect(
      reduceAgentStatus(working, {
        event: "process.exited",
        eventId: "exit_2",
        observedAt: "2026-08-11T12:00:05.000Z",
        signal: "SIGTERM",
        operatorStopped: true,
      }),
    ).toMatchObject({ state: "stopped", outcome: "cancelled", processSignal: "SIGTERM" });
  });

  it("keeps a clean semantic end idle until the supervised process exits", () => {
    let state = reporterEvent(createAgentStatusReducerState("run_1", 1, startedAt), "turn.started");
    state = reporterEvent(state, "session.ended");
    expect(state).toMatchObject({
      state: "idle",
      phase: "settled",
      cleanEndSeen: true,
    });

    state = reporterEvent(state, "session.ready");
    expect(state.cleanEndSeen).toBe(false);
    state = reporterEvent(state, "session.ended");

    state = reduceAgentStatus(state, {
      event: "process.exited",
      eventId: "clean-exit",
      observedAt: "2026-08-11T12:00:05.000Z",
      exitCode: 0,
    });
    expect(state).toMatchObject({ state: "stopped", phase: "exited" });
  });

  it("records progress separately from process state", () => {
    const state = reduceAgentStatus(createAgentStatusReducerState("run_1", 1, startedAt), {
      event: "progress.reported",
      eventId: "progress_1",
      observedAt: "2026-08-11T12:00:05.000Z",
      report: {
        stage: "implementation",
        summary: "Reducer implemented",
        nextStep: "Add persistence",
      },
    });
    expect(state).toMatchObject({
      state: "working",
      progressStage: "implementation",
      lastProgressSummary: "Reducer implemented",
      nextStep: "Add persistence",
    });
  });
});
