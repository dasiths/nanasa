import type { AgentProfile, AgentRun } from "@nanasa/contracts";
import { describe, expect, it, vi } from "vitest";

import { RunRuntimeCoordinator } from "../src/run-runtime-coordinator.js";
import { NanasaStore } from "../src/store.js";

const runningRun: AgentRun = {
  id: "run-alpha",
  groupId: "group-one",
  memberId: "alpha",
  agentProfileId: "profile-one",
  generation: 1,
  status: "running",
  desiredState: "running",
  recoveryPhase: "idle",
  terminal: {
    serverName: "nanasa-test",
    sessionId: "$1",
    windowId: "@2",
    paneId: "%3",
  },
  startedAt: "2026-08-09T12:00:00.000Z",
};

describe("RunRuntimeCoordinator", () => {
  it("stops ttyd and removes the view session before killing the owner pane", async () => {
    const operations: string[] = [];
    const stoppedRun: AgentRun = {
      ...runningRun,
      status: "stopped",
      stoppedAt: "2026-08-09T12:01:00.000Z",
    };
    const store = {
      getActiveRun: vi.fn(() => runningRun),
      updateRunStatus: vi.fn((_runId: string, status: AgentRun["status"]) => {
        operations.push(`status:${status}`);
        return { ...runningRun, status };
      }),
    };
    const runtime = {
      stopRun: vi.fn(async () => {
        operations.push("owner-pane:stop");
        return stoppedRun;
      }),
      removeViewSession: vi.fn(async () => {
        operations.push("view-session:remove");
      }),
      close: vi.fn(async () => undefined),
    };
    const supervisor = {
      stop: vi.fn(async () => {
        operations.push("ttyd:stop");
      }),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      runtime as never,
      supervisor as never,
      {
        shutdownRun: vi.fn(async () => {
          operations.push("adapter:shutdown");
        }),
        close: vi.fn(async () => undefined),
      } as never,
      {
        start: vi.fn(),
        close: vi.fn(async () => undefined),
      } as never,
      { reconcileIntervalMs: 60_000 },
    );

    try {
      await expect(coordinator.stopRun(runningRun.groupId, runningRun.memberId)).resolves.toEqual(
        stoppedRun,
      );
      expect(operations).toEqual([
        "status:stopping",
        "adapter:shutdown",
        "ttyd:stop",
        "view-session:remove",
        "owner-pane:stop",
      ]);
    } finally {
      await coordinator.close();
    }
  });

  it("intersects native modes and adds terminal only for current panes on every target", async () => {
    const piProfile: AgentProfile = {
      id: "profile-pi",
      name: "Pi",
      agentType: "pi",
      kind: "pi",
      adapter: "pi-rpc",
      capabilities: ["queue", "steer"],
      command: "pi",
      args: [],
      environment: {},
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    const terminalProfile: AgentProfile = {
      ...piProfile,
      id: "profile-opencode",
      name: "OpenCode",
      agentType: "opencode",
      kind: "opencode",
      adapter: "terminal",
      capabilities: ["queue"],
      command: "opencode",
    };
    const targets = new Map([
      ["alpha", { run: runningRun, profile: piProfile }],
      [
        "beta",
        {
          run: {
            ...runningRun,
            id: "run-beta",
            memberId: "beta",
            agentProfileId: terminalProfile.id,
            terminal: { ...runningRun.terminal!, paneId: "%4" },
          },
          profile: terminalProfile,
        },
      ],
    ]);
    const store = {
      getActiveDeliveryTarget: vi.fn((_groupId: string, memberId: string) => targets.get(memberId)),
    };
    const agentSupervisor = {
      status: vi.fn((_: AgentRun, profile: AgentProfile) => ({
        readiness: "ready",
        capabilities: profile.capabilities,
      })),
      terminalAvailable: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      { close: vi.fn(async () => undefined) } as never,
      { close: vi.fn(async () => undefined) } as never,
      agentSupervisor as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );

    try {
      await expect(
        coordinator.effectiveDeliveryModes("group-one", ["alpha", "beta"]),
      ).resolves.toEqual({ memberIds: ["alpha", "beta"], modes: ["queue", "terminal"] });
      await expect(
        coordinator.effectiveDeliveryModes("group-one", ["alpha", "missing"]),
      ).resolves.toEqual({ memberIds: ["alpha", "missing"], modes: [] });

      agentSupervisor.terminalAvailable.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(
        coordinator.effectiveDeliveryModes("group-one", ["alpha", "beta"]),
      ).resolves.toEqual({ memberIds: ["alpha", "beta"], modes: ["queue"] });
    } finally {
      await coordinator.close();
    }
  });

  it("recovers a missing owner pane into one resumed generation and records recovery phases", async () => {
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Recovery" });
    const profile = store.createInternalAgentProfile({
      name: "Pi",
      agentType: "pi",
      kind: "pi",
      adapter: "pi-rpc",
      capabilities: ["queue", "steer"],
      command: "pi",
      args: [],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "alpha",
      agentProfileId: profile.id,
      alias: "Alpha",
    });
    const { run: starting } = store.createRunForMembership(group.id, "alpha");
    const run = store.updateRunStatus(starting.id, "running", {
      terminal: runningRun.terminal,
    });
    store.updateRunAdapterSession(run.id, run.generation, {
      adapter: "pi-rpc",
      adapterSessionId: "session-one",
      sessionFile: "/tmp/session-one.jsonl",
    });
    const recoverRun = vi.fn(async (previous: AgentRun, preserveAdapterSession: boolean) => {
      store.updateRunStatus(previous.id, "failed", { reason: "recovery_replaced" });
      const created = store.createRunForMembership(group.id, "alpha", {
        recoveryFrom: store.getRun(previous.id),
        preserveAdapterSession,
      }).run;
      return store.updateRunStatus(created.id, "running", {
        terminal: { ...runningRun.terminal!, paneId: "%4", windowId: "@3" },
      });
    });
    const runtime = {
      reconcile: vi.fn(async () => undefined),
      isCurrentRun: vi.fn(async () => false),
      recoverRun,
      removeViewSession: vi.fn(async () => undefined),
      removeStaleViewSessions: vi.fn(async () => undefined),
      ensureViewSession: vi.fn(async () => "view"),
      close: vi.fn(async () => undefined),
    };
    const agentSupervisor = {
      closeRun: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
      status: vi.fn(() => ({ readiness: "ready", capabilities: ["queue", "steer"] })),
      close: vi.fn(async () => undefined),
    };
    const ttyd = {
      stop: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store,
      runtime as never,
      ttyd as never,
      agentSupervisor as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000, now: () => new Date("2026-08-10T12:00:00.000Z") },
    );

    try {
      await coordinator.reconcile(true);
      const replacement = store.listDesiredRunningRuns()[0]!;
      expect(recoverRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: run.id, recoveryAttempts: 1 }),
        true,
        { cols: 120, rows: 40 },
      );
      expect(replacement).toMatchObject({
        generation: 2,
        status: "running",
        recoveryPhase: "recovered",
        recoveryAttempts: 1,
        adapterSessionId: "session-one",
      });
      expect(store.listEvents().map((event) => event.type)).toEqual(
        expect.arrayContaining(["run.recovery-changed", "run.created", "run.status-changed"]),
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  it("marks exhausted missing-pane recovery failed without launching another generation", async () => {
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Exhausted" });
    const profile = store.createInternalAgentProfile({
      name: "Terminal",
      agentType: "opencode",
      kind: "opencode",
      adapter: "terminal",
      capabilities: ["queue"],
      command: "opencode",
      args: [],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "alpha",
      agentProfileId: profile.id,
      alias: "Alpha",
    });
    const run = store.createRun({
      id: "run_exhausted",
      groupId: group.id,
      memberId: "alpha",
      agentProfileId: profile.id,
      generation: 3,
      status: "running",
      recoveryAttempts: 3,
      recoveryPhase: "reconciling",
      startedAt: "2026-08-10T12:00:00.000Z",
    });
    const runtime = {
      reconcile: vi.fn(async () => undefined),
      isCurrentRun: vi.fn(async () => false),
      recoverRun: vi.fn(),
      removeViewSession: vi.fn(async () => undefined),
      stopRun: vi.fn(async () => store.updateRunStatus(run.id, "stopped")),
      removeStaleViewSessions: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store,
      runtime as never,
      {
        stop: vi.fn(async () => undefined),
        reconcile: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as never,
      {
        shutdownRun: vi.fn(async () => undefined),
        reconcile: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );
    try {
      await coordinator.reconcile();
      expect(store.getRun(run.id)).toMatchObject({
        recoveryPhase: "failed",
        recoveryReason: "recovery_attempts_exhausted",
      });
      expect(runtime.recoverRun).not.toHaveBeenCalled();
      await expect(coordinator.stopRun(group.id, "alpha")).resolves.toMatchObject({
        id: run.id,
        desiredState: "stopped",
        recoveryPhase: "idle",
      });
      await coordinator.reconcile();
      expect(runtime.recoverRun).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  it("starts active members in stable order, continues failures, and replays concurrent keys", async () => {
    const memberships = [{ memberId: "alpha" }, { memberId: "beta" }, { memberId: "gamma" }];
    const results = new Map<string, unknown>();
    const active = new Map<string, AgentRun>([["alpha", runningRun]]);
    const store = {
      getGroupStartAllResult: vi.fn((_groupId: string, key: string | undefined) =>
        key === undefined ? undefined : results.get(key),
      ),
      listActiveMemberships: vi.fn(() => memberships),
      getActiveRun: vi.fn((_groupId: string, memberId: string) => active.get(memberId)),
      getLatestRunForMembership: vi.fn((_groupId: string, memberId: string) =>
        active.get(memberId),
      ),
      getAgentProfile: vi.fn(() => ({ id: "profile" })),
      recordGroupStartAllResult: vi.fn((result: unknown, key: string | undefined) => {
        if (key !== undefined) results.set(key, result);
        return result;
      }),
    };
    const runtime = {
      startRun: vi.fn(async (_groupId: string, memberId: string) => {
        if (memberId === "gamma") throw new Error("launch_failed");
        const run = { ...runningRun, id: `run-${memberId}`, memberId };
        active.set(memberId, run);
        return run;
      }),
      ensureViewSession: vi.fn(async () => "view"),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      runtime as never,
      {
        start: vi.fn(),
        unavailable: vi.fn(),
        close: vi.fn(async () => undefined),
      } as never,
      {
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );
    try {
      const [first, replay] = await Promise.all([
        coordinator.startAll("group-one", { cols: 100, rows: 30 }, "same-key"),
        coordinator.startAll("group-one", { cols: 100, rows: 30 }, "same-key"),
      ]);
      expect(first).toEqual(replay);
      expect(first.outcomes).toMatchObject([
        { memberId: "alpha", status: "already-running", runId: "run-alpha" },
        { memberId: "beta", status: "started", runId: "run-beta" },
        { memberId: "gamma", status: "failed", reason: "launch_failed" },
      ]);
      expect(runtime.startRun).toHaveBeenCalledTimes(2);
      expect(store.recordGroupStartAllResult).toHaveBeenCalledTimes(1);
    } finally {
      await coordinator.close();
    }
  });

  it("serializes membership removal behind Start All and stops the started run first", async () => {
    const operations: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let active: AgentRun | undefined;
    const store = {
      getGroupStartAllResult: vi.fn(() => undefined),
      listActiveMemberships: vi.fn(() => [{ memberId: "alpha" }]),
      getActiveRun: vi.fn(() => active),
      getAgentProfile: vi.fn(() => ({ id: "profile" })),
      recordGroupStartAllResult: vi.fn((result: unknown) => result),
      updateRunStatus: vi.fn((_runId: string, status: AgentRun["status"]) => {
        operations.push(`status:${status}`);
        active = active === undefined ? undefined : { ...active, status };
        return active;
      }),
      removeMembership: vi.fn(() => {
        operations.push("membership:remove");
        return { memberId: "alpha" };
      }),
    };
    const runtime = {
      startRun: vi.fn(async () => {
        operations.push("run:start");
        await startGate;
        active = runningRun;
        return runningRun;
      }),
      ensureViewSession: vi.fn(async () => "view"),
      removeViewSession: vi.fn(async () => operations.push("view:remove")),
      stopRun: vi.fn(async () => {
        operations.push("run:stop");
        return { ...runningRun, status: "stopped" };
      }),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      runtime as never,
      {
        start: vi.fn(),
        stop: vi.fn(async () => operations.push("ttyd:stop")),
        close: vi.fn(async () => undefined),
      } as never,
      {
        start: vi.fn(async () => undefined),
        shutdownRun: vi.fn(async () => operations.push("adapter:stop")),
        close: vi.fn(async () => undefined),
      } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );
    try {
      const starting = coordinator.startAll("group-one", { cols: 120, rows: 40 }, "race");
      const removing = coordinator.removeMembership("group-one", "alpha", "remove");
      releaseStart();
      await starting;
      await removing;
      expect(operations).toEqual([
        "run:start",
        "status:stopping",
        "adapter:stop",
        "ttyd:stop",
        "view:remove",
        "run:stop",
        "membership:remove",
      ]);
    } finally {
      await coordinator.close();
    }
  });
});
