import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NanasaStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(path = ":memory:") {
  const store = new NanasaStore(path);
  const group = store.createGroup({ name: "Status group" });
  const profile = store.createInternalAgentProfile({
    name: "Claude",
    agentType: "claude-code",
    kind: "claude-code",
    command: "claude",
    args: [],
    environment: {},
  });
  const membership = store.addMembership(group.id, {
    memberId: "worker",
    agentProfileId: profile.id,
    alias: "Worker",
  });
  const run = store.createRun({
    id: "run_status",
    groupId: group.id,
    memberId: membership.memberId,
    agentProfileId: profile.id,
    generation: 1,
    status: "running",
    startedAt: "2026-08-11T12:00:00.000Z",
  });
  store.registerReporterSession({
    id: "reporter_status",
    providerId: "claude-code",
    adapterId: "claude-code",
    reporterId: "claude-hooks",
    source: "claude-code",
    protocolVersion: 2,
    reporterVersion: "2",
    runId: run.id,
    generation: run.generation,
    reporterEpoch: "epoch_status",
    readinessCoverage: "full",
    sourceSequence: 0,
    openedAt: "2026-08-11T12:00:00.000Z",
    leaseExpiresAt: "2099-08-11T12:00:00.000Z",
  });
  store.bindReporterProcess(run.id, run.generation, "a".repeat(64));
  return {
    store,
    group,
    run,
    identity: {
      groupId: group.id,
      memberId: membership.memberId,
      runId: run.id,
      generation: run.generation,
    },
  };
}

function event(
  eventId: string,
  kind: string,
  options: {
    operationId?: string;
    requestId?: string;
    data?: Record<string, unknown>;
    sourceSequence?: number;
  } = {},
) {
  return {
    version: 2 as const,
    eventId,
    providerId: "claude-code",
    adapterId: "claude-code",
    reporterId: "claude-hooks",
    source: "claude-code" as const,
    protocolVersion: 2 as const,
    reporterVersion: "2",
    runId: "run_status",
    generation: 1,
    reporterEpoch: "epoch_status",
    sourceSequence: options.sourceSequence ?? 1,
    event: kind as never,
    operationId: options.operationId,
    requestId: options.requestId,
    data: options.data ?? {},
  };
}

describe("NanasaStore agent status", () => {
  it("ingests semantic events idempotently and publishes material transitions", () => {
    const { store, group, identity } = createFixture();
    const before = store.listEvents().length;

    const ready = store.ingestAgentStatusEvent(identity, event("ready_1", "session.ready"));
    expect(ready).toMatchObject({ duplicate: false, status: { state: "idle" } });
    expect(() =>
      store.ingestAgentStatusEvent(identity, event("ready_1", "session.ready")),
    ).toThrowError(expect.objectContaining({ code: "status_sequence_reordered" }));
    expect(
      store
        .listEvents()
        .slice(before)
        .map((item) => item.type),
    ).toEqual(["agent-status.changed"]);
    expect(store.getSnapshot().agentStatuses).toEqual([
      expect.objectContaining({ groupId: group.id, memberId: "worker", state: "idle" }),
    ]);
    store.close();
  });

  it("persists progress and explicit waits across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-agent-status-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const { store, group, identity } = createFixture(databasePath);

    store.reportAgentProgress(identity, {
      stage: "implementation",
      summary: "Status persistence implemented",
      nextStep: "Add HTTP ingestion",
    });
    store.ingestAgentStatusEvent(
      identity,
      event("wait_1", "wait.opened", {
        requestId: "permission_1",
        data: {
          waitKind: "permission",
          summary: "Permission required",
          replyChannel: "terminal",
        },
      }),
    );
    store.close();

    const reopened = new NanasaStore(databasePath);
    expect(reopened.getAgentStatus(group.id, "worker")).toMatchObject({
      state: "blocked",
      attention: "decision_required",
      lastProgressSummary: "Status persistence implemented",
      nextStep: "Add HTTP ingestion",
      openWait: { requestId: "permission_1" },
    });
    reopened.close();
  });

  it("fences stale generations after the run starts stopping", () => {
    const { store, identity, run } = createFixture();
    store.updateRunStatus(run.id, "stopping");
    expect(() =>
      store.ingestAgentStatusEvent(identity, event("late_1", "turn.started")),
    ).toThrowError(expect.objectContaining({ code: "status_generation_fenced" }));
    store.close();
  });

  it("classifies an unexpected process exit as failed", () => {
    const { store, group, run } = createFixture();
    const status = store.recordProcessStatus(run.id, {
      event: "process.exited",
      eventId: "process_exit_1",
      observedAt: "2026-08-11T12:01:00.000Z",
      signal: "SIGKILL",
    });
    expect(status).toMatchObject({
      state: "failed",
      outcome: "failed",
      attention: "process_failed",
      processSignal: "SIGKILL",
    });
    expect(store.getAgentStatus(group.id, "worker").state).toBe("failed");
    store.close();
  });

  it("synthesizes not-started status for active members without runs", () => {
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Not started" });
    const profile = store.createInternalAgentProfile({
      name: "Pi",
      agentType: "pi",
      kind: "pi",
      command: "pi",
      args: [],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "pi-worker",
      agentProfileId: profile.id,
      alias: "Pi worker",
    });
    const status = store.getAgentStatus(group.id, "pi-worker");
    expect(status).toMatchObject({
      state: "unknown",
      confidence: "high",
    });
    expect(status).not.toHaveProperty("runId");
    store.close();
  });
});
