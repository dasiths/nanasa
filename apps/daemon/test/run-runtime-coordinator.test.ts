import type { AgentRun } from "@nanasa/contracts";
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

function consentRequest(memberId = "alpha", state: "pending" | "denied" = "pending") {
  return {
    id: `launch-consent-${memberId}`,
    repositoryIdentity: "repository-one",
    groupId: "group-one",
    agentId: `agent-${memberId}`,
    memberId,
    integrationId: "custom-provider",
    subjectDigest: "a".repeat(64),
    configRevision: "b".repeat(64),
    subject: {
      repositoryIdentity: "repository-one",
      integrationId: "custom-provider",
      providerKind: "pi" as const,
      adapterId: "pi-adapter",
      adapterSecurityVersion: "1.0.0",
      configuredCommand: ["sh", "bin/custom-pi"],
      launcher: "append" as const,
      launcherFiles: [],
      workingDirectory: "/workspace",
      environmentNames: [],
      credentialReference: { kind: "provider-managed" as const },
      permissionFloor: "inherit" as const,
    },
    state,
    requestedAt: "2026-09-02T00:00:00.000Z",
    ...(state === "denied"
      ? { decidedAt: "2026-09-02T00:01:00.000Z", decidedBy: "operator-one" }
      : {}),
  };
}

describe("RunRuntimeCoordinator", () => {
  it("requires custom launch approval before starting the runtime", async () => {
    const request = consentRequest();
    const startRun = vi.fn();
    const coordinator = new RunRuntimeCoordinator(
      {} as never,
      { startRun, close: vi.fn(async () => undefined) } as never,
      { close: vi.fn(async () => undefined) } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      {
        reconcileIntervalMs: 60_000,
        launchConsent: {
          resolve: vi.fn(async () => ({ status: "approval-required" as const, request })),
        },
      },
    );

    try {
      await expect(
        coordinator.startRun("group-one", "alpha", { cols: 120, rows: 40 }),
      ).resolves.toMatchObject({ status: "approval-required", request: { id: request.id } });
      expect(startRun).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
    }
  });

  it("starts a trusted custom launch and returns a typed started result", async () => {
    const startRun = vi.fn(async () => runningRun);
    const coordinator = new RunRuntimeCoordinator(
      {} as never,
      {
        startRun,
        ensureViewSession: vi.fn(async () => "view"),
        close: vi.fn(async () => undefined),
      } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      {
        reconcileIntervalMs: 60_000,
        launchConsent: { resolve: vi.fn(async () => ({ status: "trusted" as const })) },
      },
    );
    try {
      await expect(
        coordinator.startRun("group-one", "alpha", { cols: 120, rows: 40 }),
      ).resolves.toMatchObject({ status: "started", run: { id: runningRun.id } });
      expect(startRun).toHaveBeenCalledOnce();
    } finally {
      await coordinator.close();
    }
  });

  it("gates restart and restart-all before stopping current runs", async () => {
    const request = consentRequest();
    const stopRun = vi.fn();
    const runtimeStop = vi.fn();
    const store = {
      getRun: vi.fn(() => runningRun),
      getActiveRun: vi.fn(() => runningRun),
      getGroup: vi.fn(() => ({ id: "group-one" })),
      listGroupRunsRequiringStop: vi.fn(() => [runningRun]),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      { stopRun: runtimeStop, close: vi.fn(async () => undefined) } as never,
      { stop: stopRun, close: vi.fn(async () => undefined) } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      {
        reconcileIntervalMs: 60_000,
        launchConsent: {
          resolve: vi.fn(async () => ({ status: "approval-required" as const, request })),
        },
      },
    );
    try {
      await expect(
        coordinator.restartRun(runningRun.id, { cols: 120, rows: 40 }),
      ).resolves.toMatchObject({ status: "approval-required", request: { id: request.id } });
      await expect(
        coordinator.restartAll("group-one", { cols: 120, rows: 40 }),
      ).resolves.toMatchObject({
        outcomes: [{ memberId: "alpha", status: "approval-required" }],
      });
      expect(stopRun).not.toHaveBeenCalled();
      expect(runtimeStop).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
    }
  });

  it("validates a team checkout before stopping any run", async () => {
    const stop = vi.fn();
    const store = {
      getEffectiveGroupCheckout: vi.fn(() => ({ id: "checkout-primary" })),
      validateGroupCheckoutAssignment: vi.fn(() => {
        throw new Error("invalid target mapping");
      }),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      { close: vi.fn(async () => undefined) } as never,
      { stop, close: vi.fn(async () => undefined) } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );
    try {
      await expect(
        coordinator.assignGroupCheckout("group-one", {
          checkoutId: "checkout-target",
          expectedCheckoutRevision: 2,
          switchPolicy: "stop-and-switch",
        }),
      ).rejects.toThrow("invalid target mapping");
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
    }
  });

  it("stops, assigns, and restarts only previously running team members", async () => {
    const betaRun = { ...runningRun, id: "run-beta", memberId: "beta" };
    const operations: string[] = [];
    const store = {
      getEffectiveGroupCheckout: vi.fn(() => ({ id: "checkout-primary" })),
      validateGroupCheckoutAssignment: vi.fn(() => ({
        group: { id: "group-one", checkoutRevision: 0 },
        checkout: { id: "checkout-target" },
      })),
      listActiveMemberships: vi.fn(() => [
        { memberId: "alpha" },
        { memberId: "beta" },
        { memberId: "gamma" },
      ]),
      listGroupRunsRequiringStop: vi.fn(() => [runningRun, betaRun]),
      getActiveRun: vi.fn((_groupId: string, memberId: string) =>
        memberId === "alpha" ? runningRun : betaRun,
      ),
      updateRunStatus: vi.fn(),
      assignGroupCheckout: vi.fn(() => {
        operations.push("assign");
        return {
          id: "group-one",
          name: "One",
          order: 0,
          membershipRevision: 0,
          checkoutId: "checkout-target",
          checkoutRevision: 3,
          createdAt: "2026-08-09T12:00:00.000Z",
          updatedAt: "2026-08-09T12:01:00.000Z",
        };
      }),
    };
    const runtime = {
      removeViewSession: vi.fn(async (runId: string) => operations.push(`remove:${runId}`)),
      stopRun: vi.fn(async (_groupId: string, memberId: string) => {
        operations.push(`stop:${memberId}`);
        return memberId === "alpha" ? runningRun : betaRun;
      }),
      startRun: vi.fn(async (_groupId: string, memberId: string) => {
        operations.push(`start:${memberId}`);
        return {
          ...(memberId === "alpha" ? runningRun : betaRun),
          id: `new-${memberId}`,
          checkoutId: "checkout-target",
        };
      }),
      ensureViewSession: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const supervisor = {
      stop: vi.fn(async (runId: string) => operations.push(`gateway:${runId}`)),
      start: vi.fn(),
      unavailable: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      runtime as never,
      supervisor as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );
    try {
      await expect(
        coordinator.assignGroupCheckout("group-one", {
          checkoutId: "checkout-target",
          expectedCheckoutRevision: 2,
          switchPolicy: "stop-switch-restart",
        }),
      ).resolves.toMatchObject({
        previousCheckoutId: "checkout-primary",
        checkoutId: "checkout-target",
        outcomes: [
          { memberId: "alpha", status: "restarted", runId: "new-alpha" },
          { memberId: "beta", status: "restarted", runId: "new-beta" },
          { memberId: "gamma", status: "not-running" },
        ],
      });
      expect(operations.indexOf("assign")).toBeGreaterThan(operations.indexOf("stop:beta"));
      expect(operations.indexOf("start:alpha")).toBeGreaterThan(operations.indexOf("assign"));
      expect(runtime.startRun).toHaveBeenCalledTimes(2);
    } finally {
      await coordinator.close();
    }
  });

  it("returns approval-required and denied outcomes from start-all without launching", async () => {
    const startRun = vi.fn();
    const store = {
      getGroupStartAllResult: vi.fn(() => undefined),
      listActiveMemberships: vi.fn(() => [{ memberId: "alpha" }, { memberId: "beta" }]),
      getActiveRun: vi.fn(() => undefined),
      getLatestRunForMembership: vi.fn(() => undefined),
      recordGroupStartAllResult: vi.fn((result: unknown) => result),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      { startRun, close: vi.fn(async () => undefined) } as never,
      { close: vi.fn(async () => undefined) } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      {
        reconcileIntervalMs: 60_000,
        launchConsent: {
          resolve: vi.fn(async (_groupId: string, memberId: string) =>
            memberId === "alpha"
              ? { status: "approval-required" as const, request: consentRequest(memberId) }
              : { status: "denied" as const, request: consentRequest(memberId, "denied") },
          ),
        },
      },
    );
    try {
      await expect(
        coordinator.startAll("group-one", { cols: 120, rows: 40 }),
      ).resolves.toMatchObject({
        outcomes: [
          { memberId: "alpha", status: "approval-required" },
          { memberId: "beta", status: "denied" },
        ],
      });
      expect(startRun).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
    }
  });

  it("stops the gateway and removes the view session before killing the owner pane", async () => {
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
        operations.push("gateway:stop");
      }),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      runtime as never,
      supervisor as never,
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
        "gateway:stop",
        "view-session:remove",
        "owner-pane:stop",
      ]);
    } finally {
      await coordinator.close();
    }
  });

  it("interrupts the verified owner terminal directly", async () => {
    const interruptRun = vi.fn(async () => undefined);
    const coordinator = new RunRuntimeCoordinator(
      { getRun: vi.fn(() => runningRun) } as never,
      { interruptRun, close: vi.fn(async () => undefined) } as never,
      { close: vi.fn(async () => undefined) } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );
    try {
      await expect(coordinator.interrupt(runningRun.id)).resolves.toBeUndefined();
      expect(interruptRun).toHaveBeenCalledWith(runningRun);
    } finally {
      await coordinator.close();
    }
  });

  it("recovers a missing owner pane into one restarted generation", async () => {
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Recovery" });
    const profile = store.createInternalAgentProfile({
      name: "Pi",
      agentType: "pi",
      kind: "pi",
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
    const recoverRun = vi.fn(async (previous: AgentRun) => {
      store.updateRunStatus(previous.id, "failed", { reason: "recovery_replaced" });
      const created = store.createRunForMembership(group.id, "alpha", {
        recoveryFrom: store.getRun(previous.id),
      }).run;
      return store.updateRunStatus(created.id, "running", {
        terminal: { ...runningRun.terminal!, paneId: "%4", windowId: "@3" },
      });
    });
    const runtime = {
      reconcile: vi.fn(async () => undefined),
      observeRun: vi.fn(async () => ({ state: "missing" })),
      recoverRun,
      removeViewSession: vi.fn(async () => undefined),
      removeStaleViewSessions: vi.fn(async () => undefined),
      ensureViewSession: vi.fn(async () => "view"),
      close: vi.fn(async () => undefined),
    };
    const gateway = {
      stop: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store,
      runtime as never,
      gateway as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000, now: () => new Date("2026-08-10T12:00:00.000Z") },
    );

    try {
      await coordinator.reconcile(true);
      expect(recoverRun).not.toHaveBeenCalled();
      await coordinator.reconcile(true);
      const replacement = store.listDesiredRunningRuns()[0]!;
      expect(recoverRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: run.id, recoveryAttempts: 1 }),
        { cols: 120, rows: 40 },
      );
      expect(replacement).toMatchObject({
        generation: 2,
        status: "running",
        recoveryPhase: "recovered",
        recoveryAttempts: 1,
      });
      expect(store.listEvents().map((event) => event.type)).toEqual(
        expect.arrayContaining(["run.recovery-changed", "run.created", "run.status-changed"]),
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  it("leaves unapproved automatic recovery failed without replacing the run", async () => {
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Consent recovery" });
    const profile = store.createInternalAgentProfile({
      name: "Custom Pi",
      agentType: "custom-pi",
      kind: "pi",
      command: "sh",
      args: ["bin/custom-pi"],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "alpha",
      agentProfileId: profile.id,
      alias: "Alpha",
    });
    const starting = store.createRunForMembership(group.id, "alpha").run;
    const run = store.updateRunStatus(starting.id, "running", {
      terminal: runningRun.terminal,
    });
    const recoverRun = vi.fn();
    const runtime = {
      reconcile: vi.fn(async () => undefined),
      observeRun: vi.fn(async () => ({ state: "missing" })),
      recoverRun,
      removeStaleViewSessions: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store,
      runtime as never,
      {
        reconcile: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      {
        reconcileIntervalMs: 60_000,
        launchConsent: {
          resolve: vi.fn(),
          resolveForAutomaticRecovery: vi.fn(async () => ({
            status: "approval-required" as const,
          })),
        },
      },
    );
    try {
      await coordinator.reconcile();
      await coordinator.reconcile();
      expect(store.getRun(run.id)).toMatchObject({
        generation: 1,
        status: "failed",
        desiredState: "running",
        recoveryPhase: "failed",
        recoveryReason: "launch_consent_required",
      });
      expect(recoverRun).not.toHaveBeenCalled();
      expect(store.getLatestRunForMembership(group.id, "alpha")?.id).toBe(run.id);
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  it("never launches or replaces a run after an indeterminate observation", async () => {
    const recoverRun = vi.fn();
    const runtime = {
      reconcile: vi.fn(async () => undefined),
      observeRun: vi.fn(async () => ({ state: "indeterminate", evidenceCode: "tmux_timeout" })),
      recoverRun,
      removeStaleViewSessions: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      {
        listActiveRuns: vi.fn(() => []),
        listDesiredRunningRuns: vi.fn(() => [runningRun]),
      } as never,
      runtime as never,
      {
        reconcile: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );
    try {
      await coordinator.reconcile(true);
      await coordinator.reconcile(true);
      expect(recoverRun).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
    }
  });

  it("reconciles provider updates before historical process observation", async () => {
    const operations: string[] = [];
    const observeRun = vi.fn(async () => {
      operations.push("process:observe");
      throw new Error("unsupported historical snapshot must not be parsed");
    });
    const providerUpdates = {
      reconcile: vi.fn(async (runs: readonly AgentRun[]) => {
        operations.push("provider-update:reconcile");
        expect(runs).toEqual([runningRun]);
        return { handledRunIds: new Set([runningRun.id]) };
      }),
    };
    const coordinator = new RunRuntimeCoordinator(
      {
        listActiveRuns: vi.fn(() => []),
        listDesiredRunningRuns: vi.fn(() => [runningRun]),
      } as never,
      {
        reconcile: vi.fn(async () => operations.push("tmux:reconcile")),
        observeRun,
        removeStaleViewSessions: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as never,
      {
        reconcile: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000, providerUpdates },
    );
    try {
      await coordinator.reconcile(true);
      expect(operations).toEqual(["tmux:reconcile", "provider-update:reconcile"]);
      expect(observeRun).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
    }
  });

  it("uses normal process observation after a current snapshot is retained", async () => {
    const currentRun: AgentRun = { ...runningRun, recoveryPhase: "recovered" };
    const operations: string[] = [];
    const observeRun = vi.fn(async () => {
      operations.push("process:observe");
      return { state: "present" as const };
    });
    const providerUpdates = {
      reconcile: vi.fn(async () => {
        operations.push("provider-update:reconcile");
        return { handledRunIds: new Set<string>() };
      }),
    };
    const coordinator = new RunRuntimeCoordinator(
      {
        listActiveRuns: vi.fn(() => []),
        listDesiredRunningRuns: vi.fn(() => [currentRun]),
      } as never,
      {
        reconcile: vi.fn(async () => operations.push("tmux:reconcile")),
        observeRun,
        removeStaleViewSessions: vi.fn(async () => undefined),
        ensureViewSession: vi.fn(async () => "view"),
        close: vi.fn(async () => undefined),
      } as never,
      {
        reconcile: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000, providerUpdates },
    );
    try {
      await coordinator.reconcile();
      expect(operations).toEqual([
        "tmux:reconcile",
        "provider-update:reconcile",
        "process:observe",
      ]);
      expect(observeRun).toHaveBeenCalledWith(currentRun);
    } finally {
      await coordinator.close();
    }
  });

  it("marks exhausted missing-pane recovery failed without launching another generation", async () => {
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Exhausted" });
    const profile = store.createInternalAgentProfile({
      name: "Terminal",
      agentType: "opencode",
      kind: "opencode",
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
      observeRun: vi.fn(async () => ({ kind: "dead" })),
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
        start: vi.fn(),
        close: vi.fn(async () => undefined),
      } as never,
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
        start: vi.fn(),
        close: vi.fn(async () => undefined),
      } as never,
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
        {
          memberId: "gamma",
          status: "failed",
          reason: "launch_failed",
          error: {
            message: "The agent could not be started",
            details: {},
            code: "launch_failed",
          },
        },
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
        stop: vi.fn(async () => operations.push("gateway:stop")),
        close: vi.fn(async () => undefined),
      } as never,
      {
        start: vi.fn(),
        close: vi.fn(async () => undefined),
      } as never,
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
        "gateway:stop",
        "view:remove",
        "run:stop",
        "membership:remove",
      ]);
    } finally {
      await coordinator.close();
    }
  });

  it("stops desired and active group runs before deleting the group and replays deletion", async () => {
    const operations: string[] = [];
    const runs = new Map<string, AgentRun>([
      ["alpha", runningRun],
      [
        "beta",
        {
          ...runningRun,
          id: "run-beta",
          memberId: "beta",
          status: "failed",
          recoveryPhase: "failed",
        },
      ],
    ]);
    const result = {
      groupId: "group-one",
      deletedMemberships: 2,
      deletedRuns: 2,
      deletedMessages: 0,
      deletedDeliveries: 0,
    };
    let replay: typeof result | undefined;
    const store = {
      getDeleteGroupResult: vi.fn(() => replay),
      listGroupRunsRequiringStop: vi.fn(() => [...runs.values()]),
      getActiveRun: vi.fn((_groupId: string, memberId: string) =>
        runs.get(memberId)?.status === "running" ? runs.get(memberId) : undefined,
      ),
      getLatestRunForMembership: vi.fn((_groupId: string, memberId: string) => runs.get(memberId)),
      updateRunStatus: vi.fn((runId: string, status: AgentRun["status"]) => {
        operations.push(`${runId}:${status}`);
        const memberId = runId === "run-beta" ? "beta" : "alpha";
        const updated = { ...runs.get(memberId)!, status };
        runs.set(memberId, updated);
        return updated;
      }),
      stopDesiredRun: vi.fn((runId: string) => {
        operations.push(`${runId}:desired-stopped`);
        const updated = { ...runs.get("beta")!, desiredState: "stopped" as const };
        runs.set("beta", updated);
        return updated;
      }),
      deleteGroup: vi.fn(() => {
        operations.push("group:delete");
        replay = result;
        return result;
      }),
    };
    const runtime = {
      removeViewSession: vi.fn(async (runId: string) => operations.push(`${runId}:view-remove`)),
      stopRun: vi.fn(async () => {
        operations.push("run-alpha:runtime-stop");
        return { ...runningRun, status: "stopped" as const };
      }),
      close: vi.fn(async () => undefined),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      runtime as never,
      {
        stop: vi.fn(async (runId: string) => operations.push(`${runId}:gateway-stop`)),
        close: vi.fn(async () => undefined),
      } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );
    try {
      expect(await coordinator.deleteGroup("group-one", "delete-key")).toEqual(result);
      expect(await coordinator.deleteGroup("group-one", "delete-key")).toEqual(result);
      expect(operations).toEqual([
        "run-alpha:stopping",
        "run-alpha:gateway-stop",
        "run-alpha:view-remove",
        "run-alpha:runtime-stop",
        "run-beta:desired-stopped",
        "group:delete",
      ]);
      expect(store.deleteGroup).toHaveBeenCalledTimes(1);
    } finally {
      await coordinator.close();
    }
  });

  it("aborts group deletion on a stop failure and converges on retry", async () => {
    const operations: string[] = [];
    const desiredRuns = new Map<string, AgentRun>([
      ["alpha", { ...runningRun, status: "failed", recoveryPhase: "failed" }],
      [
        "beta",
        {
          ...runningRun,
          id: "run-beta",
          memberId: "beta",
          status: "failed",
          recoveryPhase: "failed",
        },
      ],
    ]);
    let betaFails = true;
    const result = {
      groupId: "group-one",
      deletedMemberships: 2,
      deletedRuns: 2,
      deletedMessages: 0,
      deletedDeliveries: 0,
    };
    const store = {
      getDeleteGroupResult: vi.fn(() => undefined),
      listGroupRunsRequiringStop: vi.fn(() => [...desiredRuns.values()]),
      getActiveRun: vi.fn(() => undefined),
      getLatestRunForMembership: vi.fn((_groupId: string, memberId: string) =>
        desiredRuns.get(memberId),
      ),
      stopDesiredRun: vi.fn((runId: string) => {
        operations.push(`${runId}:stop`);
        if (runId === "run-beta" && betaFails) {
          betaFails = false;
          throw new Error("stop_failed");
        }
        desiredRuns.delete(runId === "run-beta" ? "beta" : "alpha");
        return { ...runningRun, id: runId, desiredState: "stopped" as const };
      }),
      deleteGroup: vi.fn(() => {
        operations.push("group:delete");
        return result;
      }),
    };
    const coordinator = new RunRuntimeCoordinator(
      store as never,
      { close: vi.fn(async () => undefined) } as never,
      { close: vi.fn(async () => undefined) } as never,
      { start: vi.fn(), close: vi.fn(async () => undefined) } as never,
      { reconcileIntervalMs: 60_000 },
    );
    try {
      await expect(coordinator.deleteGroup("group-one", "delete-key")).rejects.toThrow(
        "stop_failed",
      );
      expect(store.deleteGroup).not.toHaveBeenCalled();
      await expect(coordinator.deleteGroup("group-one", "delete-key")).resolves.toEqual(result);
      expect(operations).toEqual([
        "run-alpha:stop",
        "run-beta:stop",
        "run-beta:stop",
        "group:delete",
      ]);
    } finally {
      await coordinator.close();
    }
  });
});
