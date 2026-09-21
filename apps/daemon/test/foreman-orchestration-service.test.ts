import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NanasaConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForemanCleanupService } from "../src/foreman-cleanup-service.js";
import { ForemanGoalService } from "../src/foreman-goal-service.js";
import { ForemanOrchestrationService } from "../src/foreman-orchestration-service.js";
import { CheckoutService } from "../src/git/checkout-service.js";
import { GitCommandAdapter } from "../src/git/git-command-adapter.js";
import { GitStatusService } from "../src/git/git-status-service.js";
import { RepositoryDiscoveryService } from "../src/git/repository-discovery-service.js";
import { WorktreeService } from "../src/git/worktree-service.js";
import type { RunRuntimeCoordinator } from "../src/run-runtime-coordinator.js";
import { NanasaStore } from "../src/store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture(autonomous = true, constraints: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "nanasa-preparation-"));
  const repository = join(root, "repository");
  execFileSync("git", ["init", "--quiet", repository]);
  mkdirSync(join(repository, "nested"));
  writeFileSync(join(repository, "nested", "seed.txt"), "initial\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  const store = new NanasaStore(join(root, "state.sqlite"));
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const config = NanasaConfigSchema.parse({
    version: 2,
    groups: {},
    integrations: {
      copilot: {
        id: "copilot",
        name: "Copilot",
        kind: "copilot",
        command: ["copilot"],
        commandSource: "builtin",
      },
    },
    foreman: {
      enabled: true,
      integrationId: "copilot",
      autonomy: { approvalMode: autonomous ? "autonomous" : "human" },
    },
  });
  store.reconcileTopology(config);
  store.beginDaemonEpoch({
    instanceId: "test",
    processId: 10,
    processStartedAt: new Date().toISOString(),
  });
  const profile = store.createInternalAgentProfile({
    name: "Test",
    agentType: "copilot",
    kind: "copilot",
    command: "copilot",
    args: [],
    environment: {},
    workingDirectory: join(repository, "nested"),
  });
  const foremanProfile = store.createInternalAgentProfile({
    name: "Foreman",
    agentType: "copilot",
    kind: "copilot",
    command: "copilot",
    args: [],
    environment: {},
  });
  store.upsertForeman({
    id: "repository-foreman",
    agentProfileId: foremanProfile.id,
    enabled: true,
  });
  const foremanRun = store.createRunForForeman("repository-foreman").run;
  const principal = {
    kind: "foreman" as const,
    foremanId: foremanRun.foremanId,
    runId: foremanRun.id,
    generation: foremanRun.generation,
    authorityRevision: store.getForeman(foremanRun.foremanId).authorityRevision,
  };
  const group = store.createGroup({ name: "Builders" });
  for (const memberId of ["lead", "reviewer"])
    store.addMembership(group.id, { memberId, agentProfileId: profile.id, alias: memberId });
  const git = new GitCommandAdapter();
  const checkouts = new CheckoutService(
    store,
    new RepositoryDiscoveryService(git),
    new GitStatusService(git),
  );
  const source = (await checkouts.initialize(repository)).checkout;
  const worktrees = new WorktreeService(store, git, checkouts, join(root, "managed"));
  let clock = Date.now();
  const now = () => new Date(clock);
  let ready = true;
  let controlled = false;
  const goals = new ForemanGoalService(
    store,
    () => config,
    () => controlled,
    now,
  );
  const originalStatus = store.getAgentStatus.bind(store);
  vi.spyOn(store, "getAgentStatus").mockImplementation((groupId, memberId) => ({
    ...originalStatus(groupId, memberId),
    state: ready ? "idle" : "working",
    interactiveReady: ready,
    staleAuthority: false,
    authorityKind: "reporter",
    processState: "present",
  }));
  const coordinator = {
    startRun: vi.fn<RunRuntimeCoordinator["startRun"]>(async (groupId, memberId, _size, guard) => {
      guard?.();
      const run = store.createRunForMembership(groupId, memberId).run;
      return { status: "started", run: store.updateRunStatus(run.id, "running") };
    }),
    stopRun: vi.fn<RunRuntimeCoordinator["stopRun"]>(async (groupId, memberId, options) => {
      options?.beforeEffect();
      const run = store.getLatestRunForMembership(groupId, memberId)!;
      return store.updateRunStatus(run.id, "stopped", {
        reason: options?.reason ?? "operator_stopped",
      });
    }),
    assignGroupCheckout: vi.fn<RunRuntimeCoordinator["assignGroupCheckout"]>(
      async (groupId, command, guard) => {
        guard?.();
        return {
          group: store.assignGroupCheckout(
            groupId,
            command.checkoutId,
            command.expectedCheckoutRevision,
          ),
          checkoutId: command.checkoutId,
          outcomes: [],
        };
      },
    ),
  };
  const orchestration = new ForemanOrchestrationService(
    store,
    goals,
    checkouts,
    worktrees,
    coordinator,
    now,
  );
  const goal = goals.propose({
    requestId: "goal",
    title: "Solar system",
    objective: "Create browser based solar system simulator in ./src dir",
    constraints,
  });
  if (!autonomous)
    goals.control("human", { id: goal.id, expectedRevision: goal.revision, action: "approve" });
  const command = {
    requestId: "assign-one",
    goalId: goal.id,
    groupId: group.id,
    memberId: "lead",
    brief: goal.objective,
    workspace: "auto" as const,
  };
  return {
    root,
    repository,
    source,
    store,
    config,
    goals,
    group,
    profile,
    principal,
    goal,
    command,
    checkouts,
    worktrees,
    coordinator,
    orchestration,
    now,
    advance: (milliseconds = 1100) => {
      clock += milliseconds;
    },
    ready: (value: boolean) => {
      ready = value;
    },
    controlled: (value: boolean) => {
      controlled = value;
    },
  };
}

describe("Foreman repository orchestration", () => {
  it.each(["completed", "cancelled"] as const)(
    "rechecks a %s goal's historical handoff when preparation retries",
    async (state) => {
      const context = await fixture();
      const { store, goals, group, principal, coordinator, orchestration, goal, command } = context;
      for (const memberId of ["lead", "reviewer"])
        await coordinator.startRun(group.id, memberId, { cols: 80, rows: 24 });
      const team = goals.discover()[0]!;
      const delegation = goals.delegate(principal, {
        requestId: "old-delegation",
        goalId: goal.id,
        expectedRevision: goals.get(goal.id).revision,
        groupId: group.id,
        memberId: "lead",
        expectedMembershipRevision: team.membershipRevision,
        expectedCheckoutRevision: team.checkoutRevision,
        rationale: "Previous outcome",
        brief: "Previous handoff",
      });
      const target = store.getActiveRun(group.id, "lead")!;
      const timestamp = context.now().toISOString();
      store.registerReporterSession({
        id: "historical-reporter",
        providerId: "copilot",
        adapterId: "copilot",
        reporterId: "copilot-native",
        source: "copilot",
        protocolVersion: 2,
        reporterVersion: "2",
        runId: target.id,
        generation: target.generation,
        reporterEpoch: "historical-epoch",
        readinessCoverage: "full",
        sourceSequence: 0,
        openedAt: timestamp,
        leaseExpiresAt: "2099-01-01T00:00:00Z",
      });
      const handoff = store.createAgentAction({
        version: 1,
        id: "action_old_handoff",
        kind: "prompt",
        principal: {
          ...principal,
          goalId: goal.id,
          delegationId: delegation.id,
          goalRevision: goals.get(goal.id).revision + 1,
        },
        target: {
          groupId: group.id,
          memberId: "lead",
          runId: target.id,
          generation: target.generation,
          daemonEpoch: 1,
          reporterSessionId: "historical-reporter",
          reporterId: "copilot-native",
          reporterEpoch: "historical-epoch",
          baselineStatusRevision: 0,
          baselineCompletionRevision: 0,
        },
        idempotencyKey: "old-handoff",
        requestDigest: "a".repeat(64),
        prompt: delegation.brief,
        allowWorking: false,
        state: "stalled",
        result: { effectsUnknown: true },
        queueDeadlineAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      for (const record of [
        { ...goals.get(goal.id), state },
        { ...delegation, state, actionId: handoff.id },
      ])
        store.database
          .prepare("UPDATE foreman_coordination_records SET data_json = ? WHERE id = ?")
          .run(JSON.stringify(record), record.id);
      const nextGoal = goals.propose({
        requestId: "next-goal",
        title: "Next outcome",
        objective: "Deliver the next outcome",
      });
      const prepared = await orchestration.assignOutcome(principal, {
        ...command,
        goalId: nextGoal.id,
      });
      expect(prepared).toMatchObject({ phase: "waiting", reason: "unsettled_work" });
      expect(coordinator.stopRun).not.toHaveBeenCalled();
      store.updateRunStatus(target.id, "failed");
      await coordinator.startRun(group.id, "lead", { cols: 80, rows: 24 });
      expect(store.getActiveRun(group.id, "lead")!.generation).toBeGreaterThan(target.generation);
      const retained = store.getAgentAction(handoff.id);
      context.advance();
      await orchestration.tick();
      expect(orchestration.list(nextGoal.id)[0]).toMatchObject(
        state === "completed"
          ? { phase: "delegated" }
          : { phase: "waiting", reason: "unsettled_work" },
      );
      expect(goals.workspace(nextGoal.id).delegations).toHaveLength(state === "completed" ? 1 : 0);
      expect(store.getAgentAction(handoff.id)).toEqual(retained);
      if (state === "cancelled") {
        expect(coordinator.stopRun).not.toHaveBeenCalled();
        const cleanup = new ForemanCleanupService(store, goals);
        const removal = {
          scope: "goal",
          requestId: "remove-unsettled-waiting",
          confirmation: true,
          cancel: true,
          goal: { id: nextGoal.id, expectedRevision: goals.get(nextGoal.id).revision },
        };
        const result = cleanup.execute("human", removal);
        expect(result.pendingEffects).toEqual([]);
        const overAttributed = {
          goalId: nextGoal.id,
          actionIds: [handoff.id],
          runIds: store.listGroupRunsRequiringStop(group.id).map((run) => run.id),
        };
        store.database
          .prepare("UPDATE foreman_cleanup_effects SET data_json = ? WHERE goal_id = ?")
          .run(JSON.stringify(overAttributed), nextGoal.id);
        const oldReceipt = { ...result, pendingEffects: [overAttributed] };
        store.database
          .prepare("UPDATE foreman_cleanup_receipts SET result_json = ? WHERE request_id = ?")
          .run(JSON.stringify(oldReceipt), removal.requestId);
        const storedEffects = store.database
          .prepare("SELECT data_json FROM foreman_cleanup_effects WHERE goal_id = ?")
          .get(nextGoal.id);
        expect(cleanup.pendingEffects()).toEqual([]);
        expect(cleanup.execute("human", removal)).toEqual(oldReceipt);
        expect(
          store.database
            .prepare("SELECT data_json FROM foreman_cleanup_effects WHERE goal_id = ?")
            .get(nextGoal.id),
        ).toEqual(storedEffects);
        expect(store.getAgentAction(handoff.id)).toEqual(retained);
        expect(store.listGroupRunsRequiringStop(group.id).map((run) => run.id)).toEqual(
          overAttributed.runIds,
        );
      }
    },
  );

  it("cleanup excludes prior runs when preparation only waits for readiness", async () => {
    const context = await fixture();
    for (const memberId of ["lead", "reviewer"])
      await context.coordinator.startRun(context.group.id, memberId, { cols: 80, rows: 24 });
    const priorRuns = context.store.listGroupRunsRequiringStop(context.group.id);
    context.ready(false);
    const prepared = await context.orchestration.assignOutcome(context.principal, context.command);
    expect(prepared).toMatchObject({ phase: "waiting", reason: "runtime_not_ready" });
    expect(context.coordinator.startRun).toHaveBeenCalledTimes(2);
    expect(context.coordinator.stopRun).not.toHaveBeenCalled();
    const cleanup = new ForemanCleanupService(context.store, context.goals);
    const result = cleanup.execute("human", {
      scope: "goal",
      requestId: "remove-waiting",
      confirmation: true,
      cancel: true,
      goal: { id: context.goal.id, expectedRevision: context.goals.get(context.goal.id).revision },
    });
    expect(result.pendingEffects).toEqual([]);
    expect(context.store.listGroupRunsRequiringStop(context.group.id)).toEqual(priorRuns);
  });

  it("captures preparation-only runs on cleanup without capturing later or unrelated runs", async () => {
    const context = await fixture();
    context.ready(false);
    const prepared = await context.orchestration.assignOutcome(context.principal, context.command);
    expect(prepared).toMatchObject({ phase: "waiting", reason: "runtime_not_ready" });
    expect(context.goals.delegations()).toHaveLength(0);
    const capturedRuns = context.store.listGroupRunsRequiringStop(context.group.id);
    expect(capturedRuns).toHaveLength(2);
    const peer = context.store.createGroup({ name: "Other team" });
    context.store.addMembership(peer.id, {
      memberId: "peer",
      agentProfileId: context.profile.id,
      alias: "Peer",
    });
    await context.coordinator.startRun(peer.id, "peer", { cols: 80, rows: 24 });
    const cleanup = new ForemanCleanupService(context.store, context.goals);
    const command = {
      scope: "goal",
      requestId: "remove-preparing",
      confirmation: true,
      cancel: true,
      goal: { id: context.goal.id, expectedRevision: context.goals.get(context.goal.id).revision },
    };
    const result = cleanup.execute("human", command);
    expect(result.pendingEffects).toEqual([
      {
        goalId: context.goal.id,
        actionIds: [],
        runIds: expect.arrayContaining(capturedRuns.map((run) => run.id)),
      },
    ]);
    expect(result.pendingEffects[0]!.runIds).toHaveLength(2);
    expect(context.store.getActiveRun(peer.id, "peer")).toBeDefined();
    for (const run of capturedRuns) context.store.updateRunStatus(run.id, "stopped");
    await context.coordinator.startRun(context.group.id, "lead", { cols: 80, rows: 24 });
    expect(cleanup.pendingEffects()).toEqual([]);
    expect(cleanup.execute("human", command)).toEqual(result);
  });

  it.each(["intent", "done"] as const)(
    "cleanup retains a preparation stop %s target on the original checkout",
    async (state) => {
      const context = await fixture();
      const { store, group, coordinator, orchestration, goals, principal, command, goal } = context;
      await coordinator.startRun(group.id, "lead", { cols: 80, rows: 24 });
      const target = store.getActiveRun(group.id, "lead")!;
      coordinator.stopRun.mockImplementationOnce(async (groupId, memberId, options) => {
        options?.beforeEffect();
        const run = store.getActiveRun(groupId, memberId)!;
        const stopping = store.updateRunStatus(run.id, "stopping");
        if (state === "intent") throw new Error("Interrupted stop receipt");
        return stopping;
      });
      const prepared = await orchestration.assignOutcome(principal, command);
      expect(prepared.phase).toBe("held");
      expect(prepared.checkoutId).not.toBe(target.checkoutId);
      const internal = JSON.parse(
        String(
          store.database
            .prepare("SELECT data_json FROM foreman_preparations WHERE id = ?")
            .get(prepared.id)!.data_json,
        ),
      );
      expect(internal.stops).toEqual([
        { memberId: "lead", runId: target.id, generation: target.generation, state },
      ]);
      expect(internal.starts).toEqual([]);
      await coordinator.startRun(group.id, "reviewer", { cols: 80, rows: 24 });
      const cleanup = new ForemanCleanupService(store, goals);
      const result = cleanup.execute("human", {
        scope: "goal",
        requestId: "remove-stop-intent",
        confirmation: true,
        cancel: true,
        goal: { id: goal.id, expectedRevision: goals.get(goal.id).revision },
      });
      expect(result.pendingEffects).toEqual([
        { goalId: goal.id, actionIds: [], runIds: [target.id] },
      ]);
      expect(cleanup.pendingEffects()).toEqual(result.pendingEffects);
      expect(store.getActiveRun(group.id, "reviewer")).toBeDefined();
    },
  );

  it.each(["before", "after"] as const)(
    "cleanup conservatively projects a start interrupted %s runtime creation after reopening",
    async (timing) => {
      const context = await fixture();
      const { store, group, coordinator, orchestration, goals, principal, command, goal } = context;
      coordinator.startRun.mockImplementationOnce(async (groupId, memberId, _size, guard) => {
        guard?.();
        if (timing === "after") {
          const run = store.createRunForMembership(groupId, memberId).run;
          store.updateRunStatus(run.id, "running");
        }
        throw new Error("Interrupted start receipt");
      });
      const prepared = await orchestration.assignOutcome(principal, command);
      expect(prepared).toMatchObject({ phase: "held", reason: "preparation_effect_uncertain" });
      const target = store.getActiveRun(group.id, "lead");
      await coordinator.startRun(group.id, "reviewer", { cols: 80, rows: 24 });
      const cleanup = new ForemanCleanupService(store, goals);
      const result = cleanup.execute("human", {
        scope: "goal",
        requestId: "remove-start-intent",
        confirmation: true,
        cancel: true,
        goal: { id: goal.id, expectedRevision: goals.get(goal.id).revision },
      });
      expect(result.pendingEffects).toEqual(
        target ? [{ goalId: goal.id, actionIds: [], runIds: [target.id] }] : [],
      );
      const reopened = new NanasaStore(join(context.root, "state.sqlite"));
      try {
        const durable = new ForemanCleanupService(
          reopened,
          new ForemanGoalService(reopened, () => context.config),
        );
        expect(durable.pendingEffects()).toEqual(result.pendingEffects);
      } finally {
        reopened.close();
      }
      if (target) store.updateRunStatus(target.id, "stopped");
      await coordinator.startRun(group.id, "lead", { cols: 80, rows: 24 });
      expect(cleanup.pendingEffects()).toEqual([]);
    },
  );

  it("isolates an idle primary team, preserves its peer, maps nested CWD and delegates exactly once", async () => {
    const context = await fixture();
    const { store, group, profile, coordinator, orchestration, principal, command, source, goals } =
      context;
    for (const memberId of ["lead", "reviewer"])
      await coordinator.startRun(group.id, memberId, { cols: 120, rows: 36 });
    const peer = store.createGroup({ name: "Other team" });
    store.addMembership(peer.id, { memberId: "peer", agentProfileId: profile.id, alias: "Peer" });
    const peerRun = await coordinator.startRun(peer.id, "peer", { cols: 120, rows: 36 });
    const prepared = await orchestration.assignOutcome(principal, command);
    expect(prepared).toMatchObject({ phase: "delegated", sourceHead: source.head, retryCount: 0 });
    expect(prepared.checkoutId).not.toBe(source.id);
    const checkout = store.getCheckout(prepared.checkoutId!);
    expect(store.getActiveRun(group.id, "lead")!.resolvedWorkingDirectory).toBe(
      join(checkout.path, "nested"),
    );
    expect(store.getActiveRun(peer.id, "peer")!.id).toBe(
      peerRun.status === "started" ? peerRun.run.id : "missing",
    );
    expect(coordinator.stopRun).toHaveBeenCalledTimes(2);
    expect(goals.delegations()).toHaveLength(1);
    expect(goals.delegations()[0]).toMatchObject({ state: "queued", checkoutId: checkout.id });
    expect(await orchestration.assignOutcome(principal, command)).toEqual(prepared);
    expect(store.listWorktrees(source.repositoryId)).toHaveLength(1);
    expect(coordinator.startRun).toHaveBeenCalledTimes(5);
    await expect(
      orchestration.assignOutcome(principal, { ...command, brief: "Changed intent" }),
    ).rejects.toMatchObject({ code: "foreman_preparation_conflict" });
  });

  it("starts never-launched members and waits durably for readiness with a deadline", async () => {
    const context = await fixture();
    context.ready(false);
    const result = await context.orchestration.assignOutcome(context.principal, context.command);
    expect(result).toMatchObject({ phase: "waiting", reason: "runtime_not_ready" });
    expect(context.coordinator.startRun).toHaveBeenCalledTimes(2);
    const resumed = new ForemanOrchestrationService(
      context.store,
      context.goals,
      context.checkouts,
      context.worktrees,
      context.coordinator,
      context.now,
    );
    context.advance();
    await resumed.tick();
    expect(context.coordinator.startRun).toHaveBeenCalledTimes(2);
    expect(context.goals.delegations()).toHaveLength(0);
    context.ready(true);
    context.advance();
    await resumed.tick();
    expect(resumed.list(context.goal.id)[0]!.phase).toBe("delegated");
    expect(context.goals.delegations()).toHaveLength(1);
  });

  it("requires one durable scoped Human plan approval in supervised mode", async () => {
    const context = await fixture(false);
    const result = await context.orchestration.assignOutcome(context.principal, context.command);
    expect(result.phase).toBe("needs-approval");
    expect(context.store.listWorktrees()).toHaveLength(0);
    expect(context.coordinator.startRun).not.toHaveBeenCalled();
    context.goals.resolve("human", {
      id: result.decisionId!,
      expectedRevision: 0,
      requestId: "approve-plan",
      answer: "approve",
    });
    context.advance();
    await context.orchestration.tick();
    expect(context.orchestration.list(context.goal.id)[0]!.phase).toBe("delegated");
    expect(context.goals.workspace(context.goal.id).decisions).toHaveLength(1);
    expect(context.goals.delegations()[0]!.state).toBe("queued");
  });

  it("preserves explicit Human stops even with dirty source files", async () => {
    const context = await fixture();
    const started = await context.coordinator.startRun(context.group.id, "lead", {
      cols: 80,
      rows: 24,
    });
    if (started.status !== "started") throw new Error("fixture start failed");
    context.store.updateRunStatus(started.run.id, "stopped");
    const result = await context.orchestration.assignOutcome(context.principal, context.command);
    expect(result).toMatchObject({ phase: "held", reason: "foreman_human_stop" });
    expect(context.coordinator.startRun).toHaveBeenCalledTimes(1);
    expect(context.store.listWorktrees()).toHaveLength(0);
    writeFileSync(join(context.repository, "local.txt"), "Human changes");
    const dirty = await context.orchestration.assignOutcome(context.principal, {
      ...context.command,
      requestId: "dirty-source",
    });
    expect(dirty).toMatchObject({ phase: "held", reason: "foreman_human_stop", sourceDirty: true });
    expect(readFileSync(join(context.repository, "local.txt"), "utf8")).toBe("Human changes");
  });

  it.each(["new", "auto"] as const)(
    "creates a clean pinned workspace from dirty source with %s and preserves all local changes",
    async (workspace) => {
      const context = await fixture(true, ["Do not commit"]);
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", context.repository, ...args], { encoding: "utf8" });
      writeFileSync(join(context.repository, "nested", "seed.txt"), "staged\n");
      git("add", "nested/seed.txt");
      writeFileSync(join(context.repository, "nested", "seed.txt"), "unstaged\n");
      writeFileSync(join(context.repository, "local.txt"), "Human changes");
      const status = git("status", "--porcelain");
      const index = git("diff", "--cached");
      const unstaged = git("diff");
      const stashes = git("stash", "list");
      const result = await context.orchestration.assignOutcome(context.principal, {
        ...context.command,
        workspace,
      });
      expect(result).toMatchObject({
        phase: "delegated",
        sourceHead: context.source.head,
        sourceDirty: true,
      });
      expect(context.goals.workspace(context.goal.id).preparations).toContainEqual(result);
      expect(context.goals.get(context.goal.id).constraints).toEqual(["Do not commit"]);
      const target = context.store.getCheckout(result.checkoutId!);
      expect(target).toMatchObject({ dirty: false, head: context.source.head, kind: "linked" });
      expect(readFileSync(join(target.path, "nested", "seed.txt"), "utf8")).toBe("initial\n");
      expect(() => readFileSync(join(target.path, "local.txt"))).toThrow();
      expect(git("status", "--porcelain")).toBe(status);
      expect(git("diff", "--cached")).toBe(index);
      expect(git("diff")).toBe(unstaged);
      expect(git("stash", "list")).toBe(stashes);
      expect(git("rev-parse", "HEAD").trim()).toBe(context.source.head);
      expect(readFileSync(join(context.repository, "local.txt"), "utf8")).toBe("Human changes");
    },
  );

  it("holds dirty existing reuse but auto creates a new workspace from a dirty linked source", async () => {
    const context = await fixture();
    const prepared = await context.orchestration.prepareWorkspace(
      context.principal,
      context.command,
    );
    const linked = context.store.getCheckout(prepared.checkoutId!);
    writeFileSync(join(linked.path, "local.txt"), "keep linked edits");
    const held = await context.orchestration.prepareWorkspace(context.principal, {
      ...context.command,
      requestId: "reuse-dirty",
      workspace: "existing",
      checkoutId: linked.id,
    });
    expect(held).toMatchObject({
      phase: "held",
      reason: "foreman_workspace_unsuitable",
      sourceDirty: true,
    });
    expect(context.store.listWorktrees()).toHaveLength(1);
    const isolated = await context.orchestration.assignOutcome(context.principal, {
      ...context.command,
      requestId: "isolate-dirty",
    });
    expect(isolated).toMatchObject({ phase: "delegated", sourceDirty: true });
    expect(isolated.checkoutId).not.toBe(linked.id);
    expect(context.store.getCheckout(isolated.checkoutId!)).toMatchObject({
      dirty: false,
      head: linked.head,
    });
    expect(readFileSync(join(linked.path, "local.txt"), "utf8")).toBe("keep linked edits");
    expect(context.store.listWorktrees()).toHaveLength(2);
  });

  it("holds existing target reuse when edits arrive during preparation", async () => {
    const context = await fixture();
    const prepared = await context.orchestration.prepareWorkspace(
      context.principal,
      context.command,
    );
    const linked = context.store.getCheckout(prepared.checkoutId!);
    const refresh = context.checkouts.refresh.bind(context.checkouts);
    let refreshCount = 0;
    vi.spyOn(context.checkouts, "refresh").mockImplementation(async (checkoutId) => {
      if (checkoutId === linked.id && ++refreshCount === 2)
        writeFileSync(join(linked.path, "late.txt"), "keep late edits");
      return refresh(checkoutId);
    });
    expect(
      await context.orchestration.assignOutcome(context.principal, {
        ...context.command,
        requestId: "reuse-late-dirty",
        workspace: "existing",
        checkoutId: linked.id,
      }),
    ).toMatchObject({ phase: "held", reason: "foreman_workspace_unsuitable", sourceDirty: true });
    expect(context.coordinator.startRun).not.toHaveBeenCalled();
    expect(context.goals.delegations()).toHaveLength(0);
    expect(readFileSync(join(linked.path, "late.txt"), "utf8")).toBe("keep late edits");
  });

  it("holds a newly created target if its HEAD no longer matches the pinned commit", async () => {
    const context = await fixture();
    const create = context.worktrees.create.bind(context.worktrees);
    vi.spyOn(context.worktrees, "create").mockImplementation(async (...args) => {
      const created = await create(...args);
      execFileSync("git", [
        "-C",
        created.checkout!.path,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "external target change",
      ]);
      return created;
    });
    expect(
      await context.orchestration.assignOutcome(context.principal, context.command),
    ).toMatchObject({
      phase: "held",
      reason: "foreman_workspace_base_changed",
      sourceHead: context.source.head,
    });
    expect(context.coordinator.assignGroupCheckout).not.toHaveBeenCalled();
    expect(context.coordinator.startRun).not.toHaveBeenCalled();
  });

  it("waits for busy teams, expires bounded waiting, and never stops a Human-controlled run", async () => {
    const context = await fixture();
    await context.coordinator.startRun(context.group.id, "lead", { cols: 80, rows: 24 });
    context.ready(false);
    expect(
      await context.orchestration.assignOutcome(context.principal, context.command),
    ).toMatchObject({ phase: "waiting", reason: "runtime_not_ready" });
    expect(context.store.listWorktrees()).toHaveLength(0);
    context.advance(600_001);
    await context.orchestration.tick();
    expect(context.orchestration.list(context.goal.id)[0]!.phase).toBe("expired");
    context.ready(true);
    context.controlled(true);
    expect(
      await context.orchestration.assignOutcome(context.principal, {
        ...context.command,
        requestId: "controlled",
      }),
    ).toMatchObject({ phase: "held", reason: "human_controlled" });
    expect(context.coordinator.stopRun).not.toHaveBeenCalled();
  });

  it("prepares explicitly without starting members and reuses that owned linked checkout", async () => {
    const context = await fixture();
    await context.coordinator.startRun(context.group.id, "lead", { cols: 80, rows: 24 });
    context.coordinator.startRun.mockClear();
    const result = await context.orchestration.prepareWorkspace(context.principal, context.command);
    expect(result.phase).toBe("ready");
    expect(context.coordinator.startRun).not.toHaveBeenCalled();
    const assigned = await context.orchestration.assignOutcome(context.principal, {
      ...context.command,
      requestId: "outcome",
    });
    expect(assigned).toMatchObject({ phase: "delegated", checkoutId: result.checkoutId });
    expect(context.store.listWorktrees()).toHaveLength(1);
  });

  it("reconciles a delegation receipt after interruption without another handoff", async () => {
    const context = await fixture();
    const prepared = await context.orchestration.assignOutcome(context.principal, context.command);
    const row = context.store.database
      .prepare("SELECT data_json FROM foreman_preparations WHERE id = ?")
      .get(prepared.id)!;
    const interrupted = JSON.parse(String(row.data_json));
    interrupted.phase = "delegating";
    delete interrupted.delegationId;
    context.store.database
      .prepare("UPDATE foreman_preparations SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(interrupted), prepared.id);
    const resumed = new ForemanOrchestrationService(
      context.store,
      context.goals,
      context.checkouts,
      context.worktrees,
      context.coordinator,
      context.now,
    );
    const delegate = vi.spyOn(context.goals, "delegatePrepared");
    context.advance();
    await resumed.tick();
    expect(resumed.list(context.goal.id)[0]).toMatchObject({
      phase: "delegated",
      delegationId: prepared.delegationId,
    });
    expect(delegate).not.toHaveBeenCalled();
    expect(context.coordinator.startRun).toHaveBeenCalledTimes(2);
  });

  it("rechecks a Human stop that arrives while a worktree is being created", async () => {
    const context = await fixture();
    const result = await context.coordinator.startRun(context.group.id, "lead", {
      cols: 80,
      rows: 24,
    });
    if (result.status !== "started") throw new Error("fixture start failed");
    const create = context.worktrees.create.bind(context.worktrees);
    vi.spyOn(context.worktrees, "create").mockImplementation(async (...args) => {
      const created = await create(...args);
      context.store.updateRunStatus(result.run.id, "stopped");
      return created;
    });
    expect(
      await context.orchestration.assignOutcome(context.principal, context.command),
    ).toMatchObject({ phase: "held", reason: "foreman_human_stop" });
    expect(context.coordinator.startRun).toHaveBeenCalledTimes(1);
    expect(context.coordinator.assignGroupCheckout).not.toHaveBeenCalled();
  });

  it("does not repeat an uncertain start after a crash", async () => {
    const context = await fixture();
    const start = context.coordinator.startRun.getMockImplementation()!;
    context.coordinator.startRun.mockImplementationOnce(async (...args) => {
      await start(...args);
      throw new Error("lost start receipt");
    });
    const result = await context.orchestration.assignOutcome(context.principal, context.command);
    expect(result).toMatchObject({ phase: "held", reason: "preparation_effect_uncertain" });
    context.advance();
    await context.orchestration.tick();
    expect(context.coordinator.startRun).toHaveBeenCalledTimes(1);
    expect(context.goals.delegations()).toHaveLength(0);
  });

  it("does not let a later policy upgrade silently approve a Human-mode goal", async () => {
    const context = await fixture(false);
    context.config.foreman!.autonomy.approvalMode = "autonomous";
    expect(
      await context.orchestration.assignOutcome(context.principal, context.command),
    ).toMatchObject({ phase: "needs-approval" });
    expect(context.store.listWorktrees()).toHaveLength(0);
  });

  it("keeps transcript policy changes separate from routine preparation", async () => {
    const context = await fixture();
    context.config.foreman!.autonomy.transcript.maxLines = 1;
    context.config.foreman!.autonomy.transcript.maxBytes = 1024;
    expect(
      await context.orchestration.assignOutcome(context.principal, context.command),
    ).toMatchObject({ phase: "delegated" });
  });

  it("fences autonomous revocation and cancellation before checkout assignment", async () => {
    for (const change of ["revoke", "cancel"] as const) {
      const context = await fixture();
      const create = context.worktrees.create.bind(context.worktrees);
      vi.spyOn(context.worktrees, "create").mockImplementation(async (...args) => {
        const created = await create(...args);
        if (change === "revoke") context.config.foreman!.autonomy.approvalMode = "human";
        else
          context.goals.control("human", {
            id: context.goal.id,
            expectedRevision: context.goals.get(context.goal.id).revision,
            action: "cancel",
          });
        return created;
      });
      expect(
        await context.orchestration.assignOutcome(context.principal, context.command),
      ).toMatchObject({ phase: change === "cancel" ? "cancelled" : "held" });
      expect(context.coordinator.assignGroupCheckout).not.toHaveBeenCalled();
      expect(context.coordinator.startRun).not.toHaveBeenCalled();
    }
  });

  it("pauses a preparing goal on Human takeover and prevents independent recovery", async () => {
    const context = await fixture();
    context.ready(false);
    await context.orchestration.assignOutcome(context.principal, context.command);
    const lead = context.store.getActiveRun(context.group.id, "lead")!;
    expect(context.goals.authorizeRecovery(context.group.id, "lead")).toBe(false);
    context.goals.pauseForTakeover(lead.id);
    expect(context.goals.get(context.goal.id).state).toBe("paused");
    context.ready(true);
    context.advance();
    await context.orchestration.tick();
    expect(context.orchestration.list(context.goal.id)[0]).toMatchObject({
      phase: "waiting",
      reason: "goal_paused",
    });
    expect(context.goals.delegations()).toHaveLength(0);
  });

  it("preserves source edits made while Git preparation is in progress", async () => {
    const context = await fixture();
    await context.coordinator.startRun(context.group.id, "lead", { cols: 80, rows: 24 });
    const create = context.worktrees.create.bind(context.worktrees);
    vi.spyOn(context.worktrees, "create").mockImplementation(async (...args) => {
      const created = await create(...args);
      writeFileSync(join(context.repository, "late.txt"), "keep this work");
      return created;
    });
    expect(
      await context.orchestration.assignOutcome(context.principal, context.command),
    ).toMatchObject({ phase: "delegated", sourceDirty: true, sourceHead: context.source.head });
    const target = context.store.getEffectiveGroupCheckout(context.group.id)!;
    expect(target).toMatchObject({ dirty: false, head: context.source.head });
    expect(() => readFileSync(join(target.path, "late.txt"))).toThrow();
    expect(readFileSync(join(context.repository, "late.txt"), "utf8")).toBe("keep this work");
  });

  it("refuses a colliding branch instead of adopting its unowned checkout", async () => {
    const context = await fixture();
    const branch = `foreman/${createHash("sha256").update(`${context.goal.id}:${context.command.requestId}`).digest("hex").slice(0, 32)}`;
    execFileSync("git", ["-C", context.repository, "branch", branch]);
    expect(
      await context.orchestration.assignOutcome(context.principal, context.command),
    ).toMatchObject({ phase: "held", reason: "worktree_ownership_conflict" });
    expect(context.coordinator.assignGroupCheckout).not.toHaveBeenCalled();
    expect(context.store.getEffectiveGroupCheckout(context.group.id)!.id).toBe(context.source.id);
  });

  it("resolves and retains the source commit across waiting and replay", async () => {
    const context = await fixture();
    await context.coordinator.startRun(context.group.id, "lead", { cols: 80, rows: 24 });
    context.ready(false);
    const waiting = await context.orchestration.assignOutcome(context.principal, context.command);
    execFileSync("git", [
      "-C",
      context.repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "later",
    ]);
    context.ready(true);
    context.advance();
    await context.orchestration.tick();
    const prepared = context.orchestration.list(context.goal.id)[0]!;
    expect(prepared).toMatchObject({ phase: "delegated", sourceHead: waiting.sourceHead });
    expect(context.store.getCheckout(prepared.checkoutId!).head).toBe(context.source.head);
  });

  it("resumes checkout binding after interruption without assigning or stopping twice", async () => {
    const context = await fixture();
    context.ready(false);
    const prepared = await context.orchestration.assignOutcome(context.principal, context.command);
    const row = context.store.database
      .prepare("SELECT data_json FROM foreman_preparations WHERE id = ?")
      .get(prepared.id)!;
    const interrupted = JSON.parse(String(row.data_json));
    interrupted.phase = "assigning";
    interrupted.bound = false;
    interrupted.checkoutRevision--;
    context.store.database
      .prepare("UPDATE foreman_preparations SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(interrupted), prepared.id);
    context.ready(true);
    context.advance();
    const resumed = new ForemanOrchestrationService(
      context.store,
      context.goals,
      context.checkouts,
      context.worktrees,
      context.coordinator,
      context.now,
    );
    await resumed.tick();
    expect(resumed.list(context.goal.id)[0]!.phase).toBe("delegated");
    expect(context.coordinator.assignGroupCheckout).toHaveBeenCalledTimes(1);
    expect(context.coordinator.startRun).toHaveBeenCalledTimes(2);
  });

  it("does not create a second workspace after losing its creation receipt", async () => {
    const context = await fixture();
    context.coordinator.assignGroupCheckout.mockRejectedValueOnce(
      new Error("interrupted before binding"),
    );
    const prepared = await context.orchestration.assignOutcome(context.principal, context.command);
    const row = context.store.database
      .prepare("SELECT data_json FROM foreman_preparations WHERE id = ?")
      .get(prepared.id)!;
    const interrupted = JSON.parse(String(row.data_json));
    interrupted.phase = "preparing";
    delete interrupted.checkoutId;
    interrupted.bound = false;
    interrupted.assignmentPending = false;
    context.store.database
      .prepare("UPDATE foreman_preparations SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(interrupted), prepared.id);
    context.advance();
    const resumed = new ForemanOrchestrationService(
      context.store,
      context.goals,
      context.checkouts,
      context.worktrees,
      context.coordinator,
      context.now,
    );
    await resumed.tick();
    expect(resumed.list(context.goal.id)[0]).toMatchObject({
      phase: "delegated",
      checkoutId: prepared.checkoutId,
    });
    expect(context.store.listWorktrees()).toHaveLength(1);
  });
});
