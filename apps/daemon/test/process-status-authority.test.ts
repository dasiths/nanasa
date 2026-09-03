import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStatusQueryService } from "../src/agent-status-query-service.js";
import { AgentStatusService } from "../src/agent-status-service.js";
import { ProcessIdentityObserver } from "../src/process-identity-observer.js";
import { ReporterRegistry } from "../src/reporter-registry.js";
import { ScreenStatusClassifier } from "../src/screen-status-classifier.js";
import { DomainError, NanasaStore } from "../src/store.js";
import { TmuxEventObserver } from "../src/tmux-event-observer.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const reporterAuthority = {
  reporterPolicy: async () => ({
    integrationId: "claude-code",
    adapterId: "nanasa.claude-code-v2",
    reporterId: "claude-hooks",
    source: "claude-code",
    reporterVersion: "2",
    events: ["session.ready", "turn.started", "turn.waiting", "turn.settled"],
  }),
};

async function fixture(): Promise<{
  store: NanasaStore;
  run: AgentRun;
  registry: ReporterRegistry;
}> {
  const store = new NanasaStore(":memory:");
  const group = store.createGroup({ name: "Status" });
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
  const run = store.createRunForMembership(group.id, "worker").run;
  const registry = new ReporterRegistry(store, {
    runtimeDirectory: "/runtime",
    authority: reporterAuthority,
  });
  await registry.open(run);
  store.bindReporterProcess(run.id, run.generation, "a".repeat(64));
  store.recordProcessStatus(run.id, {
    event: "process.alive",
    eventId: "alive",
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
  return { store, run: store.getRun(run.id), registry };
}

function report(
  run: AgentRun,
  sequence: number,
  event: "session.ready" | "turn.started" | "turn.waiting" | "turn.settled",
) {
  return {
    version: 2 as const,
    eventId: `event-${sequence}`,
    providerId: "claude-code",
    adapterId: "nanasa.claude-code-v2",
    reporterId: "claude-hooks",
    source: "claude-code" as const,
    protocolVersion: 2 as const,
    reporterVersion: "2",
    runId: run.id,
    generation: run.generation,
    reporterEpoch: "epoch-fixed",
    sourceSequence: sequence,
    event,
    data: {},
  };
}

describe("reporter authority", () => {
  it("rejects wrong identity, reordered sequence, native session changes, process reuse, and post-exit reports", async () => {
    const { store, run } = await fixture();
    const session = store.getCurrentReporterSession(run.id, run.generation)!;
    store.revokeReporterAuthority(run.id, run.generation, "replace deterministic fixture");
    store.registerReporterSession({
      ...session,
      id: "reporter-fixed",
      reporterEpoch: "epoch-fixed",
      sourceSequence: 0,
      revokedAt: undefined,
      closedAt: undefined,
    });
    store.bindReporterProcess(run.id, run.generation, "a".repeat(64));
    const identity = {
      groupId: run.groupId,
      memberId: run.memberId,
      runId: run.id,
      generation: run.generation,
    };
    const first = {
      ...report(run, 1, "session.ready"),
      nativeSessionId: "native-one",
    };
    expect(store.ingestAgentStatusEvent(identity, first).status.state).toBe("idle");
    expect(() =>
      store.ingestAgentStatusEvent(identity, report(run, 1, "turn.started")),
    ).toThrowError(expect.objectContaining({ code: "status_sequence_reordered" }));
    for (const mutation of [
      { providerId: "other" },
      { adapterId: "pi" },
      { reporterId: "other-reporter" },
      { source: "pi" },
      { reporterVersion: "1" },
      { reporterEpoch: "epoch-stale" },
      { runId: "run-stale" },
      { generation: 2 },
    ]) {
      expect(() =>
        store.ingestAgentStatusEvent(identity, {
          ...report(run, 2, "turn.started"),
          ...mutation,
        } as never),
      ).toThrowError(expect.objectContaining({ code: "status_reporter_identity_fenced" }));
    }
    expect(() =>
      store.ingestAgentStatusEvent(identity, {
        ...report(run, 2, "turn.started"),
        nativeSessionId: "native-two",
      }),
    ).toThrowError(expect.objectContaining({ code: "status_native_session_fenced" }));
    expect(() =>
      store.ingestAgentStatusEvent(identity, {
        ...report(run, 2, "turn.started"),
        protocolVersion: 1,
      } as never),
    ).toThrow();
    expect(() => store.bindReporterProcess(run.id, run.generation, "d".repeat(64))).toThrowError(
      expect.objectContaining({ code: "status_process_fingerprint_changed" }),
    );
    expect(() =>
      store.ingestAgentStatusEvent(identity, report(run, 2, "turn.started")),
    ).toThrowError();
    store.registerReporterSession({
      ...session,
      id: "reporter-expired",
      reporterEpoch: "epoch-expired",
      sourceSequence: 0,
      processFingerprint: "a".repeat(64),
      openedAt: "2020-01-01T00:00:00.000Z",
      leaseExpiresAt: "2020-01-01T00:00:01.000Z",
      revokedAt: undefined,
      closedAt: undefined,
    });
    store.recordProcessStatus(run.id, {
      event: "process.alive",
      eventId: "expired-reporter-process-refresh",
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
    expect(
      store.ingestAgentStatusEvent(identity, {
        ...report(run, 2, "turn.started"),
        reporterEpoch: "epoch-expired",
      }),
    ).toMatchObject({ accepted: true, status: { state: "working" } });
    expect(
      Date.parse(store.getCurrentReporterSession(run.id, run.generation)!.leaseExpiresAt),
    ).toBeGreaterThan(Date.parse("2020-01-01T00:00:01.000Z"));
    store.updateRunStatus(run.id, "failed");
    expect(() =>
      store.ingestAgentStatusEvent(identity, report(run, 3, "turn.started")),
    ).toThrowError(expect.objectContaining({ code: "status_generation_fenced" }));
    store.close();
  });

  it("projects every canonical semantic state and per-operator completion acknowledgement", async () => {
    const { store, run } = await fixture();
    const session = store.getCurrentReporterSession(run.id, run.generation)!;
    store.revokeReporterAuthority(run.id, run.generation, "replace deterministic fixture");
    store.registerReporterSession({
      ...session,
      id: "reporter-fixed",
      reporterEpoch: "epoch-fixed",
      sourceSequence: 0,
      revokedAt: undefined,
      closedAt: undefined,
    });
    store.bindReporterProcess(run.id, run.generation, "a".repeat(64));
    const identity = {
      groupId: run.groupId,
      memberId: run.memberId,
      runId: run.id,
      generation: run.generation,
    };
    expect(store.getAgentStatus(run.groupId, run.memberId)).toMatchObject({
      state: "idle",
      confidence: "low",
      authorityKind: "process",
    });
    store.ingestAgentStatusEvent(identity, report(run, 1, "session.ready"));
    expect(store.getAgentStatus(run.groupId, run.memberId).state).toBe("idle");
    store.ingestAgentStatusEvent(identity, report(run, 2, "turn.started"));
    expect(store.getAgentStatus(run.groupId, run.memberId).state).toBe("working");
    store.ingestAgentStatusEvent(identity, report(run, 3, "turn.waiting"));
    expect(store.getAgentStatus(run.groupId, run.memberId).state).toBe("waiting");
    store.ingestAgentStatusEvent(identity, {
      ...report(run, 4, "turn.started"),
      eventId: "working-two",
    });
    store.ingestAgentStatusEvent(identity, {
      ...report(run, 5, "turn.settled"),
      eventId: "settled",
    });
    const queries = new AgentStatusQueryService(store);
    expect(queries.get(run.groupId, run.memberId, "operator-one")).toMatchObject({
      state: "idle",
      completionPending: true,
      completionRevision: 1,
    });
    expect(queries.acknowledgeCompletion(run.groupId, run.memberId, "operator-one")).toMatchObject({
      completionPending: false,
    });
    expect(queries.get(run.groupId, run.memberId, "operator-two").completionPending).toBe(true);
    const authority = { instanceId: "instance_status_test", daemonEpoch: 1 };
    expect(
      store
        .getSnapshot(authority, "operator-one")
        .agentStatuses.find((status) => status.runId === run.id),
    ).toMatchObject({
      operatorAcknowledgedCompletionRevision: 1,
      completionPending: false,
    });
    expect(
      store
        .getSnapshot(authority, "operator-two")
        .agentStatuses.find((status) => status.runId === run.id),
    ).toMatchObject({
      operatorAcknowledgedCompletionRevision: 0,
      completionPending: true,
    });
    expect(store.listEvents().at(-1)).toMatchObject({
      type: "agent-status.completion-acknowledged",
      aggregateType: "run",
      aggregateId: run.id,
      payload: { generation: run.generation, completionRevision: 1 },
    });
    expect(store.listEvents().at(-1)?.payload).not.toHaveProperty("operatorId");
    store.recordProcessStatus(run.id, {
      event: "lease.probed",
      eventId: "stale-one",
      observedAt: "2099-08-29T12:00:00.000Z",
    });
    expect(store.getAgentStatus(run.groupId, run.memberId)).toMatchObject({
      state: "idle",
      authorityKind: "reporter",
      attention: "none",
    });
    store.recordProcessStatus(run.id, {
      event: "process.exited",
      eventId: "exit",
      observedAt: "2099-08-29T12:00:01.000Z",
      signal: "SIGKILL",
    });
    expect(store.getAgentStatus(run.groupId, run.memberId).state).toBe("failed");
    store.close();
  });

  it("rejects reporter renewal when process-source evidence is stale", async () => {
    const { store, run } = await fixture();
    const session = store.getCurrentReporterSession(run.id, run.generation)!;
    store.revokeReporterAuthority(run.id, run.generation, "replace deterministic fixture");
    store.registerReporterSession({
      ...session,
      id: "reporter-stale-process",
      reporterEpoch: "epoch-fixed",
      sourceSequence: 0,
      openedAt: "2020-01-01T00:00:00.000Z",
      leaseExpiresAt: "2020-01-01T00:00:01.000Z",
      revokedAt: undefined,
      closedAt: undefined,
    });
    store.bindReporterProcess(run.id, run.generation, "a".repeat(64));
    store.recordProcessStatus(run.id, {
      event: "process.alive",
      eventId: "stale-process-evidence",
      observedAt: "2020-01-01T00:00:00.000Z",
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

    expect(() =>
      store.ingestAgentStatusEvent(
        {
          groupId: run.groupId,
          memberId: run.memberId,
          runId: run.id,
          generation: run.generation,
        },
        { ...report(run, 1, "session.ready"), reporterEpoch: "epoch-fixed" },
      ),
    ).toThrowError(expect.objectContaining({ code: "status_process_unverified" }));
    store.close();
  });
});

describe("process, hook, screen, privacy, and scale behavior", () => {
  it("includes process evidence in fingerprints and detects PID reuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "nanasa-proc-"));
    roots.push(root);
    const writeProcess = (
      pid: number,
      pgrp: number,
      foreground: number,
      start: number,
      argv: string[],
    ) => {
      const directory = join(root, String(pid));
      mkdirSync(join(directory, "task", String(pid)), { recursive: true });
      const fields = [
        "S",
        "1",
        String(pgrp),
        "0",
        "0",
        String(foreground),
        ...Array(13).fill("0"),
        String(start),
        "0",
      ];
      writeFileSync(join(directory, "stat"), `${pid} (process) ${fields.join(" ")}`);
      writeFileSync(join(directory, "cmdline"), `${argv.join("\0")}\0`);
      writeFileSync(join(directory, "task", String(pid), "children"), "");
    };
    writeProcess(100, 100, 100, 50, ["env", "claude", "--resume", "one"]);
    const observer = new ProcessIdentityObserver({ procRoot: root });
    const adapter = {
      recognizeCommand: (argv: readonly string[]) => argv.includes("claude"),
    } as never;
    const first = await observer.observe(100, adapter);
    expect(first).toMatchObject({
      foregroundPgid: 100,
      pidStartIdentity: "100:50",
      expectedProviderMatch: "match",
    });
    writeProcess(100, 100, 100, 50, ["env", "claude", "--resume", "two"]);
    const retitled = await observer.observe(100, adapter);
    expect(retitled.processFingerprint).not.toBe(first.processFingerprint);
    expect(retitled.argvFingerprint).not.toBe(first.argvFingerprint);
    writeProcess(100, 100, 100, 51, ["env", "claude", "--resume", "one"]);
    expect((await observer.observe(100, adapter)).processFingerprint).not.toBe(
      first.processFingerprint,
    );
  });

  it("retains reporter authority when mutable evidence changes for the same kernel process", async () => {
    const { store, run, registry } = await fixture();
    const changedEvidence = {
      foregroundPgid: 10,
      leaderPid: 10,
      pidStartIdentity: "10:100",
      executableFingerprint: "d".repeat(64),
      argvFingerprint: "e".repeat(64),
      processFingerprint: "f".repeat(64),
      expectedProviderMatch: "match" as const,
      wrapperChain: ["claude"],
    };

    await expect(registry.observeProcess(run, changedEvidence)).resolves.toBeUndefined();
    expect(store.getCurrentReporterSession(run.id, run.generation)?.processFingerprint).toBe(
      changedEvidence.processFingerprint,
    );
    store.recordProcessStatus(run.id, {
      event: "process.alive",
      eventId: "legacy-alive-without-process",
      observedAt: "2026-08-29T12:00:01.000Z",
    });
    await expect(
      registry.observeProcess(run, {
        ...changedEvidence,
        executableFingerprint: "8".repeat(64),
        processFingerprint: "7".repeat(64),
      }),
    ).resolves.toBeUndefined();
    await expect(
      registry.observeProcess(run, {
        ...changedEvidence,
        pidStartIdentity: "10:101",
        processFingerprint: "9".repeat(64),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "status_process_fingerprint_changed" }));
    store.close();
  });

  it("renews no-heartbeat reporter freshness from matching process evidence", async () => {
    let now = new Date("2026-08-29T12:10:00.000Z");
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Status" });
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
    const run = store.createRunForMembership(group.id, "worker").run;
    const registry = new ReporterRegistry(store, {
      runtimeDirectory: "/runtime",
      authority: reporterAuthority,
      now: () => now,
    });
    const opened = await registry.open(run);
    now = new Date("2026-08-29T12:11:00.000Z");
    const process = {
      foregroundPgid: 10,
      leaderPid: 10,
      pidStartIdentity: "10:100",
      executableFingerprint: "b".repeat(64),
      argvFingerprint: "c".repeat(64),
      processFingerprint: "a".repeat(64),
      expectedProviderMatch: "match" as const,
      wrapperChain: ["claude"],
    };

    await registry.observeProcess(run, process);

    expect(store.getCurrentReporterSession(run.id, run.generation)?.leaseExpiresAt).toBe(
      new Date(now.getTime() + 45_000).toISOString(),
    );
    expect(Date.parse(opened.leaseExpiresAt)).toBeLessThan(
      Date.parse(store.getCurrentReporterSession(run.id, run.generation)!.leaseExpiresAt),
    );
    store.close();
  });

  it("supersedes persisted waits when reporter authority is revoked", async () => {
    const { store, run } = await fixture();
    const session = store.getCurrentReporterSession(run.id, run.generation)!;
    store.revokeReporterAuthority(run.id, run.generation, "replace deterministic fixture");
    store.registerReporterSession({
      ...session,
      id: "reporter-wait",
      reporterEpoch: "epoch-fixed",
      sourceSequence: 0,
      revokedAt: undefined,
      closedAt: undefined,
    });
    store.bindReporterProcess(run.id, run.generation, "a".repeat(64));
    const identity = {
      groupId: run.groupId,
      memberId: run.memberId,
      runId: run.id,
      generation: run.generation,
    };
    store.ingestAgentStatusEvent(identity, {
      ...report(run, 1, "turn.started"),
      reporterEpoch: "epoch-fixed",
      event: "wait.opened",
      requestId: "permission-one",
      data: {
        waitKind: "permission",
        summary: "Old process permission",
        replyChannel: "terminal",
      },
    });
    expect(store.listOpenWaits(run.groupId, run.memberId)).toHaveLength(1);

    store.revokeReporterAuthority(run.id, run.generation, "process_replaced");

    expect(store.listOpenWaits(run.groupId, run.memberId)).toEqual([
      expect.objectContaining({ providerRequestId: "permission-one", state: "superseded" }),
    ]);
    store.close();
  });

  it("records every verified present observation while deduplicating unchanged failures", async () => {
    const store = {
      getRun: vi.fn(() => ({ id: "run", generation: 1 })),
      recordProcessStatus: vi.fn(),
    };
    const reporters = { observeProcess: vi.fn(), revoke: vi.fn() };
    const service = new AgentStatusService(store as never, reporters as never);
    const process = {
      foregroundPgid: 10,
      leaderPid: 10,
      pidStartIdentity: "10:100",
      executableFingerprint: "a".repeat(64),
      argvFingerprint: "b".repeat(64),
      processFingerprint: "c".repeat(64),
      expectedProviderMatch: "match" as const,
      wrapperChain: ["claude"],
    };

    await service.observeRuntime({
      id: "present-one",
      runId: "run",
      generation: 1,
      state: "present",
      observedAt: "2026-08-29T12:00:00.000Z",
      trigger: "poll",
      evidenceCode: "exact_owned_pane_and_process",
      process,
    });
    await service.observeRuntime({
      id: "present-two",
      runId: "run",
      generation: 1,
      state: "present",
      observedAt: "2026-08-29T12:00:15.000Z",
      trigger: "poll",
      evidenceCode: "exact_owned_pane_and_process",
      process,
    });

    expect(store.recordProcessStatus).toHaveBeenCalledTimes(2);
    expect(reporters.observeProcess).toHaveBeenCalledTimes(2);
  });

  it("records a same-provider process replacement after reporter revocation", async () => {
    const store = {
      getRun: vi.fn(() => ({ id: "run", generation: 1 })),
      recordProcessStatus: vi.fn(),
    };
    const reporters = {
      observeProcess: vi.fn(() => {
        throw new DomainError(
          "status_process_fingerprint_changed",
          "Foreground process changed",
          409,
        );
      }),
      revoke: vi.fn(),
    };
    const service = new AgentStatusService(store as never, reporters as never);
    const process = {
      foregroundPgid: 20,
      leaderPid: 20,
      pidStartIdentity: "20:200",
      executableFingerprint: "d".repeat(64),
      argvFingerprint: "e".repeat(64),
      processFingerprint: "f".repeat(64),
      expectedProviderMatch: "match" as const,
      wrapperChain: ["claude"],
    };

    await expect(
      service.observeRuntime({
        id: "replacement",
        runId: "run",
        generation: 1,
        state: "present",
        observedAt: "2026-08-29T12:00:15.000Z",
        trigger: "poll",
        evidenceCode: "exact_owned_pane_and_process",
        process,
      }),
    ).resolves.toBeUndefined();
    expect(store.recordProcessStatus).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({
        event: "process.alive",
        process,
        reporterAuthorityInvalid: true,
      }),
    );
  });

  it("records provider mismatches without aborting reconciliation", async () => {
    const store = {
      getRun: vi.fn(() => ({ id: "run", generation: 1 })),
      recordProcessStatus: vi.fn(),
    };
    const reporters = {
      observeProcess: vi.fn(() => {
        throw new DomainError(
          "status_process_provider_mismatch",
          "Foreground process does not match provider",
          409,
        );
      }),
      revoke: vi.fn(),
    };
    const service = new AgentStatusService(store as never, reporters as never);
    const process = {
      foregroundPgid: 30,
      leaderPid: 30,
      pidStartIdentity: "30:300",
      executableFingerprint: "1".repeat(64),
      argvFingerprint: "2".repeat(64),
      processFingerprint: "3".repeat(64),
      expectedProviderMatch: "mismatch" as const,
      wrapperChain: ["bash"],
    };

    await expect(
      service.observeRuntime({
        id: "provider-mismatch",
        runId: "run",
        generation: 1,
        state: "present",
        observedAt: "2026-08-29T12:00:15.000Z",
        trigger: "poll",
        evidenceCode: "provider_process_mismatch",
        process,
      }),
    ).resolves.toBeUndefined();
    expect(store.recordProcessStatus).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({
        event: "process.alive",
        process,
        reporterAuthorityInvalid: true,
      }),
    );
  });

  it("uses tmux hooks only as authenticated invalidation triggers", () => {
    const invalidate = vi.fn();
    const observer = new TmuxEventObserver("nanasa", invalidate);
    expect(() => observer.notify("wrong", { serverName: "nanasa", kind: "bell" })).toThrow(
      "unauthorized",
    );
    observer.notify(observer.token(), { serverName: "nanasa", kind: "bell", paneId: "%1" });
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "bell", paneId: "%1" }),
    );
  });

  it("classifies only bounded visible blockers, maps no match to unknown, and persists no raw text", () => {
    const classifier = new ScreenStatusClassifier({
      id: "claude-screen",
      version: "1",
      rules: [
        {
          id: "permission",
          priority: 100,
          classification: "blocked",
          visibleBlocker: true,
          region: { lastLines: 10 },
          all: ["Allow tool?"],
          none: ["quoted example"],
        },
      ],
    });
    const raw = `${"secret transcript\n".repeat(100)}Allow tool?`;
    const blocked = classifier.classify({ runId: "run", generation: 1, paneId: "%1", text: raw });
    expect(blocked).toMatchObject({
      classification: "blocked",
      visibleBlocker: true,
      confidence: "medium",
    });
    expect(JSON.stringify(blocked)).not.toContain("secret transcript");
    expect(blocked.rows).toBeLessThanOrEqual(80);
    expect(blocked.bytes).toBeLessThanOrEqual(65_536);
    expect(
      classifier.classify({ runId: "run", generation: 1, paneId: "%1", text: "ordinary prompt" })
        .classification,
    ).toBe("unknown");
    expect(
      classifier.classify({
        runId: "run",
        generation: 1,
        paneId: "%1",
        text: "quoted example Allow tool?",
        alternateScreen: true,
      }),
    ).toMatchObject({ classification: "unknown", alternateScreen: true });
  });

  it.each([1, 15, 100])("keeps %i-pane classification bounded and metadata-only", (panes) => {
    const classifier = new ScreenStatusClassifier({ id: "scale", version: "1", rules: [] });
    const observations = Array.from({ length: panes }, (_, index) =>
      classifier.classify({
        runId: `run-${index}`,
        generation: 1,
        paneId: `%${index}`,
        text: "x".repeat(100_000),
      }),
    );
    expect(observations).toHaveLength(panes);
    expect(
      observations.every(
        (item) => item.bytes <= 65_536 && item.rows <= 80 && item.classification === "unknown",
      ),
    ).toBe(true);
  });
});
