import type { AgentRun } from "@nanasa/contracts";
import { describe, expect, it, vi } from "vitest";
import { NativeSessionService } from "../src/native-session-service.js";
import { ProviderAdapterRegistry } from "../src/providers/provider-adapter-registry.js";
import { RunRuntimeCoordinator } from "../src/run-runtime-coordinator.js";
import { NanasaStore } from "../src/store.js";

function recoveryStore(): {
  store: NanasaStore;
  run: AgentRun;
  sessions: NativeSessionService;
} {
  const store = new NanasaStore(":memory:");
  const group = store.createGroup({ name: "Recovery" });
  const profile = store.createInternalAgentProfile({
    name: "Copilot",
    agentType: "copilot",
    kind: "copilot",
    command: "copilot",
    args: [],
    environment: {},
  });
  store.addMembership(group.id, {
    memberId: "copilot.agent",
    agentProfileId: profile.id,
    alias: "Copilot",
  });
  const created = store.createRunForMembership(group.id, "copilot.agent").run;
  const run = store.updateRunStatus(created.id, "running", {
    terminal: {
      serverName: "nanasa-test",
      sessionId: "$1",
      windowId: "@1",
      paneId: "%1",
    },
  });
  const sessions = new NativeSessionService(store);
  sessions.observe({
    memberId: run.memberId,
    integrationId: "copilot",
    runId: run.id,
    generation: run.generation,
    adapter: ProviderAdapterRegistry.builtIn().get("copilot"),
    stateRoot: "/state",
    event: {
      version: 1,
      eventId: "session-initial",
      source: "copilot",
      reporterVersion: "1",
      event: "session.ready",
      sessionId: "native-session-one",
      data: { effectiveModel: "provider/model" },
    },
  });
  return { store, run, sessions };
}

function passiveServices() {
  return {
    supervisor: {
      stop: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    dispatcher: {
      start: vi.fn(),
      close: vi.fn(async () => undefined),
    },
  };
}

describe("confirmed native recovery coordination", () => {
  it("adopts an exact live tmux owner and never reserves or resumes a native session", async () => {
    const { store, run, sessions } = recoveryStore();
    const reserve = vi.spyOn(sessions, "reserve");
    const runtime = {
      reconcile: vi.fn(async () => undefined),
      observeRun: vi.fn(async () => ({ kind: "present" })),
      recoverRun: vi.fn(),
      removeStaleViewSessions: vi.fn(async () => undefined),
      ensureViewSession: vi.fn(async () => "view"),
      close: vi.fn(async () => undefined),
    };
    const { supervisor, dispatcher } = passiveServices();
    const coordinator = new RunRuntimeCoordinator(
      store,
      runtime as never,
      supervisor as never,
      dispatcher as never,
      {
        reconcileIntervalMs: 60_000,
        nativeSessions: sessions,
        nativeRecoveryPolicy: () => ({
          integrationId: "copilot",
          policy: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
        }),
      },
    );
    try {
      await coordinator.reconcile();
      expect(store.getRun(run.id).status).toBe("running");
      expect(reserve).not.toHaveBeenCalled();
      expect(runtime.recoverRun).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  it("resumes only after confirmed absence and reports resumed only after process and matching ready evidence", async () => {
    const { store, run, sessions } = recoveryStore();
    const recoverRun = vi.fn(
      async (
        previous: AgentRun,
        _size: unknown,
        options: { nativeSession: unknown; nativeSessionId: string },
      ) => {
        store.updateRunStatus(previous.id, "failed", { reason: "recovery_replaced" });
        const created = store.createRunForMembership(previous.groupId, previous.memberId, {
          recoveryFrom: store.getRun(previous.id),
          launchKind: "resuming",
          nativeSessionId: options.nativeSessionId,
        }).run;
        return store.updateRunStatus(created.id, "running", {
          terminal: {
            serverName: "nanasa-test",
            sessionId: "$1",
            windowId: "@2",
            paneId: "%2",
          },
        });
      },
    );
    const runtime = {
      reconcile: vi.fn(async () => undefined),
      observeRun: vi.fn(async (candidate: AgentRun) =>
        candidate.generation === 1 ? { kind: "missing" } : { kind: "present" },
      ),
      recoverRun,
      removeViewSession: vi.fn(async () => undefined),
      removeStaleViewSessions: vi.fn(async () => undefined),
      ensureViewSession: vi.fn(async () => "view"),
      close: vi.fn(async () => undefined),
    };
    const { supervisor, dispatcher } = passiveServices();
    const coordinator = new RunRuntimeCoordinator(
      store,
      runtime as never,
      supervisor as never,
      dispatcher as never,
      {
        reconcileIntervalMs: 60_000,
        nativeSessions: sessions,
        nativeRecoveryPolicy: () => ({
          integrationId: "copilot",
          policy: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
        }),
      },
    );
    try {
      await coordinator.reconcile();
      expect(recoverRun).not.toHaveBeenCalled();
      await coordinator.reconcile();
      const replacement = store.listDesiredRunningRuns()[0]!;
      expect(recoverRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: run.id }),
        { cols: 120, rows: 40 },
        expect.objectContaining({
          nativeSession: expect.objectContaining({ referenceValue: "native-session-one" }),
        }),
      );
      expect(replacement).toMatchObject({ launchKind: "resuming", recoveryPhase: "resuming" });

      await coordinator.reconcile();
      expect(store.getRun(replacement.id).recoveryPhase).toBe("resuming");

      sessions.observe({
        memberId: replacement.memberId,
        integrationId: "copilot",
        runId: replacement.id,
        generation: replacement.generation,
        adapter: ProviderAdapterRegistry.builtIn().get("copilot"),
        stateRoot: "/state",
        event: {
          version: 1,
          eventId: "session-resumed",
          source: "copilot",
          reporterVersion: "1",
          event: "session.ready",
          sessionId: "native-session-one",
          data: { effectiveModel: "provider/model" },
        },
      });
      await coordinator.reconcile();
      expect(store.getRun(replacement.id)).toMatchObject({
        recoveryPhase: "recovered",
        recoveryOutcome: "resumed",
      });
    } finally {
      await coordinator.close();
      store.close();
    }
  });
});
