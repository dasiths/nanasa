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
      version: 1,
      eventId: `event-${event}-${options.operationId ?? options.requestId ?? "one"}`,
      source: "claude-code",
      reporterVersion: "1",
      event: event as never,
      operationId: options.operationId,
      requestId: options.requestId,
      data: options.data ?? {},
    },
  });
}

describe("agent status reducer", () => {
  it("tracks correlated tools and settles only after all work closes", () => {
    let state = createAgentStatusReducerState("run_1", 1, startedAt);
    state = reporterEvent(state, "session.ready");
    expect(state.state).toBe("waiting");

    state = reporterEvent(state, "tool.started", { operationId: "tool_1" });
    state = reporterEvent(state, "tool.started", { operationId: "tool_2" });
    state = reporterEvent(state, "tool.finished", { operationId: "tool_1" });
    expect(state).toMatchObject({ state: "working", phase: "tool", openTools: ["tool_2"] });

    state = reporterEvent(state, "turn.settled");
    expect(state.state).toBe("working");
    state = reporterEvent(state, "tool.finished", { operationId: "tool_2" });
    state = reporterEvent(state, "turn.settled");
    expect(state).toMatchObject({ state: "waiting", phase: "settled", openTools: [] });
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
    expect(state).toMatchObject({ state: "waiting", attention: "decision_required" });

    state = reporterEvent(state, "tool.started", { operationId: "parallel-tool" });
    state = reduceAgentStatus(state, {
      event: "progress.reported",
      eventId: "progress-during-wait",
      observedAt: "2026-08-11T13:02:00.000Z",
      report: { stage: "blocked", summary: "Waiting for approval" },
    });
    expect(state).toMatchObject({ state: "waiting", attention: "decision_required" });

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

    expect(state).toMatchObject({ state: "waiting", attention });
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

  it("treats a long-lived process without reporter events as waiting", () => {
    let state = createAgentStatusReducerState("run_1", 1, startedAt);
    state = reduceAgentStatus(state, {
      event: "process.alive",
      eventId: "alive_1",
      observedAt: startedAt,
    });
    state = reduceAgentStatus(state, {
      event: "lease.probed",
      eventId: "probe_1",
      observedAt: "2026-08-11T12:01:00.000Z",
    });
    expect(state).toMatchObject({
      state: "waiting",
      phase: "settled",
      confidence: "low",
      attention: "none",
    });
  });

  it("classifies unexpected exit as crashed and operator exit as stopped", () => {
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
    ).toMatchObject({ state: "crashed", outcome: "failed", processExitCode: 0 });
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
      state: "waiting",
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
