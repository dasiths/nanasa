import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStatusQueryService } from "../src/agent-status-query-service.js";
import { ProcessIdentityObserver } from "../src/process-identity-observer.js";
import { ReporterRegistry } from "../src/reporter-registry.js";
import { ScreenStatusClassifier } from "../src/screen-status-classifier.js";
import { TmuxEventObserver } from "../src/tmux-event-observer.js";
import { NanasaStore } from "../src/store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { store: NanasaStore; run: AgentRun; registry: ReporterRegistry } {
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
  const registry = new ReporterRegistry(store, { runtimeDirectory: "/runtime" });
  registry.open(run);
  store.bindReporterProcess(run.id, run.generation, "a".repeat(64));
  store.recordProcessStatus(run.id, {
    event: "process.alive",
    eventId: "alive",
    observedAt: "2026-08-29T12:00:00.000Z",
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
    adapterId: "claude-code",
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

describe("Phase 4 reporter authority", () => {
  it("rejects wrong identity, reordered sequence, native session changes, process reuse, and post-exit reports", () => {
    const { store, run } = fixture();
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
    expect(() =>
      store.ingestAgentStatusEvent(identity, {
        ...report(run, 2, "turn.started"),
        reporterEpoch: "epoch-expired",
      }),
    ).toThrowError(expect.objectContaining({ code: "status_reporter_lease_expired" }));
    store.updateRunStatus(run.id, "failed");
    expect(() =>
      store.ingestAgentStatusEvent(identity, report(run, 3, "turn.started")),
    ).toThrowError(expect.objectContaining({ code: "status_generation_fenced" }));
    store.close();
  });

  it("projects every canonical semantic state and per-operator completion acknowledgement", () => {
    const { store, run } = fixture();
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
    expect(store.getAgentStatus(run.groupId, run.memberId).state).toBe("starting");
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
    store.recordProcessStatus(run.id, {
      event: "lease.probed",
      eventId: "stale-one",
      observedAt: "2099-08-29T12:00:00.000Z",
    });
    expect(store.getAgentStatus(run.groupId, run.memberId).state).toBe("unknown");
    store.recordProcessStatus(run.id, {
      event: "process.exited",
      eventId: "exit",
      observedAt: "2099-08-29T12:00:01.000Z",
      signal: "SIGKILL",
    });
    expect(store.getAgentStatus(run.groupId, run.memberId).state).toBe("failed");
    store.close();
  });
});

describe("Phase 4 process, hook, screen, privacy, and scale behavior", () => {
  it("binds PID start identity through wrappers and changes fingerprints on PID reuse", async () => {
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
    writeProcess(100, 100, 100, 51, ["env", "claude", "--resume", "one"]);
    expect((await observer.observe(100, adapter)).processFingerprint).not.toBe(
      first.processFingerprint,
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
