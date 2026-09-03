import type { AgentRun, ProviderUpdatePlan, ProviderUpdateTransition } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderUpdateReconciler } from "../src/providers/provider-update-reconciler.js";
import { NanasaStore } from "../src/store.js";

const digest = (character: string): string => character.repeat(64);
const now = "2026-09-03T10:00:00.000Z";
const stores: NanasaStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function createRun(): { store: NanasaStore; run: AgentRun } {
  const store = new NanasaStore(":memory:");
  stores.push(store);
  const group = store.createGroup({ name: "Provider update" });
  const profile = store.createInternalAgentProfile({
    name: "Copilot",
    agentType: "copilot",
    kind: "copilot",
    command: "copilot",
    args: [],
    environment: {},
  });
  store.addMembership(group.id, {
    memberId: "engineer",
    agentProfileId: profile.id,
    alias: "Engineer",
  });
  const run = store.createRun({
    id: "run-old",
    groupId: group.id,
    memberId: "engineer",
    agentProfileId: profile.id,
    generation: 1,
    status: "running",
    terminal: {
      serverName: "nanasa-test",
      sessionId: "$1",
      windowId: "@2",
      paneId: "%3",
    },
    startedAt: now,
  });
  return { store, run };
}

function plan(run: AgentRun, status: "current" | "outdated" = "outdated"): ProviderUpdatePlan {
  return {
    runId: run.id,
    generation: run.generation,
    memberId: run.memberId,
    providerId: "copilot",
    previousSnapshotDigest: digest("a"),
    currentSnapshotDigest: status === "current" ? digest("a") : digest("b"),
    status,
  };
}

function transition(run: AgentRun): ProviderUpdateTransition {
  return {
    id: "provider-update-one",
    runId: run.id,
    generation: run.generation,
    memberId: run.memberId,
    providerId: "copilot",
    previousSnapshotDigest: digest("a"),
    currentSnapshotDigest: digest("b"),
    state: "pending",
    detectedAt: now,
    updatedAt: now,
  };
}

function transitionRepository(run: AgentRun, existing?: ProviderUpdateTransition) {
  let current = existing ?? transition(run);
  return {
    begin: vi.fn(() => ({ created: existing === undefined, transition: current })),
    getForPair: vi.fn(() => (existing?.outcome === "ownership-uncertain" ? current : undefined)),
    markInProgress: vi.fn(() => {
      current = { ...current, state: "in-progress", outcome: undefined, completedAt: undefined };
      return current;
    }),
    recordReplacement: vi.fn((_id: string, replacementRunId: string) => {
      current = { ...current, replacementRunId };
      return current;
    }),
    complete: vi.fn((_id: string, input: Record<string, unknown>) => {
      current = {
        ...current,
        ...input,
        state: "completed",
        updatedAt: now,
        completedAt: String(input.completedAt ?? now),
      } as ProviderUpdateTransition;
      return current;
    }),
  };
}

function reconciler(input: {
  store: NanasaStore;
  run: AgentRun;
  pane?: "stopped" | "missing" | "ownership-uncertain";
  consent?: "built-in" | "trusted" | "approval-required" | "denied";
  existing?: ProviderUpdateTransition;
  nativeMode?: "restart" | "resume-only";
}) {
  const transitions = transitionRepository(input.run, input.existing);
  const replacement: AgentRun = {
    ...input.run,
    id: "run-replacement",
    generation: 2,
    launchKind: "restarted",
    terminal: { ...input.run.terminal!, paneId: "%4", windowId: "@4" },
  };
  const runtime = {
    inspectProviderUpdatePane: vi.fn(async () =>
      input.pane === "ownership-uncertain" ? "ownership-uncertain" : "owned",
    ),
    stopProviderUpdatePane: vi.fn(async () => input.pane ?? "missing"),
    removeViewSession: vi.fn(async () => undefined),
    recoverRun: vi.fn(
      async (
        _run: AgentRun,
        _size: unknown,
        options: {
          onReplacementCreated?: (run: AgentRun) => void;
        },
      ) => {
        input.store.updateRunStatus(input.run.id, "failed", { reason: "recovery_replaced" });
        input.store.createRun({ ...replacement, status: "starting", terminal: undefined });
        options.onReplacementCreated?.(input.store.getRun(replacement.id));
        return input.store.updateRunStatus(replacement.id, "running", {
          terminal: replacement.terminal,
        });
      },
    ),
  };
  const gateway = { stop: vi.fn(async () => undefined) };
  const request = { id: "launch-consent-one" };
  const launchConsent = {
    resolve: vi.fn(async () =>
      input.consent === "approval-required"
        ? { status: "approval-required" as const, request }
        : input.consent === "denied"
          ? { status: "denied" as const, request }
          : { status: input.consent ?? ("built-in" as const) },
    ),
    inspectForRecovery: vi.fn(async () => ({ status: input.consent ?? ("built-in" as const) })),
  };
  const service = new ProviderUpdateReconciler(
    input.store,
    runtime as never,
    gateway as never,
    { detectIfBound: vi.fn(() => plan(input.run)) } as never,
    transitions as never,
    launchConsent as never,
    {
      now: () => new Date(now),
      ...(input.nativeMode === undefined
        ? {}
        : {
            nativeRecoveryPolicy: () => ({
              integrationId: "copilot",
              policy: { mode: input.nativeMode, confirmationTimeoutSeconds: 30 },
            }),
          }),
    },
  );
  return { service, runtime, gateway, transitions, launchConsent, replacement };
}

describe("ProviderUpdateReconciler", () => {
  it("retains a current run without touching tmux or transition state", async () => {
    const { store, run } = createRun();
    const stopProviderUpdatePane = vi.fn();
    const begin = vi.fn();
    const service = new ProviderUpdateReconciler(
      store,
      { stopProviderUpdatePane } as never,
      {} as never,
      { detectIfBound: vi.fn(() => plan(run, "current")) } as never,
      { begin } as never,
      {} as never,
    );

    await expect(service.reconcile([run])).resolves.toMatchObject({
      outcomes: [{ runId: run.id, status: "retained" }],
    });
    expect(stopProviderUpdatePane).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it.each(["stopped", "missing"] as const)(
    "replaces an outdated run once when the old pane is %s",
    async (pane) => {
      const { store, run } = createRun();
      const context = reconciler({ store, run, pane, consent: "trusted" });

      await expect(context.service.reconcile([run])).resolves.toMatchObject({
        outcomes: [{ runId: run.id, status: "restarted", replacementRunId: "run-replacement" }],
      });
      expect(context.runtime.recoverRun).toHaveBeenCalledOnce();
      expect(context.transitions.recordReplacement).toHaveBeenCalledWith(
        "provider-update-one",
        "run-replacement",
        now,
      );
      expect(context.transitions.complete).toHaveBeenCalledWith(
        "provider-update-one",
        expect.objectContaining({ outcome: "restarted", replacementRunId: "run-replacement" }),
      );
      expect(store.listEvents().map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "provider-update.detected",
          "provider-update.in-progress",
          "provider-update.completed",
        ]),
      );
      const completed = store
        .listEvents()
        .find((event) => event.type === "provider-update.completed");
      expect(completed?.payload).toMatchObject({
        outcome: "The agent restarted with the latest setup",
      });
    },
  );

  it("routes a changed custom launch through current consent and pauses for approval", async () => {
    const { store, run } = createRun();
    const context = reconciler({ store, run, pane: "missing", consent: "approval-required" });

    await expect(context.service.reconcile([run])).resolves.toMatchObject({
      outcomes: [
        {
          status: "approval-required",
          consentRequest: { id: "launch-consent-one" },
        },
      ],
    });
    expect(context.launchConsent.resolve).toHaveBeenCalledWith(run.groupId, run.memberId);
    expect(context.runtime.recoverRun).not.toHaveBeenCalled();
    expect(context.transitions.complete).toHaveBeenCalledWith(
      "provider-update-one",
      expect.objectContaining({ outcome: "approval-required" }),
    );
  });

  it("records denied current launch consent as a safe failure", async () => {
    const { store, run } = createRun();
    const context = reconciler({ store, run, pane: "missing", consent: "denied" });

    await expect(context.service.reconcile([run])).resolves.toMatchObject({
      outcomes: [
        {
          status: "failed",
          safeError: { code: "provider_update_launch_denied", retryable: false },
        },
      ],
    });
    expect(context.runtime.recoverRun).not.toHaveBeenCalled();
  });

  it("does not detach, kill, or replace when pane ownership is uncertain", async () => {
    const { store, run } = createRun();
    const context = reconciler({ store, run, pane: "ownership-uncertain" });

    await expect(context.service.reconcile([run])).resolves.toMatchObject({
      outcomes: [
        {
          status: "ownership-uncertain",
          safeError: { code: "provider_update_ownership_uncertain", retryable: false },
        },
      ],
    });
    expect(context.gateway.stop).not.toHaveBeenCalled();
    expect(context.runtime.removeViewSession).not.toHaveBeenCalled();
    expect(context.runtime.recoverRun).not.toHaveBeenCalled();
  });

  it("previews ownership and consent without mutating runs, panes, or transitions", async () => {
    const { store, run } = createRun();
    const context = reconciler({ store, run, pane: "missing", consent: "approval-required" });
    const before = store.getRun(run.id);

    await expect(
      context.service.recover([run], { dryRun: true, forceIndeterminate: false }),
    ).resolves.toMatchObject({ outcomes: [{ status: "approval-required" }] });
    expect(store.getRun(run.id)).toEqual(before);
    expect(context.runtime.inspectProviderUpdatePane).toHaveBeenCalledWith(run, {
      forceIndeterminate: false,
    });
    expect(context.runtime.stopProviderUpdatePane).not.toHaveBeenCalled();
    expect(context.launchConsent.inspectForRecovery).toHaveBeenCalledWith(
      run.groupId,
      run.memberId,
    );
    expect(context.launchConsent.resolve).not.toHaveBeenCalled();
    expect(context.transitions.begin).not.toHaveBeenCalled();
  });

  it("retries only an exact run with a persisted ownership-uncertain outcome", async () => {
    const { store, run } = createRun();
    const existing: ProviderUpdateTransition = {
      ...transition(run),
      state: "completed",
      outcome: "ownership-uncertain",
      completedAt: now,
    };
    const context = reconciler({ store, run, existing, pane: "missing", consent: "trusted" });

    await expect(
      context.service.recover([run], { dryRun: false, forceIndeterminate: true }),
    ).resolves.toMatchObject({ outcomes: [{ status: "restarted" }] });
    expect(context.runtime.stopProviderUpdatePane).toHaveBeenCalledWith(run, {
      forceIndeterminate: true,
    });
  });

  it("rejects force after the target run or generation changes", async () => {
    const { store, run } = createRun();
    const existing: ProviderUpdateTransition = {
      ...transition(run),
      state: "completed",
      outcome: "ownership-uncertain",
      completedAt: now,
    };
    const context = reconciler({ store, run, existing, pane: "missing" });
    store.updateRunStatus(run.id, "failed", { reason: "superseded" });
    store.createRun({ ...run, id: "run-newer", generation: 2, status: "running" });

    await expect(
      context.service.recover([run], { dryRun: false, forceIndeterminate: true }),
    ).rejects.toMatchObject({ code: "provider_update_target_changed", statusCode: 409 });
    expect(context.runtime.stopProviderUpdatePane).not.toHaveBeenCalled();
  });

  it("does not apply force to an ordinary outdated run", async () => {
    const { store, run } = createRun();
    const context = reconciler({ store, run, pane: "missing" });

    await expect(
      context.service.recover([run], { dryRun: false, forceIndeterminate: true }),
    ).resolves.toMatchObject({ outcomes: [{ status: "restarted" }] });
    expect(context.runtime.stopProviderUpdatePane).toHaveBeenCalledWith(run, {
      forceIndeterminate: false,
    });
  });

  it("honors resume-only policy when no confirmed native session is available", async () => {
    const { store, run } = createRun();
    const context = reconciler({ store, run, nativeMode: "resume-only" });

    await expect(context.service.reconcile([run])).resolves.toMatchObject({
      outcomes: [
        {
          status: "failed",
          safeError: { code: "provider_update_native_session_unavailable", retryable: false },
        },
      ],
    });
    expect(context.runtime.recoverRun).not.toHaveBeenCalled();
  });

  it("replays a completed transition without creating a duplicate replacement", async () => {
    const { store, run } = createRun();
    const existing: ProviderUpdateTransition = {
      ...transition(run),
      state: "completed",
      outcome: "restarted",
      replacementRunId: "run-existing-replacement",
      completedAt: now,
    };
    const context = reconciler({ store, run, existing });

    await expect(context.service.reconcile([run])).resolves.toMatchObject({
      outcomes: [{ status: "restarted", replacementRunId: "run-existing-replacement" }],
    });
    expect(context.transitions.markInProgress).not.toHaveBeenCalled();
    expect(context.runtime.stopProviderUpdatePane).not.toHaveBeenCalled();
    expect(context.runtime.recoverRun).not.toHaveBeenCalled();
  });

  it("completes a persisted running replacement after a startup crash without restarting it", async () => {
    const { store, run } = createRun();
    const pending = {
      ...transition(run),
      state: "in-progress" as const,
      replacementRunId: "run-replacement",
    };
    const replacement = store.createRun({
      ...run,
      id: "run-replacement",
      generation: 2,
      providerUpdate: undefined,
    });
    const context = reconciler({ store, run, existing: pending });
    const projected = { ...replacement, providerUpdate: pending };
    const detectIfBound = vi
      .fn()
      .mockReturnValueOnce(plan({ ...projected, id: run.id, generation: 1 }, "current"));
    const service = new ProviderUpdateReconciler(
      store,
      context.runtime as never,
      context.gateway as never,
      { detectIfBound } as never,
      context.transitions as never,
      context.launchConsent as never,
      { now: () => new Date(now) },
    );

    await expect(service.reconcile([projected])).resolves.toMatchObject({
      outcomes: [{ status: "restarted", replacementRunId: replacement.id }],
    });
    expect(context.transitions.complete).toHaveBeenCalledWith(
      pending.id,
      expect.objectContaining({ outcome: "restarted", replacementRunId: replacement.id }),
    );
    expect(context.runtime.stopProviderUpdatePane).not.toHaveBeenCalled();
    expect(context.runtime.recoverRun).not.toHaveBeenCalled();
  });
});
