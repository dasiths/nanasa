import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun, AgentStatusEventInput } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActionAckService } from "../src/actions/agent-action-ack-service.js";
import { AgentActionScheduler, actionReadiness } from "../src/actions/agent-action-scheduler.js";
import { AgentActionService } from "../src/actions/agent-action-service.js";
import { AgentOpenWaitService } from "../src/actions/agent-open-wait-service.js";
import { AgentWaitService } from "../src/actions/agent-wait-service.js";
import { PeerCapabilityPolicy } from "../src/actions/peer-capability-policy.js";
import { NanasaStore } from "../src/store.js";
import { TerminalControlService } from "../src/terminal/terminal-control-service.js";
import { TerminalInputArbiter } from "../src/terminal/terminal-input-arbiter.js";

const stores: NanasaStore[] = [];
const controls: TerminalControlService[] = [];
const directories: string[] = [];

const waitAuthority = {
  controlPolicy: async () => ({
    waitReplyChannels: ["terminal"],
    supportsPromptAcknowledgement: true,
    supportsCancellation: true,
    terminalSubmitSequence: "\r",
    operations: [],
  }),
  encodeWaitReply: async (
    _run: AgentRun,
    reply: { kind: string; text?: string; option?: string },
  ) => {
    if (reply.kind === "answer") return reply.text ?? "";
    if (reply.kind === "select") return reply.option ?? "";
    return ["allow-once", "approve-plan"].includes(reply.kind) ? "y" : "n";
  },
};

afterEach(() => {
  for (const control of controls.splice(0)) control.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function reporterEvent(
  run: AgentRun,
  sourceSequence: number,
  event: AgentStatusEventInput["event"],
  options: Partial<AgentStatusEventInput> = {},
): AgentStatusEventInput {
  return {
    version: 2,
    eventId: `status_${sourceSequence}_${event}`,
    providerId: "claude-code",
    adapterId: "claude-code",
    reporterId: "claude-hooks",
    source: "claude-code",
    protocolVersion: 2,
    reporterVersion: "2",
    runId: run.id,
    generation: run.generation,
    reporterEpoch: "reporter_epoch_1",
    sourceSequence,
    event,
    data: {},
    ...options,
  };
}

function fixture(path = ":memory:") {
  const store = new NanasaStore(path);
  stores.push(store);
  const daemonEpoch = store.beginDaemonEpoch({
    instanceId: `instance_${Math.random()}`,
    processId: 10,
    processStartedAt: "2026-08-29T12:00:00.000Z",
  });
  const group = store.createGroup({ name: "Actions" });
  const profile = store.createInternalAgentProfile({
    name: "Claude",
    agentType: "claude-code",
    kind: "claude-code",
    command: "claude",
    args: [],
    environment: {},
  });
  store.addMembership(group.id, {
    memberId: "worker",
    agentProfileId: profile.id,
    alias: "Worker",
  });
  const run = store.createRun({
    id: "run_action_1",
    groupId: group.id,
    memberId: "worker",
    agentProfileId: profile.id,
    generation: 1,
    status: "running",
    terminal: {
      serverName: "nanasa-test",
      sessionId: "$1",
      windowId: "@1",
      paneId: "%1",
    } as never,
    startedAt: "2026-08-29T12:00:00.000Z",
  });
  store.registerReporterSession({
    id: "reporter_session_1",
    providerId: "claude-code",
    adapterId: "claude-code",
    reporterId: "claude-hooks",
    source: "claude-code",
    protocolVersion: 2,
    reporterVersion: "2",
    runId: run.id,
    generation: run.generation,
    reporterEpoch: "reporter_epoch_1",
    readinessCoverage: "full",
    sourceSequence: 0,
    openedAt: "2026-08-29T12:00:00.000Z",
    leaseExpiresAt: "2099-08-29T12:00:00.000Z",
  });
  store.bindReporterProcess(run.id, run.generation, "a".repeat(64));
  store.recordProcessStatus(run.id, {
    event: "process.alive",
    eventId: "process_alive_1",
    observedAt: new Date().toISOString(),
    process: {
      foregroundPgid: 10,
      leaderPid: 10,
      pidStartIdentity: "10:100",
      executableFingerprint: "b".repeat(64),
      argvFingerprint: "c".repeat(64),
      processFingerprint: "a".repeat(64),
      expectedProviderMatch: "match",
      wrapperChain: ["claude"],
    },
  });
  store.ingestAgentStatusEvent(
    { groupId: group.id, memberId: "worker", runId: run.id, generation: 1 },
    reporterEvent(run, 1, "session.ready"),
  );
  const control = new TerminalControlService(store);
  controls.push(control);
  const arbiter = new TerminalInputArbiter(control);
  const runtime = {
    observeRun: vi.fn(async () => ({
      id: "observation_1",
      runId: run.id,
      generation: run.generation,
      state: "present" as const,
      observedAt: "2026-08-29T12:00:00.000Z",
      evidenceCode: "exact_owned_pane_and_process",
      process: {
        foregroundPgid: 10,
        leaderPid: 10,
        pidStartIdentity: "10:100",
        executableFingerprint: "b".repeat(64),
        argvFingerprint: "c".repeat(64),
        processFingerprint: "a".repeat(64),
        expectedProviderMatch: "match" as const,
        wrapperChain: ["claude"],
      },
    })),
    pasteToRun: vi.fn(async () => undefined),
  };
  const actions = new AgentActionService(
    store,
    daemonEpoch,
    undefined,
    () => new Date("2026-08-29T12:00:01.000Z"),
  );
  const scheduler = new AgentActionScheduler(
    store,
    runtime,
    arbiter,
    () => new Date("2026-08-29T12:00:02.000Z"),
  );
  const principal = { kind: "operator" as const, operatorId: "operator_1" };
  return {
    store,
    daemonEpoch,
    group,
    profile,
    run,
    control,
    arbiter,
    runtime,
    actions,
    scheduler,
    principal,
  };
}

function createAction(context: ReturnType<typeof fixture>, key = "action-key") {
  return context.actions.create(
    context.principal,
    {
      kind: "prompt",
      groupId: context.group.id,
      memberId: "worker",
      prompt: "Review the exact action",
      allowWorking: false,
    },
    key,
  );
}

describe("durable exact-runtime actions", () => {
  it("serializes event-driven and explicit scheduler ticks before provider writes", async () => {
    const context = fixture();
    context.scheduler.start();
    const action = createAction(context, "scheduler-reentrancy");
    await context.scheduler.tick();

    expect(context.runtime.pasteToRun).toHaveBeenCalledOnce();
    expect(context.store.getAgentAction(action.id).state).toBe("submitted");
    await context.scheduler.close();
  });

  it("keeps terminal injection as submission evidence until fenced reporter acknowledgements", async () => {
    const context = fixture();
    const action = createAction(context);
    await context.scheduler.tick();

    expect(context.runtime.pasteToRun).toHaveBeenCalledOnce();
    expect(context.store.getAgentAction(action.id).state).toBe("submitted");
    expect(context.store.listActionAcknowledgements(action.id)).toEqual([]);

    const acks = new AgentActionAckService(
      context.store,
      () => new Date("2026-08-29T12:00:03.000Z"),
    );
    const reporterPrincipal = {
      kind: "agent" as const,
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
    };
    expect(
      acks.acknowledge(reporterPrincipal, action.id, {
        kind: "accepted",
        sourceSequence: 2,
        providerTurnId: "turn_1",
        completionRevision: 0,
        data: {},
      }).state,
    ).toBe("accepted");
    context.store.ingestAgentStatusEvent(
      reporterPrincipal,
      reporterEvent(context.run, 3, "turn.started", { turnId: "turn_1" }),
    );
    context.store.ingestAgentStatusEvent(
      reporterPrincipal,
      reporterEvent(context.run, 4, "turn.settled", { turnId: "turn_1" }),
    );
    expect(
      acks.acknowledge(reporterPrincipal, action.id, {
        kind: "completed",
        sourceSequence: 5,
        providerTurnId: "turn_1",
        completionRevision: 1,
        data: { summary: "done" },
      }).state,
    ).toBe("completed");
  });

  it("never follows a replacement run and conservatively settles an ambiguous crash window", async () => {
    const context = fixture();
    const replaced = createAction(context, "replacement");
    context.store.updateRunStatus(context.run.id, "stopping");
    context.store.updateRunStatus(context.run.id, "stopped");
    expect(context.store.getAgentAction(replaced.id)).toMatchObject({
      state: "superseded",
      error: { code: "run_stopped" },
    });
    await context.scheduler.tick();
    expect(context.runtime.pasteToRun).not.toHaveBeenCalled();

    const second = fixture();
    const ambiguous = createAction(second, "ambiguous");
    const now = new Date("2026-08-29T12:00:02.000Z");
    second.store.beginAgentActionAttempt({
      id: "attempt_ambiguous",
      actionId: ambiguous.id,
      attempt: 1,
      effect: "terminal-injection",
      state: "submitting",
      daemonEpoch: ambiguous.target.daemonEpoch,
      groupId: ambiguous.target.groupId,
      memberId: ambiguous.target.memberId,
      runId: ambiguous.target.runId,
      generation: ambiguous.target.generation,
      reporterSessionId: ambiguous.target.reporterSessionId,
      reporterId: ambiguous.target.reporterId,
      reporterEpoch: ambiguous.target.reporterEpoch,
      baselineStatusRevision: ambiguous.target.baselineStatusRevision,
      baselineCompletionRevision: ambiguous.target.baselineCompletionRevision,
      terminalBinding: second.run.terminal!,
      terminalBindingFingerprint: "d".repeat(64),
      leaseOwner: "crashed_scheduler",
      leaseExpiresAt: new Date(now.getTime() - 1).toISOString(),
      createdAt: new Date(now.getTime() - 1_000).toISOString(),
      updatedAt: new Date(now.getTime() - 1_000).toISOString(),
    });
    await second.scheduler.tick();
    expect(second.store.getAgentAction(ambiguous.id)).toMatchObject({
      state: "settled-unverified",
      error: { code: "submission_crash_window" },
    });
    expect(second.runtime.pasteToRun).not.toHaveBeenCalled();
  });

  it("dispatches only fresh current interactive idle unless working is explicitly overridden", () => {
    const context = fixture();
    const action = createAction(context);
    const idle = context.store.getAgentStatus(context.group.id, "worker");
    expect(actionReadiness(action, idle, new Date("2026-08-29T12:00:02.000Z"))).toEqual({
      kind: "dispatch",
    });
    for (const [state, code] of [
      ["blocked", "target_blocked"],
      ["unknown", "target_unknown"],
      ["failed", "target_failed"],
      ["stopped", "target_stopped"],
    ] as const) {
      expect(actionReadiness(action, { ...idle, state }, new Date())).toEqual({
        kind: "reject",
        code,
      });
    }
    expect(actionReadiness(action, { ...idle, state: "starting" }, new Date())).toEqual({
      kind: "defer",
      code: "target_starting",
    });
    expect(
      actionReadiness(action, { ...idle, processState: "indeterminate" }, new Date()),
    ).toMatchObject({ kind: "reject", code: "target_process_indeterminate" });
    expect(actionReadiness(action, { ...idle, staleAuthority: true }, new Date())).toMatchObject({
      kind: "reject",
      code: "target_reporter_stale",
    });
    expect(
      actionReadiness(
        { ...action },
        { ...idle, reporterLeaseExpiresAt: "2020-01-01T00:00:00.000Z" },
        new Date(),
      ),
    ).toEqual({ kind: "reject", code: "target_reporter_stale" });
    expect(actionReadiness(action, { ...idle, state: "working" }, new Date())).toMatchObject({
      kind: "reject",
      code: "target_working_override_required",
    });
    expect(
      actionReadiness({ ...action, allowWorking: true }, { ...idle, state: "working" }, new Date()),
    ).toEqual({ kind: "dispatch" });
    expect(
      actionReadiness(
        { ...action, target: { ...action.target, runId: "replacement" } },
        idle,
        new Date(),
      ),
    ).toMatchObject({ kind: "reject", code: "target_identity_mismatch" });
  });

  it("supersedes an action when the exact reporter-bound process is replaced", async () => {
    const context = fixture();
    const action = createAction(context, "process-replaced");
    context.runtime.observeRun.mockResolvedValueOnce({
      id: "replacement_observation",
      runId: context.run.id,
      generation: context.run.generation,
      state: "present",
      observedAt: "2026-08-29T12:00:02.000Z",
      evidenceCode: "exact_owned_pane_and_process",
      process: {
        foregroundPgid: 20,
        leaderPid: 20,
        pidStartIdentity: "20:200",
        executableFingerprint: "d".repeat(64),
        argvFingerprint: "e".repeat(64),
        processFingerprint: "f".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["claude"],
      },
    });

    await context.scheduler.tick();

    expect(context.store.getAgentAction(action.id).state).toBe("superseded");
    expect(context.runtime.pasteToRun).not.toHaveBeenCalled();
  });

  it("revalidates process identity after waiting for terminal input arbitration", async () => {
    const context = fixture();
    const action = createAction(context, "queued-process-replaced");
    let releaseBlocker: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocker = context.arbiter.dispatchAutomated(
      context.run.id,
      () =>
        new Promise<void>((resolve) => {
          releaseBlocker = resolve;
          markStarted?.();
        }),
    );
    await started;

    context.runtime.observeRun.mockResolvedValueOnce({
      id: "queued_replacement_observation",
      runId: context.run.id,
      generation: context.run.generation,
      state: "present",
      observedAt: "2026-08-29T12:00:03.000Z",
      evidenceCode: "exact_owned_pane_and_process",
      process: {
        foregroundPgid: 20,
        leaderPid: 20,
        pidStartIdentity: "20:200",
        executableFingerprint: "d".repeat(64),
        argvFingerprint: "e".repeat(64),
        processFingerprint: "f".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["claude"],
      },
    });
    const tick = context.scheduler.tick();
    await Promise.resolve();
    releaseBlocker?.();
    await blocker;
    await tick;

    expect(context.store.getAgentAction(action.id).state).toBe("superseded");
    expect(context.runtime.pasteToRun).not.toHaveBeenCalled();
  });

  it("rejects cancellation after the terminal-input attempt begins", async () => {
    const context = fixture();
    const action = createAction(context, "cancel-during-process-probe");
    let resolveObservation:
      | ((value: Awaited<ReturnType<typeof context.runtime.observeRun>>) => void)
      | undefined;
    let markObserved: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => {
      markObserved = resolve;
    });
    context.runtime.observeRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveObservation = resolve;
          markObserved?.();
        }),
    );
    const tick = context.scheduler.tick();
    await observed;
    expect(() => context.actions.cancel(context.principal, action.id)).toThrowError(
      expect.objectContaining({ code: "agent_action_submission_in_progress" }),
    );
    resolveObservation?.({
      id: "cancelled_observation",
      runId: context.run.id,
      generation: context.run.generation,
      state: "present",
      observedAt: "2026-08-29T12:00:03.000Z",
      evidenceCode: "exact_owned_pane_and_process",
      process: {
        foregroundPgid: 10,
        leaderPid: 10,
        pidStartIdentity: "10:100",
        executableFingerprint: "b".repeat(64),
        argvFingerprint: "c".repeat(64),
        processFingerprint: "a".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["claude"],
      },
    });
    await tick;

    expect(context.store.getAgentAction(action.id).state).toBe("submitted");
    expect(context.runtime.pasteToRun).toHaveBeenCalledOnce();
  });

  it("waits for exact action states without treating unrelated events as completion", async () => {
    const context = fixture();
    const action = createAction(context);
    const waits = new AgentWaitService(context.store);
    const pending = waits.wait(context.principal, action.id, {
      states: ["cancelled"],
      timeoutMs: 1_000,
    });
    context.store.recordRuntimeEvent("unrelated.changed", "run", context.run.id, {});
    context.actions.cancel(context.principal, action.id);
    await expect(pending).resolves.toMatchObject({ matched: true, action: { state: "cancelled" } });
  });
});

describe("exact provider waits and authority", () => {
  it("accepts exact wait-open retries without duplicating the wait", () => {
    const context = fixture();
    const identity = {
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
    };
    const metadata = {
      requestId: "permission_retried",
      data: {
        waitKind: "permission" as const,
        summary: "Allow one tool?",
        replyChannel: "terminal" as const,
      },
    };
    context.store.ingestAgentStatusEvent(
      identity,
      reporterEvent(context.run, 2, "wait.opened", metadata),
    );
    const wait = context.store.listOpenWaits(context.group.id)[0]!;
    const eventSequence = context.store.listEvents().at(-1)!.sequence;

    expect(
      context.store.ingestAgentStatusEvent(
        identity,
        reporterEvent(context.run, 3, "wait.opened", metadata),
      ),
    ).toMatchObject({ accepted: true });
    expect(context.store.listOpenWaits(context.group.id)).toEqual([wait]);
    expect(
      context.store.listEvents(eventSequence).filter((event) => event.type === "open-wait.changed"),
    ).toEqual([]);
    expect(() =>
      context.store.ingestAgentStatusEvent(
        identity,
        reporterEvent(context.run, 4, "wait.opened", {
          ...metadata,
          data: { ...metadata.data, summary: "Conflicting summary" },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "open_wait_identity_mismatch" }));
  });

  it("keeps a reply transport-only until the reporter closes the exact wait", async () => {
    const context = fixture();
    const identity = {
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
    };
    context.store.ingestAgentStatusEvent(
      identity,
      reporterEvent(context.run, 2, "wait.opened", {
        requestId: "permission_1",
        data: {
          waitKind: "permission",
          summary: "Allow one tool?",
          replyChannel: "terminal",
        },
      }),
    );
    const wait = context.store.listOpenWaits(context.group.id)[0]!;
    expect(
      context.store
        .listEvents()
        .filter((event) => event.type === "open-wait.changed")
        .at(-1),
    ).toMatchObject({
      aggregateType: "open-wait",
      aggregateId: wait.id,
      payload: { wait: { id: wait.id, state: "open" } },
    });
    const service = new AgentOpenWaitService(
      context.store,
      context.runtime,
      context.arbiter,
      waitAuthority,
    );
    await expect(
      service.reply(context.principal, wait.id, {
        expectedRunId: wait.runId,
        expectedGeneration: wait.generation,
        expectedReporterEpoch: wait.reporterEpoch,
        expectedStatusRevision: wait.openedStatusRevision,
        reply: { kind: "allow-once" },
      }),
    ).resolves.toMatchObject({ state: "replying" });
    expect(context.store.getOpenWait(wait.id).state).toBe("replying");
    expect(
      context.store
        .listEvents()
        .filter((event) => event.type === "open-wait.changed")
        .at(-1),
    ).toMatchObject({ payload: { wait: { id: wait.id, state: "replying" } } });
    expect(context.store.resetOpenWaitReply(wait.id)).toMatchObject({ state: "open" });
    expect(
      context.store
        .listEvents()
        .filter((event) => event.type === "open-wait.changed")
        .at(-1),
    ).toMatchObject({ payload: { wait: { id: wait.id, state: "open" } } });
    const rollbackSequence = context.store.listEvents().at(-1)!.sequence;
    expect(context.store.resetOpenWaitReply(wait.id)).toMatchObject({ state: "open" });
    expect(context.store.listEvents(rollbackSequence)).toEqual([]);
    context.store.ingestAgentStatusEvent(
      identity,
      reporterEvent(context.run, 3, "wait.closed", { requestId: "permission_1" }),
    );
    expect(context.store.getOpenWait(wait.id).state).toBe("answered");
    expect(
      context.store
        .listEvents()
        .filter((event) => event.type === "open-wait.changed")
        .at(-1),
    ).toMatchObject({ payload: { wait: { id: wait.id, state: "answered" } } });
  });

  it("invalidates a non-leading exact wait transition without a semantic status change", () => {
    const context = fixture();
    const identity = {
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
    };
    for (const [sourceSequence, requestId] of [
      [2, "permission_leading"],
      [3, "permission_secondary"],
    ] as const) {
      context.store.ingestAgentStatusEvent(
        identity,
        reporterEvent(context.run, sourceSequence, "wait.opened", {
          requestId,
          data: {
            waitKind: "permission",
            summary: "Allow one tool?",
            replyChannel: "terminal",
          },
        }),
      );
    }
    const eventSequence = context.store.listEvents().at(-1)!.sequence;

    context.store.ingestAgentStatusEvent(
      identity,
      reporterEvent(context.run, 4, "wait.closed", { requestId: "permission_secondary" }),
    );

    const transitionEvents = context.store.listEvents(eventSequence);
    expect(transitionEvents).toHaveLength(1);
    expect(transitionEvents[0]).toMatchObject({
      type: "open-wait.changed",
      payload: {
        wait: { providerRequestId: "permission_secondary", state: "answered" },
      },
    });
    expect(context.store.getAgentStatus(context.group.id, "worker").openWait).toMatchObject({
      requestId: "permission_leading",
    });
  });

  it("revalidates an exact wait after queued terminal arbitration", async () => {
    const context = fixture();
    const identity = {
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
    };
    context.store.ingestAgentStatusEvent(
      identity,
      reporterEvent(context.run, 2, "wait.opened", {
        requestId: "permission_queued",
        data: {
          waitKind: "permission",
          summary: "Allow queued tool?",
          replyChannel: "terminal",
        },
      }),
    );
    const wait = context.store.listOpenWaits(context.group.id)[0]!;
    const service = new AgentOpenWaitService(
      context.store,
      context.runtime,
      context.arbiter,
      waitAuthority,
    );
    let releaseBlocker: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocker = context.arbiter.dispatchAutomated(
      context.run.id,
      () =>
        new Promise<void>((resolve) => {
          releaseBlocker = resolve;
          markStarted?.();
        }),
    );
    await started;
    const reply = service.reply(context.principal, wait.id, {
      expectedRunId: wait.runId,
      expectedGeneration: wait.generation,
      expectedReporterEpoch: wait.reporterEpoch,
      expectedStatusRevision: wait.openedStatusRevision,
      reply: { kind: "allow-once" },
    });
    await Promise.resolve();
    context.store.revokeReporterAuthority(context.run.id, context.run.generation, "replaced");
    expect(
      context.store
        .listEvents()
        .filter((event) => event.type === "open-wait.changed")
        .at(-1),
    ).toMatchObject({
      aggregateId: wait.id,
      payload: { wait: { id: wait.id, state: "superseded" } },
    });
    releaseBlocker?.();
    await blocker;

    await expect(reply).rejects.toThrowError(
      expect.objectContaining({ code: "open_wait_replaced" }),
    );
    expect(context.runtime.pasteToRun).not.toHaveBeenCalled();
    expect(context.store.getOpenWait(wait.id).state).toBe("superseded");
  });

  it("does not reply to a wait superseded during process verification", async () => {
    const context = fixture();
    const identity = {
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
    };
    context.store.ingestAgentStatusEvent(
      identity,
      reporterEvent(context.run, 2, "wait.opened", {
        requestId: "permission_probe",
        data: {
          waitKind: "permission",
          summary: "Allow probed tool?",
          replyChannel: "terminal",
        },
      }),
    );
    const wait = context.store.listOpenWaits(context.group.id)[0]!;
    const service = new AgentOpenWaitService(
      context.store,
      context.runtime,
      context.arbiter,
      waitAuthority,
    );
    let resolveObservation:
      | ((value: Awaited<ReturnType<typeof context.runtime.observeRun>>) => void)
      | undefined;
    let markObserved: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => {
      markObserved = resolve;
    });
    context.runtime.observeRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveObservation = resolve;
          markObserved?.();
        }),
    );
    const reply = service.reply(context.principal, wait.id, {
      expectedRunId: wait.runId,
      expectedGeneration: wait.generation,
      expectedReporterEpoch: wait.reporterEpoch,
      expectedStatusRevision: wait.openedStatusRevision,
      reply: { kind: "allow-once" },
    });
    await observed;
    context.store.revokeReporterAuthority(context.run.id, context.run.generation, "replaced");
    resolveObservation?.({
      id: "superseded_wait_observation",
      runId: context.run.id,
      generation: context.run.generation,
      state: "present",
      observedAt: "2026-08-29T12:00:03.000Z",
      evidenceCode: "exact_owned_pane_and_process",
      process: {
        foregroundPgid: 10,
        leaderPid: 10,
        pidStartIdentity: "10:100",
        executableFingerprint: "b".repeat(64),
        argvFingerprint: "c".repeat(64),
        processFingerprint: "a".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["claude"],
      },
    });

    await expect(reply).rejects.toThrowError(
      expect.objectContaining({ code: "open_wait_replaced" }),
    );
    expect(context.runtime.pasteToRun).not.toHaveBeenCalled();
    expect(context.store.getOpenWait(wait.id).state).toBe("superseded");
  });

  it("reports wait replacement when authority is revoked during terminal input", async () => {
    const context = fixture();
    const identity = {
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
    };
    context.store.ingestAgentStatusEvent(
      identity,
      reporterEvent(context.run, 2, "wait.opened", {
        requestId: "permission_during_input",
        data: {
          waitKind: "permission",
          summary: "Allow active tool?",
          replyChannel: "terminal",
        },
      }),
    );
    const wait = context.store.listOpenWaits(context.group.id)[0]!;
    const service = new AgentOpenWaitService(
      context.store,
      context.runtime,
      context.arbiter,
      waitAuthority,
    );
    let releasePaste: (() => void) | undefined;
    let markPasting: (() => void) | undefined;
    const pasting = new Promise<void>((resolve) => {
      markPasting = resolve;
    });
    context.runtime.pasteToRun.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePaste = resolve;
          markPasting?.();
        }),
    );
    const reply = service.reply(context.principal, wait.id, {
      expectedRunId: wait.runId,
      expectedGeneration: wait.generation,
      expectedReporterEpoch: wait.reporterEpoch,
      expectedStatusRevision: wait.openedStatusRevision,
      reply: { kind: "allow-once" },
    });
    await pasting;
    context.store.revokeReporterAuthority(context.run.id, context.run.generation, "replaced");
    releasePaste?.();

    await expect(reply).rejects.toThrowError(
      expect.objectContaining({ code: "open_wait_replaced" }),
    );
    expect(context.store.getOpenWait(wait.id).state).toBe("superseded");
  });

  it("denies peer permission approval, arbitrary keys, peer stops, and unrestricted reads", () => {
    const context = fixture();
    const policy = new PeerCapabilityPolicy();
    const peer = {
      kind: "agent" as const,
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
    };
    const wait = {
      id: "wait_1",
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
      reporterSessionId: "reporter_session_1",
      reporterId: "claude-hooks",
      reporterEpoch: "reporter_epoch_1",
      providerRequestId: "permission_1",
      kind: "permission" as const,
      summary: "Permission",
      replyChannel: "terminal" as const,
      openedStatusRevision: 2,
      state: "open" as const,
      openedAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:00:00.000Z",
    };
    expect(() => policy.assertReply(peer, wait, { kind: "allow-once" })).toThrowError(
      expect.objectContaining({ code: "peer_capability_forbidden" }),
    );
    expect(() => policy.assertNoPeerTerminalOrRunControl(peer)).toThrowError(
      /arbitrary keys, unrestricted terminal reads, or peer run control/,
    );
  });
});

describe("action retention foreign keys", () => {
  it("nulls message links while action retention cascades attempts and acknowledgements", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-actions-retention-"));
    directories.push(directory);
    const context = fixture(join(directory, "nanasa.sqlite"));
    const message = context.store.submitMessage(context.group.id, {
      intent: "request",
      sender: { kind: "operator", operatorId: "operator_1" },
      audience: { kind: "dm", memberId: "worker" },
      body: { contentType: "text/plain", text: "Linked communication" },
      delivery: {},
    });
    const action = context.actions.create(
      context.principal,
      {
        kind: "prompt",
        groupId: context.group.id,
        memberId: "worker",
        prompt: "Linked work",
        messageId: message.message.id,
      },
      "linked-action",
    );
    await context.scheduler.tick();
    const identity = {
      groupId: context.group.id,
      memberId: "worker",
      runId: context.run.id,
      generation: 1,
    };
    context.store.ingestAgentStatusEvent(
      identity,
      reporterEvent(context.run, 2, "wait.opened", {
        actionId: action.id,
        requestId: "question_linked",
        data: {
          waitKind: "question",
          summary: "Clarify linked work",
          replyChannel: "terminal",
        },
      }),
    );
    context.store.clearMessageHistory(context.group.id);
    expect(context.store.getAgentAction(action.id).messageId).toBeUndefined();
    expect(context.store.listOpenWaits(context.group.id)).toMatchObject([
      { actionId: action.id, state: "open" },
    ]);
    context.store.ingestAgentStatusEvent(
      identity,
      reporterEvent(context.run, 3, "wait.closed", { requestId: "question_linked" }),
    );
    context.store.transitionAgentAction(action.id, ["submitted"], "settled-unverified");
    expect(context.store.pruneAgentActions(context.group.id, 0)).toBe(1);
    expect(context.store.listActionAttempts(action.id)).toEqual([]);
    expect(context.store.listOpenWaits(context.group.id)).toEqual([]);
    expect(() => context.store.getAgentAction(action.id)).toThrowError(
      expect.objectContaining({ code: "agent_action_not_found" }),
    );
  });
});
