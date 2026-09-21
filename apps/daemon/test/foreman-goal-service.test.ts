import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRun,
  CreateAgentActionCommandSchema,
  ForemanGoalRequestOriginSchema,
  ForemanGoalWorkspaceSchema,
  NanasaConfigSchema,
  ProposeForemanGoalCommandSchema,
} from "@nanasa/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActionService } from "../src/actions/agent-action-service.js";
import { PeerCapabilityPolicy } from "../src/actions/peer-capability-policy.js";
import { ForemanCleanupService } from "../src/foreman-cleanup-service.js";
import { ForemanConversationService } from "../src/foreman-conversation-service.js";
import { ForemanGoalService } from "../src/foreman-goal-service.js";
import { type ControlRouterServices, registerControlRouter } from "../src/http/control-router.js";
import { DomainError, NanasaStore } from "../src/store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nanasa-goals-"));
  const path = join(root, "state.sqlite");
  const store = new NanasaStore(path);
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const config = NanasaConfigSchema.parse({
    version: 2,
    repository: { path: root },
    integrations: {
      copilot: {
        id: "copilot",
        name: "Copilot",
        kind: "copilot",
        command: ["copilot"],
        commandSource: "builtin",
      },
    },
    groups: {},
    foreman: { integrationId: "copilot", enabled: true },
  });
  const service = new ForemanGoalService(store, () => config);
  const command = {
    requestId: "goal-one",
    title: "Migrate SDK",
    objective: "Research, plan, implement and independently review draft-10 conformance",
    constraints: [],
  };
  return { store, config, service, command, path, root };
}

describe("Foreman goal source linkage", () => {
  it("pins the nested Human request across reopen, resume and linked-checkout kickoff", async () => {
    const { store, config, service, goal, delegation, actions, lead, root, path, command } =
      teamFixture(false, true, false, false, false, true);
    expect(goal.requestOrigin).toEqual({
      repositoryId: "repo-one",
      checkoutId: "checkout-one",
      workingDirectory: "examples/multi-coding-agents",
      source: "foreman-run",
    });
    expect(goal.sourceText).toBe("Create a browser-based tool in ./src dir. Keep my exact path.");
    config.repository.path = root;
    config.integrations.copilot!.cwd = root;
    const paused = service.control("human", {
      id: goal.id,
      expectedRevision: service.get(goal.id).revision,
      action: "pause",
    });
    const reopened = new NanasaStore(path);
    try {
      const durable = new ForemanGoalService(reopened, () => config);
      expect(durable.get(goal.id).requestOrigin).toEqual(goal.requestOrigin);
      expect(durable.get(goal.id).sourceText).toBe(goal.sourceText);
      expect(durable.propose({ ...command, sourceMessageId: goal.sourceMessageId })).toEqual(
        paused,
      );
    } finally {
      reopened.close();
    }
    const resumed = new ForemanGoalService(store, () => config);
    resumed.control("human", { id: goal.id, expectedRevision: paused.revision, action: "resume" });
    await resumed.tick(actions, {
      startRun: async () => {
        throw new Error("Do not restart");
      },
    });
    expect(resumed.delegation(delegation.id).state).toBe("offered");
    const prompt = store.listAgentActions()[0]!.prompt;
    expect(prompt).toContain(join(root, "linked/examples/multi-coding-agents"));
    expect(prompt).toContain(
      "Repository-relative expected ./ anchor: examples/multi-coding-agents/",
    );
    expect(prompt).toContain(goal.sourceText!);
    expect(prompt).not.toContain("apps/portal/src");
    expect(prompt).toContain("candidatePath remains checkout-root-relative");
    expect(prompt).toContain("read-only roles still apply");
    expect(resumed.own(lead)[0]!.requestContext).toBe(
      resumed.requestContext(goal, "checkout-linked"),
    );
    expect(resumed.workspace(goal.id).requestContext).toContain(goal.sourceText!);
  });

  it("uses the configured repository root for portal proposals, not the active Foreman cwd", () => {
    const { service, config, root, command } = teamFixture(false, true, false, false, false, true);
    config.foreman!.autonomy.maxActiveGoals = 2;
    config.repository.path = root;
    const goal = service.propose({ ...command, requestId: "portal-goal" });
    expect(goal.requestOrigin).toMatchObject({ workingDirectory: ".", source: "repository-root" });
    expect(service.requestContext(goal)).toContain("Repository-relative expected ./ anchor: ./");
  });

  it("falls back to the configured integration cwd and identifies an effective linked source", () => {
    const { service, store, config, root, foreman, command } = teamFixture(
      false,
      true,
      false,
      false,
      false,
      true,
    );
    config.foreman!.autonomy.maxActiveGoals = 3;
    config.integrations.copilot!.cwd = join(root, "examples/multi-coding-agents");
    store.database
      .prepare("UPDATE runs SET resolved_working_directory = NULL WHERE id = ?")
      .run(foreman.runId);
    const primary = service.propose({ ...command, requestId: "integration-goal" }, foreman);
    expect(primary.requestOrigin).toMatchObject({
      workingDirectory: "examples/multi-coding-agents",
      source: "foreman-integration",
    });
    store.database
      .prepare("UPDATE runs SET resolved_working_directory = ? WHERE id = ?")
      .run(join(root, "linked/examples/multi-coding-agents"), foreman.runId);
    const linked = service.propose({ ...command, requestId: "linked-source" }, foreman);
    expect(linked.requestOrigin).toMatchObject({
      checkoutId: "checkout-linked",
      workingDirectory: "examples/multi-coding-agents",
      source: "foreman-run",
    });
  });

  it("keeps legacy origins explicitly unknown and does not fabricate original Human text", () => {
    const { store, service, config, goal, foreman, command } = teamFixture();
    config.foreman!.autonomy.maxActiveGoals = 2;
    const legacy = { ...goal };
    delete legacy.requestOrigin;
    store.database
      .prepare("UPDATE foreman_coordination_records SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(legacy), goal.id);
    expect(service.get(goal.id).requestOrigin).toBeUndefined();
    expect(service.workspace(goal.id).requestContext).toContain(
      "unknown (not recorded for this goal)",
    );
    expect(service.workspace(goal.id).requestContext).not.toContain("(absolute):");
    const direct = service.propose({ ...command, requestId: "direct-tui" }, foreman);
    expect(direct.sourceText).toBeUndefined();
    expect(service.requestContext(direct)).toContain("Do not invent a quotation");
  });

  it("rejects origin mapping outside the assigned checkout, including symlinks", () => {
    const { service, goal, root } = teamFixture(false, true, false, false, false, true);
    const target = join(root, "linked/examples/multi-coding-agents");
    rmSync(target, { recursive: true });
    symlinkSync(join(root, "examples/multi-coding-agents"), target, "dir");
    expect(() => service.requestContext(goal, "checkout-linked")).toThrow(/escapes/);
    expect(() =>
      service.requestContext(
        {
          ...goal,
          requestOrigin: { ...goal.requestOrigin!, repositoryId: "another-repository" },
        },
        "checkout-linked",
      ),
    ).toThrow(/another repository/);
  });

  it("keeps request origins checkout-relative and out of model-authored proposals", () => {
    const { command } = fixture();
    const origin = {
      repositoryId: "repository-one",
      checkoutId: "checkout-one",
      workingDirectory: "examples/multi-coding-agents",
      source: "foreman-run",
    };
    expect(ForemanGoalRequestOriginSchema.parse(origin)).toEqual(origin);
    expect(ForemanGoalRequestOriginSchema.parse({ ...origin, workingDirectory: "." })).toEqual({
      ...origin,
      workingDirectory: ".",
    });
    for (const workingDirectory of ["/tmp", "../src", "nested/../../src", "C:/src", "nested\\src"])
      expect(
        ForemanGoalRequestOriginSchema.safeParse({ ...origin, workingDirectory }).success,
      ).toBe(false);
    expect(
      ProposeForemanGoalCommandSchema.safeParse({ ...command, requestOrigin: origin }).success,
    ).toBe(false);
    expect(
      ProposeForemanGoalCommandSchema.safeParse({ ...command, sourceText: "invented" }).success,
    ).toBe(false);
  });

  it.each(["agent", "foreman"])(
    "does not accept a stored %s message as Human authority",
    (kind) => {
      const { store, service, command } = fixture();
      const source = store.sendForemanMessage(
        { kind: "operator", operatorId: "human" },
        { requestId: "non-human-source", text: "Agent-originated request" },
      );
      store.database
        .prepare("UPDATE foreman_messages SET sender_json = ? WHERE id = ?")
        .run(JSON.stringify({ kind }), source.id);
      expect(() => service.propose({ ...command, sourceMessageId: source.id })).toThrowError(
        expect.objectContaining({
          code: "foreman_goal_source_message_invalid",
          details: expect.objectContaining({ field: "sourceMessageId", effect: "none" }),
        }),
      );
      expect(service.list()).toEqual([]);
      expect(store.database.prepare("SELECT id FROM foreman_notifications").all()).toEqual([]);
    },
  );

  it("rejects the live solar-system channel-as-question arguments without effects and permits correction", () => {
    const { store, service } = fixture();
    const sourceMessageId = "fm_1ce2b46d-aed4-4d0b-afe1-98167202c73f";
    const source = store.sendForemanMessage(
      { kind: "operator", operatorId: "human" },
      {
        requestId: "solar-source",
        text: "create browser based solar system simulator in ./src dir",
      },
    );
    store.atomic(() => {
      store.database.exec("PRAGMA defer_foreign_keys = ON");
      store.database
        .prepare("UPDATE foreman_messages SET id = ? WHERE id = ?")
        .run(sourceMessageId, source.id);
      store.database
        .prepare("UPDATE foreman_inbox SET message_id = ? WHERE message_id = ?")
        .run(sourceMessageId, source.id);
    });
    const command = {
      title: "Build browser solar system simulator",
      objective:
        "Create a polished browser-based solar system simulator in ./src, with an interactive animated planetary system and clear controls suitable for running in the existing example application.",
      constraints: [
        "Limit implementation to the requested ./src application surface and preserve existing repository work.",
        "Include practical validation using the repository's existing tooling.",
        "Provide independent same-commit review and validation evidence before completion.",
      ],
      requestId: "solar-system-goal-fm-1ce2b46d",
      sourceMessageId,
      sourceConversationIds: [sourceMessageId],
    };
    const before = store.database.prepare("SELECT COUNT(*) AS count FROM audits").get();
    expect(() => service.propose(command)).toThrowError(
      expect.objectContaining({
        code: "foreman_goal_source_conversation_invalid",
        statusCode: 400,
        details: expect.objectContaining({
          field: "sourceConversationIds",
          index: 0,
          effect: "none",
          retry: "correct-input",
          nextAction: expect.stringContaining("same requestId"),
        }),
      }),
    );
    expect(service.list()).toEqual([]);
    expect(store.database.prepare("SELECT id FROM foreman_notifications").all()).toEqual([]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM audits").get()).toEqual(before);
    const corrected = { ...command, sourceConversationIds: [] };
    const goal = service.propose(corrected);
    expect(goal.sourceMessageId).toBe(sourceMessageId);
    expect(goal.sourceText).toBe(source.text);
    expect(goal.sourceConversationIds).toEqual([]);
    expect(service.propose(corrected)).toEqual(goal);
    expect(() => service.propose(command)).toThrow(/different content/);
  });
});

describe("everyday Foreman cleanup", () => {
  it("rejects stale goal approval atomically and never widens a finished selection", () => {
    const { store, service, command } = fixture();
    const cleanup = new ForemanCleanupService(store, service);
    const first = service.propose(command);
    service.control("human", { id: first.id, expectedRevision: 0, action: "cancel" });
    const second = service.propose({ ...command, requestId: "second-goal" });
    const request = cleanup.request("foreman", {
      requestId: "stale-cleanup",
      scope: "finished-goals",
      goals: [
        { id: first.id, expectedRevision: 1 },
        { id: second.id, expectedRevision: 0 },
      ],
    });
    service.control("human", { id: second.id, expectedRevision: 0, action: "cancel" });
    expect(() =>
      cleanup.approve("human", { id: request.id, digest: request.digest, confirmation: true }),
    ).toThrow(/revision changed/);
    expect(cleanup.requests()).toEqual([request]);
    expect(cleanup.isRemoved(first.id)).toBe(false);
    expect(cleanup.isRemoved(second.id)).toBe(false);
    expect(cleanup.requests("other-foreman", request.id)).toEqual([]);
    expect(() =>
      cleanup.approve("human", {
        id: request.id,
        digest: request.digest,
        confirmation: true,
        throughSequence: 999,
      }),
    ).toThrow();
  });

  it("requires exact durable operator approval without creating a delivery goal", () => {
    const { store, service, path, config } = fixture();
    const cleanup = new ForemanCleanupService(store, service);
    const message = store.sendForemanMessage(
      { kind: "operator", operatorId: "human" },
      { requestId: "cleanup-source", text: "Retain this operational record" },
    );
    const command = {
      requestId: "request-cleanup",
      scope: "channel",
      throughSequence: message.sequence,
    };
    const requested = cleanup.request("foreman", command);
    expect(requested.state).toBe("pending");
    expect(cleanup.request("foreman", command)).toEqual(requested);
    expect(() => cleanup.request("foreman", { ...command, throughSequence: 0 })).toThrow(
      /different content/,
    );
    expect(() => cleanup.request("foreman", { ...command, confirmation: true })).toThrow();
    expect(service.list()).toEqual([]);
    expect(store.readForemanChannel({ after: 0, limit: 100 }).messages).toHaveLength(1);
    const reopened = new NanasaStore(path);
    try {
      const durable = new ForemanCleanupService(
        reopened,
        new ForemanGoalService(reopened, () => config),
      );
      expect(durable.requests()).toEqual([requested]);
      expect(() =>
        durable.approve("human", { id: requested.id, digest: "0".repeat(64), confirmation: true }),
      ).toThrow(/scope/);
      const approval = { id: requested.id, digest: requested.digest, confirmation: true };
      const approved = durable.approve("human", approval);
      expect(approved).toMatchObject({
        state: "approved",
        operatorId: "human",
        result: { retained: true, messagesCleared: 1 },
      });
      expect(durable.approve("human", approval)).toEqual(approved);
      expect(durable.request("foreman", command)).toEqual(approved);
      expect(reopened.readForemanChannel({ after: 0, limit: 100 }).messages).toEqual([]);
      expect(
        reopened.readForemanChannel({ after: 0, limit: 100, messageId: message.id }).messages,
      ).toHaveLength(1);
      expect(reopened.listForemanInbox()[0]?.messageId).toBe(message.id);
      expect(
        reopened.database
          .prepare("SELECT prompt FROM foreman_inbox WHERE message_id = ?")
          .get(message.id)?.prompt,
      ).toContain(`{"messageId":"${message.id}"}`);
    } finally {
      reopened.close();
    }
  });

  it("exposes operator cleanup and retained reads over the existing HTTP router", async () => {
    const { store, service, command } = fixture();
    const goal = service.propose(command);
    const app = Fastify();
    const services = {
      store,
      goals: service,
      auth: {
        authenticate: (request: { headers: Record<string, string> }) => {
          if (request.headers["x-test-operator"] !== "human")
            throw new DomainError("operator_unauthorized", "Operator required", 401);
          return { operatorId: "human" };
        },
      },
    } as unknown as ControlRouterServices;
    registerControlRouter(app, services);
    const payload = {
      scope: "goal",
      requestId: "http-cleanup",
      confirmation: true,
      cancel: true,
      goal: { id: goal.id, expectedRevision: goal.revision },
    };
    try {
      expect(
        (await app.inject({ method: "POST", url: "/api/v1/foreman/cleanup", payload })).statusCode,
      ).toBe(401);
      expect(new ForemanCleanupService(store, service).isRemoved(goal.id)).toBe(false);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/foreman/cleanup",
        payload,
        headers: { "x-test-operator": "human" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ removedGoalIds: [goal.id], retained: true });
      expect((await app.inject("/api/v1/foreman/goals")).json()).toEqual([]);
      expect((await app.inject("/api/v1/foreman/goals?includeRemoved=true")).json()[0].id).toBe(
        goal.id,
      );
      expect((await app.inject(`/api/v1/foreman/goals/${goal.id}`)).json().goal.id).toBe(goal.id);
      expect((await app.inject("/api/v1/foreman/cleanup/effects")).json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("removes a terminal goal while peers work and preserves old proposal receipts", () => {
    const { store, service, command } = fixture();
    const cleanup = new ForemanCleanupService(store, service);
    const goal = service.propose(command);
    const cancelled = service.control("human", {
      id: goal.id,
      expectedRevision: 0,
      action: "cancel",
    });
    const peer = service.propose({ ...command, requestId: "peer" });
    service.control("human", { id: peer.id, expectedRevision: 0, action: "approve" });
    const request = {
      scope: "goal",
      requestId: "cleanup-one",
      confirmation: true,
      goal: { id: goal.id, expectedRevision: cancelled.revision },
      cancel: false,
    };
    const result = cleanup.execute("human", request);
    expect(result.removedGoalIds).toEqual([goal.id]);
    expect(result.retained).toBe(true);
    expect(cleanup.listGoals().map((item) => item.id)).toEqual([peer.id]);
    expect(service.list().map((item) => item.id)).toEqual([peer.id]);
    expect(service.list(true).map((item) => item.id)).toEqual([goal.id, peer.id]);
    expect(service.get(peer.id).state).toBe("running");
    expect(service.propose(command)).toEqual(cancelled);
    expect(cleanup.execute("human", request)).toEqual(result);
    expect(() => cleanup.execute("human", { ...request, cancel: true })).toThrow(/request ID/);
  });

  it("clears a captured channel cutoff, retains late replies and survives reopening", () => {
    const { store, service, command, path } = fixture();
    const cleanup = new ForemanCleanupService(store, service);
    const sender = { kind: "operator" as const, operatorId: "human" };
    const source = store.sendForemanMessage(sender, { requestId: "old", text: "Original intent" });
    const goal = service.propose({ ...command, sourceMessageId: source.id });
    service.control("human", { id: goal.id, expectedRevision: 0, action: "approve" });
    const newer = store.sendForemanMessage(sender, {
      requestId: "new",
      text: "New independent intent",
    });
    const beforeInbox = store.listForemanInbox();
    const result = cleanup.execute("human", {
      scope: "channel",
      requestId: "clear-one",
      confirmation: true,
      throughSequence: source.sequence,
    });
    expect(result.messagesCleared).toBe(1);
    expect(store.listForemanInbox()).toEqual(beforeInbox);
    const late = store.sendForemanMessage(sender, {
      requestId: "late",
      text: "Late reply",
      replyTo: source.id,
    });
    store.sendForemanMessage(sender, {
      requestId: "later",
      text: "Nested late reply",
      replyTo: late.id,
    });
    expect(
      store.readForemanChannel({ after: 0, limit: 100 }).messages.map((item) => item.id),
    ).toEqual([newer.id]);
    expect(
      store.readForemanChannel({ after: 0, limit: 100, messageId: source.id }).messages,
    ).toEqual([{ ...source, cleared: true }]);
    expect(late.cleared).toBe(true);
    expect(store.sendForemanMessage(sender, { requestId: "old", text: "Original intent" })).toEqual(
      { ...source, cleared: true },
    );
    expect(
      store.readForemanChannel({ after: 0, limit: 100, includeCleared: true }).messages,
    ).toHaveLength(4);
    expect(service.get(goal.id).state).toBe("running");
    const reopened = new NanasaStore(path);
    try {
      expect(reopened.readForemanChannel({ after: 0, limit: 100 }).messages).toEqual([newer]);
    } finally {
      reopened.close();
    }
    cleanup.execute("human", {
      scope: "channel",
      requestId: "clear-two",
      confirmation: true,
      throughSequence: newer.sequence,
    });
    cleanup.execute("human", {
      scope: "channel",
      requestId: "stale-clear",
      confirmation: true,
      throughSequence: source.sequence,
    });
    expect(store.readForemanChannel({ after: 0, limit: 100 })).toMatchObject({
      messages: [],
      clearedThrough: newer.sequence,
    });
  });

  it("atomically validates a finished selection and does not remove newly finished peers", () => {
    const { store, service, command, path, config } = fixture();
    const cleanup = new ForemanCleanupService(store, service);
    const selected = service.propose(command);
    service.control("human", { id: selected.id, expectedRevision: 0, action: "cancel" });
    const peer = service.propose({ ...command, requestId: "peer" });
    const request = {
      scope: "finished-goals",
      requestId: "clear-finished",
      confirmation: true,
      goals: [
        { id: selected.id, expectedRevision: 1 },
        { id: peer.id, expectedRevision: 0 },
      ],
    };
    expect(() => cleanup.execute("human", request)).toThrow(/Active goals/);
    expect(cleanup.isRemoved(selected.id)).toBe(false);
    service.control("human", { id: peer.id, expectedRevision: 0, action: "cancel" });
    cleanup.execute("human", { ...request, goals: [request.goals[0]] });
    const reopened = new NanasaStore(path);
    try {
      const goals = new ForemanGoalService(reopened, () => config);
      expect(new ForemanCleanupService(reopened, goals).listGoals().map((item) => item.id)).toEqual(
        [peer.id],
      );
      expect(goals.propose(command).id).toBe(selected.id);
    } finally {
      reopened.close();
    }
  });

  it("cancel-and-remove retains live runs, action state and checkout ownership", async () => {
    const { store, service, goal, actions, group, lead, reviewer } = teamFixture();
    await service.tick(actions, { restart: async () => {} });
    const beforeActions = store.listAgentActions();
    const beforeCheckout = store.getCheckout("checkout-one");
    const cleanup = new ForemanCleanupService(store, service);
    const selection = { id: goal.id, expectedRevision: service.get(goal.id).revision };
    expect(() =>
      cleanup.execute("human", {
        scope: "goal",
        requestId: "no-cancel",
        confirmation: true,
        goal: selection,
      }),
    ).toThrow(/cancel and remove/);
    const result = cleanup.execute("human", {
      scope: "goal",
      requestId: "cancel-remove",
      confirmation: true,
      goal: selection,
      cancel: true,
    });
    expect(service.get(goal.id).state).toBe("cancelled");
    expect(result.pendingEffects[0]?.runIds).toEqual([lead.runId]);
    expect(result.pendingEffects[0]?.actionIds.sort()).toEqual(
      beforeActions.map((item) => item.id).sort(),
    );
    expect(store.listAgentActions()).toEqual(beforeActions);
    expect(store.getActiveRun(group.id, "alex")?.id).toBe(lead.runId);
    expect(store.getActiveRun(group.id, "sam")?.id).toBe(reviewer.runId);
    expect(store.getCheckout("checkout-one")).toEqual(beforeCheckout);
    expect(cleanup.listGoals()).toEqual([]);
    expect(cleanup.pendingEffects()).toEqual(result.pendingEffects);
    for (const action of store.listAgentActions())
      store.transitionAgentAction(action.id, [action.state], "completed");
    store.updateRuntimeRunStatus(lead.runId, "stopped");
    store.updateRuntimeRunStatus(reviewer.runId, "stopped");
    expect(cleanup.pendingEffects()).toEqual([]);
    const previous = store.getLatestRunForMembership(group.id, "alex")!;
    store.createRun({
      ...previous,
      id: "unrelated-new-run",
      generation: previous.generation + 1,
      status: "running",
      desiredState: "running",
      stoppedAt: undefined,
    });
    expect(cleanup.pendingEffects()).toEqual([]);
  });

  it.each([false, true])(
    "reconciles removed cancelled goal effects with stopBeforeRemoval=%s without resuming Human-stopped runs",
    async (stopBeforeRemoval) => {
      const { store, service, goal, delegation, actions, lead, reviewer, config, path } =
        teamFixture(true);
      const coordinator = { startRun: vi.fn(async () => store.getRun(lead.runId)) };
      await service.tick(actions, coordinator);
      service.report(lead, {
        requestId: "accept-before-removal",
        delegationId: delegation.id,
        kind: "accepted",
        summary: "Accepted",
        evidence: [],
        nextCheckSeconds: 900,
      });
      const handoff = store.listAgentActions()[0]!;
      store.database.prepare("DELETE FROM delegation_actions WHERE action_id = ?").run(handoff.id);
      const peer = actions.create(
        lead,
        CreateAgentActionCommandSchema.parse({
          kind: "prompt",
          groupId: reviewer.groupId,
          memberId: reviewer.memberId,
          prompt: "Review the delegated outcome",
        }),
        "review-before-removal",
      );
      const priorError = {
        code: "acceptance_unknown",
        message: "Prior input is unconfirmed",
        retryable: false,
      };
      for (const action of [handoff, peer])
        store.transitionAgentAction(action.id, [action.state], "stalled", {
          result: { effectsUnknown: true },
          error: priorError,
        });
      const unrelated = store.createAgentAction({
        ...store.getAgentAction(peer.id),
        id: "unrelated-stalled-peer",
        idempotencyKey: "unrelated-stalled-peer",
      });
      const stopTargets = () => {
        for (const target of [lead, reviewer]) {
          store.stopDesiredRun(target.runId, target.generation);
          store.updateRuntimeRunStatus(target.runId, "stopped", { reason: "operator_stopped" });
        }
      };
      if (stopBeforeRemoval) stopTargets();
      const cleanup = new ForemanCleanupService(store, service);
      const command = {
        scope: "goal",
        requestId: "remove-stalled-goal",
        confirmation: true,
        goal: { id: goal.id, expectedRevision: service.get(goal.id).revision },
        cancel: true,
      };
      const receipt = cleanup.execute("human", command);
      if (!stopBeforeRemoval) {
        stopTargets();
        expect(cleanup.pendingEffects()[0]?.actionIds.sort()).toEqual([handoff.id, peer.id].sort());
        expect(service.blockingTeamActions(lead.groupId)).toHaveLength(3);
        expect(store.getAgentAction(handoff.id).state).toBe("stalled");
      }
      const heldRuns = [store.getRun(lead.runId), store.getRun(reviewer.runId)];
      const membership = store.listActiveMemberships(lead.groupId);
      const checkout = store.getCheckout(delegation.checkoutId);
      const cancelledDelegation = service.delegation(delegation.id);
      const reopened = new NanasaStore(path);
      try {
        const durable = new ForemanGoalService(reopened, () => config);
        await durable.tick(actions, coordinator);
        await durable.tick(actions, coordinator);
      } finally {
        reopened.close();
      }
      for (const action of [handoff, peer]) {
        expect(store.getAgentAction(action.id)).toMatchObject({
          state: "superseded",
          result: { effectsUnknown: true },
          error: { code: "foreman_removed_goal", retryable: false },
        });
        expect(store.getAgentAction(action.id).error?.message).toContain(
          "not undone or certified complete",
        );
        const audits = store.database
          .prepare(
            "SELECT principal_id, metadata_json FROM audits WHERE action = ? AND resource_id = ?",
          )
          .all("foreman.retire-removed-goal-effect", action.id);
        expect(audits).toHaveLength(1);
        expect(audits[0]?.principal_id).toBe("human");
        expect(JSON.parse(String(audits[0]?.metadata_json))).toEqual({
          goalId: goal.id,
          target: action.target,
          priorState: "stalled",
          priorError,
        });
      }
      expect(service.get(goal.id).state).toBe("cancelled");
      expect(service.delegation(delegation.id)).toEqual(cancelledDelegation);
      expect(service.blockingTeamActions(lead.groupId)).toEqual([unrelated]);
      expect(store.getAgentAction(unrelated.id)).toEqual(unrelated);
      expect(cleanup.pendingEffects()).toEqual([]);
      expect(cleanup.execute("human", command)).toEqual(receipt);
      expect(receipt.pendingEffects).toHaveLength(stopBeforeRemoval ? 0 : 1);
      expect([store.getRun(lead.runId), store.getRun(reviewer.runId)]).toEqual(heldRuns);
      expect(store.listActiveMemberships(lead.groupId)).toEqual(membership);
      expect(store.getCheckout(delegation.checkoutId)).toEqual(checkout);
      expect(coordinator.startRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["failed desired-running", "failed", "running"],
    ["live desired-running", "running", "running"],
    ["live desired-stopped", "running", "stopped"],
    ["stopping", "stopping", "stopped"],
    ["failed desired-stopped", "failed", "stopped"],
    ["stopped desired-running", "stopped", "running"],
    ["expired reporter lease", "running", "running"],
    ["generation mismatch", "stopped", "stopped"],
    ["cancelled without removal", "stopped", "stopped"],
  ])("keeps %s goal effects blocking and unconfirmed", async (scenario, status, desiredState) => {
    const { store, service, goal, actions, lead } = teamFixture(true);
    const coordinator = { startRun: vi.fn(async () => store.getRun(lead.runId)) };
    await service.tick(actions, coordinator);
    const handoff = store.listAgentActions()[0]!;
    const retained = store.transitionAgentAction(handoff.id, [handoff.state], "stalled", {
      result: { effectsUnknown: true },
      error: {
        code: "acceptance_unknown",
        message: "Prior input is unconfirmed",
        retryable: false,
      },
    });
    const cleanup = new ForemanCleanupService(store, service);
    if (scenario === "cancelled without removal")
      service.control("human", {
        id: goal.id,
        expectedRevision: service.get(goal.id).revision,
        action: "cancel",
      });
    else
      cleanup.execute("human", {
        scope: "goal",
        requestId: "remove-unconfirmed-goal",
        confirmation: true,
        goal: { id: goal.id, expectedRevision: service.get(goal.id).revision },
        cancel: true,
      });
    store.database
      .prepare("UPDATE runs SET desired_state = ?, status = ?, generation = ? WHERE id = ?")
      .run(
        desiredState,
        status,
        scenario === "generation mismatch" ? lead.generation + 1 : lead.generation,
        lead.runId,
      );
    if (scenario === "expired reporter lease")
      store.database
        .prepare("UPDATE reporter_sessions SET lease_expires_at = ? WHERE run_id = ?")
        .run("2000-01-01T00:00:00.000Z", lead.runId);
    const heldRun = store.getRun(lead.runId);
    await service.tick(actions, coordinator);
    expect(store.getAgentAction(handoff.id)).toEqual(retained);
    expect(service.blockingTeamActions(lead.groupId)).toEqual([retained]);
    if (scenario !== "cancelled without removal")
      expect(cleanup.pendingEffects()[0]?.actionIds).toEqual([handoff.id]);
    expect(store.getRun(lead.runId)).toEqual(heldRun);
    expect(
      store.database
        .prepare("SELECT id FROM audits WHERE action = 'foreman.retire-removed-goal-effect'")
        .all(),
    ).toEqual([]);
    expect(coordinator.startRun).not.toHaveBeenCalled();
  });

  it.each(["completed", "cancelled"] as const)(
    "removes a %s goal with only linked peer and goal-principal effects",
    async (state) => {
      const { store, service, goal, delegation, actions, lead, reviewer } = teamFixture();
      await service.tick(actions, { restart: async () => {} });
      service.report(lead, {
        requestId: "accept-cleanup-delegation",
        delegationId: delegation.id,
        kind: "accepted",
        summary: "Accepted",
        evidence: [],
        nextCheckSeconds: 900,
      });
      const handoff = store.listAgentActions()[0]!;
      store.database.prepare("DELETE FROM delegation_actions WHERE action_id = ?").run(handoff.id);
      const peer = actions.create(
        lead,
        CreateAgentActionCommandSchema.parse({
          kind: "prompt",
          groupId: reviewer.groupId,
          memberId: reviewer.memberId,
          prompt: "Review the delegated outcome",
        }),
        "owned-peer-review",
      );
      expect(
        store.database
          .prepare("SELECT delegation_id FROM delegation_actions WHERE action_id = ?")
          .get(peer.id)?.delegation_id,
      ).toBe(delegation.id);
      const unrelated = store.createAgentAction({
        ...peer,
        id: "unrelated-peer-action",
        idempotencyKey: "unrelated-peer-work",
        state: "stalled",
        result: { effectsUnknown: true },
      });
      for (const record of [service.get(goal.id), service.delegation(delegation.id)])
        store.database
          .prepare("UPDATE foreman_coordination_records SET data_json = ? WHERE id = ?")
          .run(JSON.stringify({ ...record, state }), record.id);
      const beforeActions = store.listAgentActions();
      const cleanup = new ForemanCleanupService(store, service);
      const result = cleanup.execute("human", {
        scope: "goal",
        requestId: "remove-terminal-delegation",
        confirmation: true,
        goal: { id: goal.id, expectedRevision: service.get(goal.id).revision },
      });
      expect(result.pendingEffects).toEqual([
        {
          goalId: goal.id,
          actionIds: expect.arrayContaining([handoff.id, peer.id]),
          runIds: expect.arrayContaining([lead.runId, reviewer.runId]),
        },
      ]);
      expect(result.pendingEffects[0]!.actionIds).toHaveLength(2);
      expect(result.pendingEffects[0]!.runIds).toHaveLength(2);
      expect(store.listAgentActions()).toEqual(beforeActions);
      expect(store.getAgentAction(unrelated.id)).toEqual(unrelated);
      for (const action of [handoff, peer])
        store.transitionAgentAction(action.id, [action.state], "completed");
      expect(cleanup.pendingEffects()).toEqual([{ ...result.pendingEffects[0], actionIds: [] }]);
    },
  );

  it("keeps cleared conversation replies operational without resurrecting channel threads", async () => {
    const { store, service, foreman, group, lead } = teamFixture();
    const cleanup = new ForemanCleanupService(store, service);
    const conversations = new ForemanConversationService(store, service, () => false);
    const actions = new AgentActionService(
      store,
      1,
      new PeerCapabilityPolicy(undefined, undefined, undefined, (principal, command) =>
        conversations.authorize(principal, command),
      ),
    );
    const source = store.sendForemanMessage(
      { kind: "operator", operatorId: "human" },
      { requestId: "source", text: "Ask Alex" },
    );
    const request = conversations.ask(foreman, {
      requestId: "ask",
      groupId: group.id,
      memberId: "alex",
      text: "Progress?",
      sourceMessageId: source.id,
      expiresInSeconds: 3600,
    });
    await conversations.tick(actions);
    const actionId = conversations.get(request.id).actionId!;
    store.transitionAgentAction(actionId, ["created"], "submitted");
    cleanup.execute("human", {
      scope: "channel",
      requestId: "clear-context",
      confirmation: true,
      throughSequence: source.sequence,
    });
    const beforeActions = store.listAgentActions();
    conversations.reply(lead, { id: request.id, requestId: "late-answer", text: "Still working" });
    expect(conversations.get(request.id).response).toBe("Still working");
    const followup = conversations.ask(foreman, {
      requestId: "followup",
      groupId: group.id,
      memberId: "alex",
      text: "More detail?",
      replyTo: request.id,
      expiresInSeconds: 3600,
    });
    const independent = conversations.ask(foreman, {
      requestId: "independent",
      groupId: group.id,
      memberId: "sam",
      text: "Review?",
      expiresInSeconds: 3600,
    });
    expect(cleanup.visibleConversations(conversations.list()).map((item) => item.id)).toEqual([
      independent.id,
    ]);
    expect(conversations.get(followup.id).state).toBe("queued");
    expect(store.listAgentActions()).toEqual(beforeActions);
    expect(store.listForemanInbox().some((item) => item.conversationRequestId === request.id)).toBe(
      true,
    );
    cleanup.execute("human", {
      scope: "channel",
      requestId: "clear-independent",
      confirmation: true,
      throughSequence: source.sequence,
      conversationIds: [independent.id],
    });
    expect(cleanup.visibleConversations(conversations.list())).toEqual([]);
    expect(conversations.get(independent.id).state).toBe("queued");
  });
});

function teamFixture(
  recovery = false,
  approve = true,
  implicitCheckout = false,
  staleConversation = false,
  autonomous = false,
  nestedRequest = false,
) {
  const context = fixture();
  const { store, config, service, root } = context;
  const requestDirectory = join(root, "examples/multi-coding-agents");
  if (nestedRequest) {
    mkdirSync(requestDirectory, { recursive: true });
    config.repository.path = requestDirectory;
    config.integrations.copilot!.cwd = root;
  }
  if (autonomous) config.foreman!.autonomy.approvalMode = "autonomous";
  if (recovery) {
    config.foreman!.autonomy.mode = "bounded";
    config.foreman!.autonomy.recovery.restartDelegatedAgents = true;
    config.foreman!.autonomy.recovery.maxAttemptsPerIncident = 1;
  }
  const timestamp = new Date().toISOString();
  const epoch = store.beginDaemonEpoch({
    instanceId: "goals-test",
    processId: 10,
    processStartedAt: timestamp,
  });
  config.roles["delivery-owner"] = {
    name: "Delivery owner",
    description: "Owns SDK research, planning, team coordination and final delivery",
    instructions: [],
    permissionPolicy: "inherit",
  };
  config.roles.auditor = {
    name: "Independent auditor",
    description: "Checks specification conformance independently",
    instructions: [],
    permissionPolicy: "read-only",
  };
  store.reconcileTopology(config);
  const profile = store.createInternalAgentProfile({
    name: "Copilot",
    agentType: "copilot",
    kind: "copilot",
    command: "copilot",
    args: [],
    environment: {},
  });
  const foremanProfile = store.createInternalAgentProfile({
    name: "Foreman",
    agentType: "copilot",
    kind: "copilot",
    command: "copilot",
    args: [],
    environment: {},
    ...(nestedRequest ? { workingDirectory: requestDirectory } : {}),
  });
  store.upsertForeman({
    id: "repository-foreman",
    agentProfileId: foremanProfile.id,
    enabled: true,
  });
  const foremanRun = store.createRunForForeman("repository-foreman").run;
  const foreman = {
    kind: "foreman" as const,
    foremanId: foremanRun.foremanId,
    runId: foremanRun.id,
    generation: foremanRun.generation,
    authorityRevision: store.getForeman(foremanRun.foremanId).authorityRevision,
  };
  const group = store.createGroup({ name: "SDK team" });
  store.addMembership(group.id, {
    memberId: "alex",
    agentProfileId: profile.id,
    alias: "Alex",
    roleId: "delivery-owner",
  });
  store.addMembership(group.id, {
    memberId: "sam",
    agentProfileId: profile.id,
    alias: "Sam",
    roleId: "auditor",
  });
  store.saveDiscoveredCheckout(
    {
      id: "repo-one",
      commonDirectory: root,
      displayName: "SDK",
      objectFormat: "sha1",
      refStorage: "files",
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "checkout-one",
      repositoryId: "repo-one",
      checkoutKey: "c".repeat(64),
      path: root,
      gitDirectory: root,
      kind: "primary",
      head: "d".repeat(40),
      dirty: false,
      observedAt: timestamp,
    },
    true,
  );
  const source = nestedRequest
    ? store.sendForemanMessage(
        { kind: "operator", operatorId: "human" },
        {
          requestId: "nested-request",
          text: "Create a browser-based tool in ./src dir. Keep my exact path.",
        },
      )
    : undefined;
  const goal = service.propose(
    {
      ...context.command,
      ...(source === undefined ? {} : { sourceMessageId: source.id }),
    },
    nestedRequest ? foreman : undefined,
  );
  let checkoutId = "checkout-one";
  if (nestedRequest) {
    const linkedRoot = join(root, "linked");
    mkdirSync(join(linkedRoot, "examples/multi-coding-agents"), { recursive: true });
    store.saveDiscoveredCheckout(store.getRepository("repo-one"), {
      ...store.getCheckout("checkout-one"),
      id: "checkout-linked",
      checkoutKey: "e".repeat(64),
      kind: "linked",
      path: linkedRoot,
      gitDirectory: linkedRoot,
    });
    checkoutId = "checkout-linked";
  }
  if (!implicitCheckout) store.assignGroupCheckout(group.id, checkoutId, 0);
  if (!autonomous)
    service.control("human", { id: goal.id, expectedRevision: 0, action: "approve" });
  const team = service.discover()[0]!;
  const actionListing = staleConversation
    ? vi
        .spyOn(store, "listAgentActions")
        .mockReturnValue([
          { state: "stalled", principal: { kind: "foreman-conversation" } } as ReturnType<
            typeof store.listAgentActions
          >[number],
        ])
    : undefined;
  const delegation = service.delegate(foreman, {
    requestId: "handoff",
    goalId: goal.id,
    expectedRevision: 1,
    groupId: group.id,
    memberId: "alex",
    expectedMembershipRevision: team.membershipRevision,
    expectedCheckoutRevision: team.checkoutRevision,
    rationale: "Alex owns delivery and Sam can independently review",
    brief: "Own the complete SDK conformance outcome",
  });
  const decision = service.workspace(goal.id).decisions[0]!;
  if (approve && !autonomous)
    service.resolve("human", {
      id: decision.id,
      expectedRevision: 0,
      requestId: "approve-team",
      answer: "approve",
    });
  actionListing?.mockRestore();
  const start = (memberId: string, groupId = group.id, checkoutId = "checkout-one"): AgentRun => {
    const run = store.createRun({
      id: `run_${memberId}`,
      groupId,
      memberId,
      agentProfileId: profile.id,
      generation: 1,
      status: "running",
      checkoutId,
      terminal: {
        serverName: "test",
        sessionId: "$1",
        windowId: "@1",
        paneId: memberId === "alex" ? "%1" : "%2",
      } as never,
      startedAt: timestamp,
    });
    store.registerReporterSession({
      id: `reporter_${memberId}`,
      providerId: "copilot",
      adapterId: "copilot",
      reporterId: "copilot-native",
      source: "copilot",
      protocolVersion: 2,
      reporterVersion: "2",
      runId: run.id,
      generation: 1,
      reporterEpoch: `epoch_${memberId}`,
      readinessCoverage: "full",
      sourceSequence: 0,
      openedAt: timestamp,
      leaseExpiresAt: "2099-01-01T00:00:00Z",
    });
    store.bindReporterProcess(run.id, 1, "a".repeat(64));
    store.recordProcessStatus(run.id, {
      event: "process.alive",
      eventId: `alive_${memberId}`,
      observedAt: timestamp,
      process: {
        foregroundPgid: 10,
        leaderPid: 10,
        pidStartIdentity: "10:100",
        executableFingerprint: "b".repeat(64),
        argvFingerprint: "c".repeat(64),
        processFingerprint: "a".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["copilot"],
      },
    });
    store.ingestAgentStatusEvent(
      { groupId, memberId, runId: run.id, generation: 1 },
      {
        version: 2,
        eventId: `ready_${memberId}`,
        providerId: "copilot",
        adapterId: "copilot",
        reporterId: "copilot-native",
        source: "copilot",
        protocolVersion: 2,
        reporterVersion: "2",
        runId: run.id,
        generation: 1,
        reporterEpoch: `epoch_${memberId}`,
        sourceSequence: 1,
        event: "session.ready",
        data: {},
      },
    );
    return run;
  };
  const lead = start("alex", group.id, checkoutId);
  const reviewer = start("sam", group.id, checkoutId);
  const principal = (run: AgentRun) => ({
    kind: "agent" as const,
    groupId: run.groupId,
    memberId: run.memberId,
    runId: run.id,
    generation: run.generation,
  });
  const actions = new AgentActionService(
    store,
    epoch,
    new PeerCapabilityPolicy(
      (actor, command) => service.authorizeHandoff(actor, command),
      (actor, command) => service.authorizePeer(actor, command),
    ),
    () => new Date(),
    (action) => service.linkAction(action),
  );
  return {
    ...context,
    foreman,
    goal,
    delegation,
    group,
    lead: principal(lead),
    reviewer: principal(reviewer),
    actions,
    start,
    principal,
    profile,
  };
}

describe("browser candidate scope", () => {
  it("requires current active team authority and hashes the exact dirty candidate without reports", async () => {
    const { service, store, root, delegation, lead, reviewer, actions } = teamFixture();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/index.html"), "<h1>Candidate</h1>");
    expect(() => service.browserCandidate(reviewer, delegation.id, "src")).toThrow(/accepted/);
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected run start");
      },
    });
    service.report(lead, {
      delegationId: delegation.id,
      requestId: "browser-accept",
      kind: "accepted",
      summary: "Accepted",
      evidence: [],
      nextCheckSeconds: 60,
    });
    const before = service.workspace(delegation.goalId);
    const candidate = service.browserCandidate(reviewer, delegation.id, "src");
    expect(candidate).toMatchObject({ candidatePath: "src", root: join(root, "src") });
    expect(candidate.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(service.workspace(delegation.goalId)).toEqual(before);
    for (const kind of ["progress", "blocked"] as const) {
      service.report(lead, {
        delegationId: delegation.id,
        requestId: `browser-${kind}`,
        kind,
        summary: kind,
        evidence: [],
        nextCheckSeconds: 60,
      });
      expect(service.browserCandidate(reviewer, delegation.id, "src").candidateDigest).toBe(
        candidate.candidateDigest,
      );
    }
    const review = service.report(reviewer, {
      delegationId: delegation.id,
      requestId: "browser-review",
      kind: "review",
      reviewOutcome: "approved",
      summary: "Independent fixture review",
      evidence: ["Isolated test evidence"],
      candidatePath: "src",
      nextCheckSeconds: 60,
    });
    expect(review.candidateDigest).toBe(candidate.candidateDigest);
    for (const principal of [
      { ...reviewer, groupId: "another-team" },
      { ...reviewer, generation: reviewer.generation + 1 },
    ])
      expect(() => service.browserCandidate(principal, delegation.id, "src")).toThrow(
        /current member/,
      );
    expect(() => service.browserCandidate(reviewer, delegation.id, "../src")).toThrow(/relative/);
    symlinkSync(join(root, "src"), join(root, "alias"));
    expect(() => service.browserCandidate(reviewer, delegation.id, "alias")).toThrow(/symlinks/);
    writeFileSync(join(root, "src/index.html"), "<h1>Changed</h1>");
    expect(service.browserCandidate(reviewer, delegation.id, "src").candidateDigest).not.toBe(
      candidate.candidateDigest,
    );
    store.database
      .prepare("UPDATE groups SET checkout_revision = checkout_revision + 1 WHERE id = ?")
      .run(lead.groupId);
    expect(() => service.browserCandidate(reviewer, delegation.id, "src")).toThrow(
      /checkout changed/,
    );
  });
  it("keeps nested candidates checkout-root relative and respects Human pause", async () => {
    const { service, root, delegation, lead, reviewer, actions, goal } = teamFixture(
      false,
      true,
      false,
      false,
      false,
      true,
    );
    const candidatePath = "examples/multi-coding-agents/src";
    mkdirSync(join(root, "linked", candidatePath), { recursive: true });
    writeFileSync(join(root, "linked", candidatePath, "index.html"), "<h1>Nested candidate</h1>");
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected run start");
      },
    });
    service.report(lead, {
      delegationId: delegation.id,
      requestId: "browser-accept",
      kind: "accepted",
      summary: "Accepted",
      evidence: [],
      nextCheckSeconds: 60,
    });
    expect(() => service.browserCandidate(reviewer, delegation.id, "src")).toThrowError(
      expect.objectContaining({ code: "foreman_candidate_unavailable" }),
    );
    expect(service.browserCandidate(reviewer, delegation.id, candidatePath).root).toBe(
      join(root, "linked", candidatePath),
    );
    service.control("human", {
      id: goal.id,
      expectedRevision: service.get(goal.id).revision,
      action: "pause",
    });
    expect(() => service.browserCandidate(reviewer, delegation.id, candidatePath)).toThrow(
      /not running/,
    );
  });
});

function multiTeamFixture(separateGoals = false) {
  const context = teamFixture();
  const { store, service, config, root, foreman, profile, start, principal } = context;
  config.foreman!.autonomy.maxActiveGoals = 2;
  const checkoutPath = join(root, "frontend");
  mkdirSync(checkoutPath);
  const originalCheckout = store.getCheckout("checkout-one");
  store.saveDiscoveredCheckout(store.getRepository(originalCheckout.repositoryId), {
    ...originalCheckout,
    id: "checkout-two",
    checkoutKey: "e".repeat(64),
    kind: "linked",
    path: checkoutPath,
    gitDirectory: checkoutPath,
    head: "f".repeat(40),
  });
  const group = store.createGroup({ name: "Frontend team" });
  for (const [memberId, roleId] of [
    ["pat", "delivery-owner"],
    ["lee", "auditor"],
  ] as const) {
    store.addMembership(group.id, {
      memberId,
      agentProfileId: profile.id,
      alias: memberId,
      roleId,
    });
  }
  store.assignGroupCheckout(group.id, "checkout-two", 0);
  const goal = separateGoals
    ? service.propose({ ...context.command, requestId: "goal-two", title: "Frontend outcome" })
    : service.get(context.goal.id);
  if (separateGoals)
    service.control("human", { id: goal.id, expectedRevision: goal.revision, action: "approve" });
  const team = service.discover().find((item) => item.id === group.id)!;
  const delegation = service.delegate(foreman, {
    requestId: "frontend-handoff",
    goalId: goal.id,
    expectedRevision: service.get(goal.id).revision,
    groupId: group.id,
    memberId: "pat",
    expectedMembershipRevision: team.membershipRevision,
    expectedCheckoutRevision: team.checkoutRevision,
    rationale: "Pat owns frontend delivery and Lee independently reviews it",
    brief: "Own the frontend part of the outcome, including research, implementation and review",
  });
  const decision = service
    .workspace(goal.id)
    .decisions.find((item) => item.delegationId === delegation.id)!;
  service.resolve("human", {
    id: decision.id,
    expectedRevision: decision.revision,
    requestId: "approve-frontend",
    answer: "approve",
  });
  return {
    ...context,
    second: {
      goal,
      group,
      delegation,
      lead: principal(start("pat", group.id, "checkout-two")),
      reviewer: principal(start("lee", group.id, "checkout-two")),
    },
  };
}

describe("Foreman outcome delegation", () => {
  it("loads legacy review history without allowing it to approve readiness or acceptance", async () => {
    const { service, store, actions, goal, delegation, lead, reviewer } = teamFixture();
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected run start");
      },
    });
    for (const action of store.listAgentActions())
      store.transitionAgentAction(action.id, [action.state], "completed");
    const evidence = {
      delegationId: delegation.id,
      summary: "Candidate inspected",
      evidence: ["tests/results.md"],
      candidateHead: store.getCheckout(delegation.checkoutId).head!,
      nextCheckSeconds: 900,
    };
    const review = service.report(reviewer, {
      ...evidence,
      requestId: "legacy-review",
      kind: "review",
      reviewOutcome: "approved",
    });
    const replaceVerdict = (reviewOutcome?: "approved" | "changes-required") =>
      store.database
        .prepare("UPDATE foreman_coordination_records SET data_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...review, reviewOutcome }), review.id);
    replaceVerdict();
    expect(
      ForemanGoalWorkspaceSchema.parse(service.workspace(goal.id)).reports[0]?.reviewOutcome,
    ).toBeUndefined();
    const ready = { ...evidence, requestId: "ready", kind: "ready" as const };
    expect(() => service.report(lead, ready)).toThrow("latest review");
    replaceVerdict("approved");
    service.report(lead, ready);
    for (const outcome of [undefined, "changes-required"] as const) {
      replaceVerdict(outcome);
      expect(() =>
        service.control("human", {
          id: goal.id,
          expectedRevision: service.get(goal.id).revision,
          action: "accept",
        }),
      ).toThrow("latest review");
      expect(service.get(goal.id).state).toBe("awaiting-acceptance");
      expect(service.delegation(delegation.id).state).toBe("ready");
    }
  });

  it.each(["commit", "working-tree"])(
    "requires the latest explicit approval and coalesces durable review wakeups for %s",
    async (candidateKind) => {
      const { service, store, actions, goal, delegation, lead, reviewer, root, foreman } =
        teamFixture(false, true);
      await service.tick(actions, {
        startRun: async () => {
          throw new Error("Unexpected run start");
        },
      });
      for (const action of store.listAgentActions())
        store.transitionAgentAction(action.id, [action.state], "completed");
      service.finishReview(foreman, goal.id);
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/index.html"), "<button></button>");
      const candidate =
        candidateKind === "commit"
          ? { candidateHead: store.getCheckout(delegation.checkoutId).head! }
          : { candidatePath: "src" };
      const command = {
        requestId: "negative-review",
        delegationId: delegation.id,
        kind: "review" as const,
        summary: "P1/P2 findings need remediation",
        evidence: ["Unnamed control in the reviewed candidate"],
        nextCheckSeconds: 900,
        ...candidate,
      };
      const before = service.workspace(goal.id);
      let failure: unknown;
      try {
        service.report(reviewer, command);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "foreman_report_invalid",
        details: {
          effect: "none",
          retry: "correct-input",
          issues: [{ path: ["reviewOutcome"], code: "custom" }],
          nextAction: expect.stringContaining("same requestId"),
        },
      });
      expect(service.workspace(goal.id)).toEqual(before);
      const negative = { ...command, reviewOutcome: "changes-required" as const };
      const teamActions = store.listAgentActions();
      const report = service.report(reviewer, negative);
      expect(report).toMatchObject({ ...negative, memberId: reviewer.memberId });
      expect(store.listAgentActions()).toEqual(teamActions);
      expect(() =>
        service.checkIn(
          foreman,
          {
            delegationId: delegation.id,
            requestId: "review-check-in",
            expectedRunId: lead.runId,
            expectedGeneration: lead.generation,
            expectedStatusRevision: store.getAgentStatus(lead.groupId, lead.memberId)
              .statusRevision,
            text: "Read the durable review and coordinate remediation",
          },
          actions,
        ),
      ).toThrow();
      expect(store.listAgentActions()).toEqual(teamActions);
      if (candidateKind === "working-tree")
        expect(report.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
      const inbox = store.listForemanInbox();
      expect(inbox.filter((item) => item.state === "queued")).toHaveLength(1);
      const wake = store.database
        .prepare("SELECT prompt FROM foreman_inbox WHERE state = 'queued'")
        .get() as { prompt: string };
      expect(wake.prompt).toContain("reviewOutcome");
      expect(wake.prompt).toContain("accountable member");
      const ready = { ...command, kind: "ready" as const, requestId: "ready" };
      expect(() => service.report(lead, ready)).toThrow("latest review");
      service.report(reviewer, {
        ...command,
        requestId: "approval",
        reviewOutcome: "approved",
      });
      service.report(reviewer, { ...negative, requestId: "later-negative" });
      expect(() => service.report(lead, ready)).toThrow("latest review");
      let otherCandidate: { candidateHead: string } | { candidatePath: string };
      if (candidateKind === "commit") {
        otherCandidate = { candidateHead: "e".repeat(40) };
        store.database
          .prepare("UPDATE checkouts SET head = ? WHERE id = ?")
          .run(otherCandidate.candidateHead, delegation.checkoutId);
      } else {
        mkdirSync(join(root, "other"));
        writeFileSync(join(root, "other/index.html"), "<button>Save</button>");
        otherCandidate = { candidatePath: "other" };
      }
      service.report(reviewer, {
        ...command,
        ...otherCandidate,
        requestId: "different-candidate-approval",
        reviewOutcome: "approved",
      });
      if (candidateKind === "commit")
        store.database
          .prepare("UPDATE checkouts SET head = ? WHERE id = ?")
          .run(candidate.candidateHead!, delegation.checkoutId);
      expect(() => service.report(lead, ready)).toThrow("latest review");
      expect(store.listForemanInbox()).toEqual(inbox);
      expect(service.get(goal.id).turnsUsed).toBe(before.goal.turnsUsed + 1);
      service.finishReview(foreman, goal.id);
      const settledInbox = store.listForemanInbox();
      const notifications = service.notifications({ after: 0, limit: 100 });
      expect(service.report(reviewer, negative)).toEqual(report);
      expect(store.listForemanInbox()).toEqual(settledInbox);
      expect(service.notifications({ after: 0, limit: 100 })).toEqual(notifications);
      service.report(reviewer, {
        ...command,
        requestId: "final-approval",
        reviewOutcome: "approved",
      });
      expect(service.workspace(goal.id).reports).toHaveLength(5);
      service.report(lead, ready);
      expect(service.get(goal.id).state).toBe("awaiting-acceptance");
      service.control("human", {
        id: goal.id,
        expectedRevision: service.get(goal.id).revision,
        action: "pause",
      });
      for (const item of store.listForemanInbox().filter((item) => item.state === "queued"))
        expect(() => service.authorizeInbox(item.id)).toThrow("not running");
    },
  );

  it("defaults to human approvals and snapshots an explicit autonomous approval grant", () => {
    const { service, config, command, store } = fixture();
    expect(config.foreman!.autonomy.approvalMode).toBe("human");
    const humanGoal = service.propose(command);
    expect(humanGoal.state).toBe("proposed");
    config.foreman!.autonomy.maxActiveGoals = 2;
    config.foreman!.autonomy.approvalMode = "autonomous";
    const automatic = service.propose({ ...command, requestId: "automatic-goal" });
    expect(automatic).toMatchObject({
      state: "running",
      revision: 1,
      grant: { approvalMode: "autonomous" },
    });
    expect(service.propose({ ...command, requestId: "automatic-goal" })).toEqual(automatic);
    expect(service.get(humanGoal.id).grant.approvalMode).toBe("human");
    expect(
      store.database
        .prepare("SELECT action FROM audits WHERE action = 'foreman.auto-approve-goal'")
        .all(),
    ).toHaveLength(1);
    config.foreman!.autonomy.approvalMode = "human";
    expect(() =>
      service.control("human", { id: automatic.id, expectedRevision: 1, action: "pause" }),
    ).not.toThrow();
    expect(() =>
      service.control("human", { id: automatic.id, expectedRevision: 2, action: "resume" }),
    ).toThrow("exceeds repository policy");
  });

  it("clears only finished goals and requires stopped runtimes for a full reset", async () => {
    const context = teamFixture();
    const { service, store, foreman } = context;
    await service.tick(context.actions, {
      startRun: async () => {
        throw new Error("Unexpected run start");
      },
    });
    service.report(context.lead, {
      requestId: "reset-report",
      delegationId: context.delegation.id,
      kind: "accepted",
      summary: "Accepted ownership",
      evidence: [],
      nextCheckSeconds: 900,
    });
    const handoff = store.getAgentAction(service.delegation(context.delegation.id).actionId!);
    store.transitionAgentAction(handoff.id, [handoff.state], "stalled", {
      result: { effectsUnknown: true },
    });
    expect(() => service.resetState("human", { scope: "all", confirmation: "RESET" })).toThrow(
      "Stop Foreman",
    );
    store.updateRuntimeRunStatus(foreman.runId, "failed");
    expect(() => service.resetState("human", { scope: "all", confirmation: "no" })).toThrow();
    expect(
      service.resetState("human", { scope: "finished-goals", confirmation: "RESET" }).goalsRemoved,
    ).toBe(0);
    expect(() => service.resetState("human", { scope: "channel", confirmation: "RESET" })).toThrow(
      "Goals still reference",
    );
    expect(() => service.resetState("human", { scope: "all", confirmation: "RESET" })).toThrow(
      "Stop delegated team runs",
    );
    const runs = store.getSnapshot().runs;
    for (const run of runs)
      if (["starting", "running", "stopping"].includes(run.status))
        store.updateRuntimeRunStatus(run.id, "failed");
    const message = store.sendForemanMessage(
      { kind: "operator", operatorId: "human" },
      { requestId: "reset-message", text: "Old channel context" },
    );
    const result = service.resetState("human", { scope: "all", confirmation: "RESET" });
    expect(result).toMatchObject({ goalsRemoved: 1, messagesRemoved: 1 });
    expect(service.list()).toEqual([]);
    expect(store.getAgentAction(handoff.id)).toMatchObject({
      state: "superseded",
      result: { effectsUnknown: true },
      error: { code: "foreman_state_reset" },
    });
    expect(store.readForemanChannel({ after: 0, limit: 100 }).messages).toEqual([]);
    expect(store.listForemanInbox()).toEqual([]);
    expect(store.getSnapshot().groups.length).toBeGreaterThan(0);
    expect(store.getForeman(foreman.foremanId)).toBeDefined();
    expect(
      store.database.prepare("SELECT id FROM audits WHERE action = 'foreman.reset-state'").all(),
    ).toHaveLength(2);
    expect(
      service.resetState("human", { scope: "channel", confirmation: "RESET" }).messagesRemoved,
    ).toBe(0);
    expect(
      store.database
        .prepare("SELECT id FROM foreman_coordination_records WHERE kind = 'report'")
        .all(),
    ).toHaveLength(0);
    const nextGoal = service.propose({ ...context.command, requestId: "after-reset" });
    expect(service.workspace(nextGoal.id).reports).toEqual([]);
    expect(message.id).toBeDefined();
  });

  it("removes finished goal history without deleting an active goal or its channel", () => {
    const { service, command, store } = fixture();
    const finished = service.propose(command);
    service.control("human", { id: finished.id, expectedRevision: 0, action: "cancel" });
    const active = service.propose({ ...command, requestId: "remaining-goal" });
    const message = store.sendForemanMessage(
      { kind: "operator", operatorId: "human" },
      { requestId: "keep-message", text: "Keep this context" },
    );
    expect(
      service.resetState("human", { scope: "finished-goals", confirmation: "RESET" }),
    ).toMatchObject({ goalsRemoved: 1, messagesRemoved: 0 });
    expect(service.list().map((goal) => goal.id)).toEqual([active.id]);
    expect(store.readForemanChannel({ after: 0, limit: 100 }).messages[0]?.id).toBe(message.id);
  });

  it("never lets autonomous acceptance bypass a human pause or missing evidence", () => {
    const { service, goal, foreman } = teamFixture(false, true, false, false, true);
    expect(() =>
      service.acceptAutonomously(foreman, goal.id, service.get(goal.id).revision),
    ).toThrow("not valid in this state");
    const paused = service.control("human", {
      id: goal.id,
      expectedRevision: service.get(goal.id).revision,
      action: "pause",
    });
    expect(() => service.acceptAutonomously(foreman, goal.id, paused.revision)).toThrow(
      "not valid in this state",
    );
    expect(service.get(goal.id).state).toBe("paused");
  });

  it("rejects a missing working-tree candidate with a no-effect domain error", async () => {
    const { service, store, actions, goal, delegation, reviewer, root } = teamFixture(
      false,
      true,
      false,
      false,
      false,
      true,
    );
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected run start");
      },
    });
    const candidatePath = "examples/multi-coding-agents/src";
    const expectedCandidateAbsolutePath = join(root, "linked", candidatePath);
    mkdirSync(expectedCandidateAbsolutePath);
    writeFileSync(join(expectedCandidateAbsolutePath, "index.html"), "<button></button>");
    const before = service.workspace(goal.id);
    const records = store.database.prepare("SELECT * FROM foreman_coordination_records").all();
    const report = {
      requestId: "missing-candidate",
      delegationId: delegation.id,
      kind: "review" as const,
      reviewOutcome: "changes-required" as const,
      summary: "P1 findings in the static app; not ready",
      evidence: ["src/index.html: missing accessible controls"],
      candidatePath: "src",
      nextCheckSeconds: 900,
    };
    let failure: unknown;
    try {
      service.report(reviewer, report);
    } catch (error) {
      failure = error;
    }
    expect(service.workspace(goal.id)).toEqual(before);
    expect(store.database.prepare("SELECT * FROM foreman_coordination_records").all()).toEqual(
      records,
    );
    expect(failure).toMatchObject({
      code: "foreman_candidate_unavailable",
      statusCode: 409,
      details: {
        candidatePath: "src",
        expectedCandidatePath: candidatePath,
        expectedCandidateAbsolutePath,
        fileSystemCode: "ENOENT",
        effect: "none",
        retry: "correct-input",
      },
    });
    const corrected = service.report(reviewer, { ...report, candidatePath });
    expect(corrected).toMatchObject({ kind: "review", candidatePath, summary: report.summary });
    expect(corrected.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(service.report(reviewer, { ...report, candidatePath })).toEqual(corrected);
    expect(service.delegation(delegation.id).state).toBe(before.delegations[0]!.state);
    expect(service.get(goal.id).state).toBe("running");
  });

  it.each([
    ["src/index.html/child", "ENOTDIR"],
    ["loop", "ELOOP"],
    ["src/\0", undefined],
  ])(
    "rejects invalid filesystem candidates without report effects: %s",
    async (candidatePath, fileSystemCode) => {
      const { service, store, actions, delegation, reviewer, root } = teamFixture(false, true);
      await service.tick(actions, {
        startRun: async () => {
          throw new Error("Unexpected run start");
        },
      });
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/index.html"), "<button></button>");
      symlinkSync("loop", join(root, "loop"));
      const before = store.database.prepare("SELECT * FROM foreman_coordination_records").all();
      let failure: unknown;
      try {
        service.report(reviewer, {
          requestId: "invalid-filesystem-candidate",
          delegationId: delegation.id,
          kind: "review",
          reviewOutcome: "changes-required",
          summary: "Negative findings",
          evidence: ["Candidate has defects"],
          candidatePath: candidatePath!,
          nextCheckSeconds: 900,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).details.effect).toBe("none");
      expect((failure as DomainError).details.fileSystemCode).toBe(fileSystemCode);
      expect(store.database.prepare("SELECT * FROM foreman_coordination_records").all()).toEqual(
        before,
      );
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "reports unreadable candidate files without leaking OS diagnostics",
    async () => {
      const { service, store, actions, delegation, reviewer, root } = teamFixture(false, true);
      await service.tick(actions, {
        startRun: async () => {
          throw new Error("Unexpected run start");
        },
      });
      mkdirSync(join(root, "src"));
      const file = join(root, "src/index.html");
      writeFileSync(file, "<button></button>");
      const before = store.database.prepare("SELECT * FROM foreman_coordination_records").all();
      let failure: unknown;
      chmodSync(file, 0);
      try {
        service.report(reviewer, {
          requestId: "unreadable-candidate",
          delegationId: delegation.id,
          kind: "review",
          reviewOutcome: "changes-required",
          summary: "Negative findings",
          evidence: ["Candidate has defects"],
          candidatePath: "src",
          nextCheckSeconds: 900,
        });
      } catch (error) {
        failure = error;
      } finally {
        chmodSync(file, 0o644);
      }
      expect(failure).toMatchObject({
        code: "foreman_candidate_unavailable",
        details: { effect: "none", fileSystemCode: "EACCES", retry: "inspect-first" },
      });
      expect(JSON.stringify(failure)).not.toContain(root);
      expect(store.database.prepare("SELECT * FROM foreman_coordination_records").all()).toEqual(
        before,
      );
    },
  );

  it.each(["missing", "symlink", "metadata", "other-repository", "unknown-origin"])(
    "does not suggest an unvalidated origin candidate: %s",
    async (scenario) => {
      const { service, store, actions, goal, delegation, reviewer, root } = teamFixture(
        false,
        true,
        false,
        false,
        false,
        true,
      );
      await service.tick(actions, {
        startRun: async () => {
          throw new Error("Unexpected run start");
        },
      });
      const candidate = join(root, "linked/examples/multi-coding-agents/src");
      if (scenario !== "missing") {
        mkdirSync(candidate);
        writeFileSync(join(candidate, "index.html"), "<button></button>");
      }
      if (scenario === "symlink")
        symlinkSync(join(candidate, "index.html"), join(candidate, "link.html"));
      if (scenario === "metadata") mkdirSync(join(candidate, ".git"));
      if (scenario === "other-repository" || scenario === "unknown-origin") {
        const stored = service.get(goal.id);
        if (scenario === "unknown-origin") delete stored.requestOrigin;
        else stored.requestOrigin!.repositoryId = "other-repository";
        store.database
          .prepare("UPDATE foreman_coordination_records SET data_json = ? WHERE id = ?")
          .run(JSON.stringify(stored), goal.id);
      }
      const records = store.database.prepare("SELECT * FROM foreman_coordination_records").all();
      let failure: unknown;
      try {
        service.report(reviewer, {
          requestId: "unvalidated-candidate",
          delegationId: delegation.id,
          kind: "review",
          reviewOutcome: "changes-required",
          summary: "Negative findings",
          evidence: ["Reviewed the requested src"],
          candidatePath: "src",
          nextCheckSeconds: 900,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).details).toMatchObject({
        effect: "none",
        fileSystemCode: "ENOENT",
        nextAction: expect.stringContaining("No alternative candidate was validated"),
      });
      expect((failure as DomainError).details).not.toHaveProperty("expectedCandidatePath");
      expect(store.database.prepare("SELECT * FROM foreman_coordination_records").all()).toEqual(
        records,
      );
    },
  );

  it("rolls back rejected reports and preserves report identity and independent review checks", async () => {
    const { service, store, actions, delegation, reviewer, lead, root } = teamFixture(false, true);
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected run start");
      },
    });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/index.html"), "<button></button>");
    const command = {
      requestId: "atomic-review",
      delegationId: delegation.id,
      kind: "review" as const,
      reviewOutcome: "changes-required" as const,
      summary: "P1 findings; not ready",
      evidence: ["src/index.html: unnamed control"],
      candidatePath: "src",
      nextCheckSeconds: 900,
    };
    const records = store.database.prepare("SELECT * FROM foreman_coordination_records").all();
    const rejected = (operation: () => unknown) => {
      let failure: unknown;
      try {
        operation();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).details.effect).toBe("none");
      expect(store.database.prepare("SELECT * FROM foreman_coordination_records").all()).toEqual(
        records,
      );
      return failure as DomainError;
    };
    expect(rejected(() => service.report(reviewer, { ...command, nextCheckSeconds: 0 })).code).toBe(
      "foreman_report_invalid",
    );
    expect(
      rejected(() => service.report(reviewer, { ...command, candidateHead: "d".repeat(40) }))
        .message,
    ).toContain("not both");
    expect(rejected(() => service.report(lead, command)).message).toContain(
      "cannot supply independent review",
    );
    expect(
      rejected(() => service.report(reviewer, { ...command, kind: "ready" })).message,
    ).toContain("Only the accountable member");
    expect(rejected(() => service.report(reviewer, { ...command, evidence: [] })).code).toBe(
      "foreman_goal_conflict",
    );
    const notifications = store.database.prepare("SELECT * FROM foreman_notifications").all();
    const notify = vi.spyOn(service, "notify").mockImplementationOnce(() => {
      throw new DomainError("notification_rejected", "Rejected after report write", 409);
    });
    try {
      expect(rejected(() => service.report(reviewer, command)).code).toBe("notification_rejected");
      expect(store.database.prepare("SELECT * FROM foreman_notifications").all()).toEqual(
        notifications,
      );
    } finally {
      notify.mockRestore();
    }
    const report = service.report(reviewer, command);
    const after = store.database.prepare("SELECT * FROM foreman_coordination_records").all();
    expect(service.report(reviewer, command)).toEqual(report);
    expect(() => service.report(reviewer, { ...command, summary: "Changed content" })).toThrow(
      "Request ID was reused",
    );
    expect(store.database.prepare("SELECT * FROM foreman_coordination_records").all()).toEqual(
      after,
    );
  });

  it.each([false, true])(
    "pins no-commit review and acceptance with autonomous=%s",
    async (autonomous) => {
      const { service, store, actions, goal, delegation, lead, reviewer, root, foreman, config } =
        teamFixture(false, true, false, false, autonomous);
      const decision = service.workspace(goal.id).decisions[0]!;
      expect(decision.state).toBe("resolved");
      expect(decision.decidedBy).toBe(autonomous ? `foreman-policy:${foreman.foremanId}` : "human");
      await service.tick(actions, {
        startRun: async () => {
          throw new Error("Unexpected run start");
        },
      });
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "game.js"), "export const game = 1;\n");
      const report = {
        requestId: "review-working-tree",
        delegationId: delegation.id,
        kind: "review" as const,
        reviewOutcome: "approved" as const,
        summary: "Reviewed game content",
        evidence: ["src/game.js"],
        candidatePath: "src",
        nextCheckSeconds: 900,
      };
      expect(() => service.report(reviewer, { ...report, candidatePath: "../outside" })).toThrow(
        "repository-relative",
      );
      symlinkSync(join(root, "src", "game.js"), join(root, "src", "linked.js"));
      expect(() => service.report(reviewer, report)).toThrow("symlinks");
      rmSync(join(root, "src", "linked.js"));
      const review = service.report(reviewer, report);
      expect(review.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
      writeFileSync(join(root, "src", "game.js"), "export const game = 2;\n");
      expect(() => service.report(lead, { ...report, requestId: "ready", kind: "ready" })).toThrow(
        "Independent review",
      );
      service.report(reviewer, { ...report, requestId: "review-new-content" });
      for (const action of store.listAgentActions())
        if (!["completed", "cancelled"].includes(action.state))
          store.transitionAgentAction(action.id, [action.state], "completed");
      service.report(lead, { ...report, requestId: "ready", kind: "ready" });
      writeFileSync(join(root, "src", "game.js"), "export const game = 3;\n");
      expect(() =>
        service.control("human", {
          id: goal.id,
          expectedRevision: service.get(goal.id).revision,
          action: "accept",
        }),
      ).toThrow("Completion evidence");
      writeFileSync(join(root, "src", "game.js"), "export const game = 2;\n");
      if (autonomous) {
        expect(() => service.acceptAutonomously(foreman, goal.id, 0)).toThrow(
          "Goal revision changed",
        );
        config.foreman!.autonomy.approvalMode = "human";
        expect(() =>
          service.acceptAutonomously(foreman, goal.id, service.get(goal.id).revision),
        ).toThrow("must be authorized");
        config.foreman!.autonomy.approvalMode = "autonomous";
        expect(
          service.acceptAutonomously(foreman, goal.id, service.get(goal.id).revision).state,
        ).toBe("completed");
      } else {
        expect(() =>
          service.acceptAutonomously(foreman, goal.id, service.get(goal.id).revision),
        ).toThrow("must be authorized");
        expect(
          service.control("human", {
            id: goal.id,
            expectedRevision: service.get(goal.id).revision,
            action: "accept",
          }).state,
        ).toBe("completed");
      }
    },
  );

  it.each([
    "retired",
    "replaced",
    "live",
    "running-goal",
    "cancelled-goal",
    "peer",
    "other-handoff",
    "no-goal",
    "no-delegation",
  ])(
    "checks %s historical handoff availability without certifying its effects",
    async (scenario) => {
      const {
        service,
        store,
        actions,
        goal,
        delegation,
        lead,
        reviewer,
        foreman,
        config,
        command,
      } = teamFixture(false, true, false, false, true);
      await service.tick(actions, {
        startRun: async () => {
          throw new Error("Unexpected run start");
        },
      });
      const handoff = store.getAgentAction(service.delegation(delegation.id).actionId!);
      store.transitionAgentAction(handoff.id, [handoff.state], "stalled", {
        result: { effectsUnknown: true },
      });
      const report = {
        delegationId: delegation.id,
        summary: "Independently verified outcome",
        evidence: ["Reviewed candidate"],
        candidateHead: store.getCheckout(delegation.checkoutId).head!,
        nextCheckSeconds: 900,
      };
      service.report(reviewer, {
        ...report,
        requestId: "review",
        kind: "review",
        reviewOutcome: "approved",
      });
      service.report(lead, { ...report, requestId: "ready", kind: "ready" });
      expect(
        service.acceptAutonomously(foreman, goal.id, service.get(goal.id).revision).state,
      ).toBe("completed");
      expect(service.delegation(delegation.id).state).toBe("completed");
      expect(
        store.database
          .prepare("SELECT id FROM audits WHERE action = 'foreman.auto-accept-goal'")
          .all(),
      ).toHaveLength(1);
      expect(service.blockingTeamActions(lead.groupId).map((action) => action.id)).toEqual([
        handoff.id,
      ]);
      const liveTarget = store.getRun(lead.runId);
      store.updateRuntimeRunStatus(lead.runId, "failed");
      const retained = store.getAgentAction(handoff.id);
      expect(service.assessTeam(lead.groupId).eligible).toBe(true);
      expect(service.blockingTeamActions(lead.groupId)).toEqual([]);
      expect(store.getAgentAction(handoff.id)).toEqual(retained);
      expect(retained).toMatchObject({ state: "stalled", result: { effectsUnknown: true } });

      config.foreman!.autonomy.approvalMode = "human";
      const nextGoal = service.propose({ ...command, requestId: "next-goal" });
      service.control("human", { id: nextGoal.id, expectedRevision: 0, action: "approve" });
      const nextDelegation = service.delegate(foreman, {
        requestId: "next-delegation",
        goalId: nextGoal.id,
        expectedRevision: 1,
        groupId: delegation.groupId,
        memberId: delegation.memberId,
        expectedMembershipRevision: delegation.expectedMembershipRevision,
        expectedCheckoutRevision: delegation.expectedCheckoutRevision,
        rationale: delegation.rationale,
        brief: delegation.brief,
      });
      const decision = service.workspace(nextGoal.id).decisions[0]!;
      if (scenario === "live") {
        const activeRun = store.getActiveRun.bind(store);
        vi.spyOn(store, "getActiveRun").mockImplementation((groupId, memberId) =>
          groupId === lead.groupId && memberId === lead.memberId
            ? liveTarget
            : activeRun(groupId, memberId),
        );
      }
      if (scenario === "replaced") {
        const replacement = store.createRun({
          ...store.getRun(lead.runId),
          id: "run_alex_replacement",
          generation: 18,
          status: "running",
        });
        const originalStatus = store.getAgentStatus.bind(store);
        vi.spyOn(store, "getAgentStatus").mockImplementation((groupId, memberId) => ({
          ...originalStatus(groupId, memberId),
          state: "idle",
          interactiveReady: true,
          staleAuthority: false,
        }));
        expect(store.getActiveRun(lead.groupId, lead.memberId)?.id).toBe(replacement.id);
      }
      if (scenario === "running-goal" || scenario === "cancelled-goal")
        store.database
          .prepare("UPDATE foreman_coordination_records SET data_json = ? WHERE id = ?")
          .run(
            JSON.stringify({
              ...service.get(goal.id),
              state: scenario === "running-goal" ? "running" : "cancelled",
            }),
            goal.id,
          );
      if (scenario === "peer" || scenario === "other-handoff")
        store.createAgentAction({
          ...retained,
          id: "action_unrelated",
          idempotencyKey: "unrelated",
          principal: scenario === "peer" ? reviewer : retained.principal,
        });
      if (scenario === "no-goal")
        store.database
          .prepare("UPDATE actions SET principal_json = ? WHERE id = ?")
          .run(JSON.stringify({ ...retained.principal, goalId: "goal_missing" }), handoff.id);
      if (scenario === "no-delegation")
        store.database
          .prepare("UPDATE foreman_coordination_records SET data_json = ? WHERE id = ?")
          .run(
            JSON.stringify({ ...service.delegation(delegation.id), actionId: undefined }),
            delegation.id,
          );
      const blocked = scenario !== "retired" && scenario !== "replaced";
      const actionsBefore = store.listAgentActions(lead.groupId);
      const auditsBefore = store.database.prepare("SELECT * FROM audits ORDER BY id").all();
      expect(
        service.assessTeam(lead.groupId).blockers.some((item) => item.code === "unsettled_work"),
      ).toBe(blocked);
      expect(service.unsettled(nextDelegation)).toHaveLength(blocked ? 1 : 0);
      const approve = () =>
        service.resolve("human", {
          id: decision.id,
          expectedRevision: decision.revision,
          requestId: "approve-next-team",
          answer: "approve",
        });
      if (blocked) expect(approve).toThrow("availability changed");
      else expect(approve().state).toBe("resolved");
      expect(store.listAgentActions(lead.groupId)).toEqual(actionsBefore);
      expect(store.database.prepare("SELECT * FROM audits ORDER BY id").all()).toEqual(
        auditsBefore,
      );
    },
  );

  it("does not reserve a team for historical ad hoc conversation actions", () => {
    const context = teamFixture(false, true, true, true);
    expect(context.service.delegations()).toHaveLength(1);
    expect(context.service.delegations()[0]?.state).toBe("queued");
  });

  it("delegates the effective primary checkout without requiring a redundant assignment", () => {
    const context = teamFixture(false, false, true);
    expect(context.store.getGroup(context.group.id).checkoutId).toBeUndefined();
    expect(context.delegation).toMatchObject({
      checkoutId: "checkout-one",
      expectedCheckoutRevision: 0,
      state: "proposed",
    });
    expect(() => context.service.assertAssignment(context.delegation)).not.toThrow();
    const other = context.store.createGroup({ name: "Other primary-checkout team" });
    context.store.addMembership(other.id, {
      memberId: "other-owner",
      agentProfileId: context.profile.id,
      alias: "Other owner",
    });
    expect(context.service.discover().find((team) => team.id === other.id)).toMatchObject({
      eligibility: {
        scope: "team",
        eligible: false,
        goalAuthorization: "not-evaluated",
        blockers: expect.arrayContaining([
          { code: "shared_active_checkout", message: "Another active team shares this checkout" },
        ]),
      },
      startupRequiredMemberIds: ["other-owner"],
      effectiveCheckout: {
        id: "checkout-one",
        sharedWithActiveTeams: [{ id: context.group.id, name: "SDK team" }],
      },
    });
    context.store.createRunForMembership(other.id, "other-owner");
    expect(
      context.service.assessTeam(context.group.id).blockers.map((blocker) => blocker.code),
    ).toContain("shared_active_checkout");
    expect(() => context.service.assertAssignment(context.delegation)).toThrow(
      "Another active team shares this checkout",
    );
  });

  it("rechecks an eligible team when another team starts on its checkout", () => {
    const context = teamFixture();
    const { service, store, group, profile, foreman } = context;
    service.control("human", {
      id: context.goal.id,
      expectedRevision: service.get(context.goal.id).revision,
      action: "cancel",
    });
    expect(service.assessTeam(group.id)).toMatchObject({
      eligible: true,
      goalAuthorization: "not-evaluated",
      blockers: [],
    });
    const goal = service.propose({ ...context.command, requestId: "second-goal" });
    service.control("human", { id: goal.id, expectedRevision: goal.revision, action: "approve" });
    const observed = service.discover().find((team) => team.id === group.id)!;
    const other = store.createGroup({ name: "Independent team" });
    store.addMembership(other.id, {
      memberId: "other",
      alias: "Other",
      agentProfileId: profile.id,
    });
    store.createRunForMembership(other.id, "other");
    expect(service.assessTeam(group.id).blockers.map((blocker) => blocker.code)).toContain(
      "shared_active_checkout",
    );
    expect(() =>
      service.delegate(foreman, {
        requestId: "stale-observation",
        goalId: goal.id,
        expectedRevision: service.get(goal.id).revision,
        groupId: group.id,
        memberId: "alex",
        expectedMembershipRevision: observed.membershipRevision,
        expectedCheckoutRevision: observed.checkoutRevision,
        rationale: "Observed idle team",
        brief: "Deliver the outcome",
      }),
    ).toThrow("Another active team shares this checkout");
    expect(service.workspace(goal.id).delegations).toEqual([]);
  });

  it.each(["human_controlled", "runtime_not_ready", "unsettled_work"])(
    "uses the same %s blocker in discovery and delegation",
    (code) => {
      const context = teamFixture();
      const { store, group, foreman } = context;
      context.service.control("human", {
        id: context.goal.id,
        expectedRevision: context.service.get(context.goal.id).revision,
        action: "cancel",
      });
      const service = new ForemanGoalService(
        store,
        () => context.config,
        () => code === "human_controlled",
      );
      const goal = service.propose({ ...context.command, requestId: "blocked-goal" });
      service.control("human", { id: goal.id, expectedRevision: goal.revision, action: "approve" });
      const status = store.getAgentStatus(group.id, "alex");
      const statusSpy =
        code === "runtime_not_ready"
          ? vi
              .spyOn(store, "getAgentStatus")
              .mockReturnValue({ ...status, interactiveReady: false })
          : undefined;
      const actionsSpy =
        code === "unsettled_work"
          ? vi
              .spyOn(store, "listAgentActions")
              .mockReturnValue([
                { state: "queued", principal: { kind: "agent" } } as ReturnType<
                  typeof store.listAgentActions
                >[number],
              ])
          : undefined;
      try {
        const observed = service.discover().find((team) => team.id === group.id)!;
        const blocker = observed.eligibility.blockers.find((item) => item.code === code)!;
        expect(observed.eligibility.eligible).toBe(false);
        expect(blocker).toBeDefined();
        expect(() =>
          service.delegate(foreman, {
            requestId: "blocked-handoff",
            goalId: goal.id,
            expectedRevision: service.get(goal.id).revision,
            groupId: group.id,
            memberId: "alex",
            expectedMembershipRevision: observed.membershipRevision,
            expectedCheckoutRevision: observed.checkoutRevision,
            rationale: "Select real owner",
            brief: "Deliver the outcome",
          }),
        ).toThrow(blocker.message);
        expect(service.workspace(goal.id).delegations).toEqual([]);
      } finally {
        statusSpy?.mockRestore();
        actionsSpy?.mockRestore();
      }
    },
  );

  it("converses without goals, requires a tool reply, and persists context across restart", async () => {
    const context = teamFixture();
    const { store, service, foreman, lead, reviewer, config, path } = context;
    store.database.exec("DELETE FROM foreman_coordination_records; DELETE FROM foreman_inbox");
    const conversations = new ForemanConversationService(store, service, () => false);
    const actions = new AgentActionService(
      store,
      1,
      new PeerCapabilityPolicy(undefined, undefined, undefined, (principal, command) =>
        conversations.authorize(principal, command),
      ),
    );
    const question = {
      requestId: "ad-hoc-one",
      groupId: lead.groupId,
      memberId: lead.memberId,
      text: "What is the team working on?",
      expiresInSeconds: 3600,
    };
    const request = conversations.ask(foreman, question);
    expect(conversations.ask(foreman, question)).toEqual(request);
    expect(() => conversations.ask(foreman, { ...question, text: "Changed question" })).toThrow(
      "reused",
    );
    expect(service.list()).toEqual([]);
    expect(service.delegations()).toEqual([]);
    await conversations.tick(actions);
    const delivered = conversations.get(request.id);
    const action = store.getAgentAction(delivered.actionId!);
    expect(action.principal.kind).toBe("foreman-conversation");
    expect(action.prompt).toContain("From: Repository Foreman");
    expect(action.prompt).toContain(`Reply using nanasa.reply_foreman with id ${request.id}`);
    expect(action.prompt).toContain("Terminal output alone is not delivered");
    expect(action.allowWorking).toBe(false);
    expect(() =>
      conversations.reply(lead, { id: request.id, requestId: "early", text: "Not delivered yet" }),
    ).toThrow("not reached");
    store.transitionAgentAction(action.id, ["created"], "submitted");
    store.transitionAgentAction(action.id, ["submitted"], "completed");
    await conversations.tick(actions);
    expect(conversations.get(request.id).state).toBe("submitted");
    expect(() => conversations.read(reviewer, { id: request.id })).toThrow("exact addressed");
    expect(() =>
      conversations.reply(reviewer, {
        id: request.id,
        requestId: "wrong-member",
        text: "Spoofed response",
      }),
    ).toThrow("exact addressed");
    const response = {
      id: request.id,
      requestId: "reply-one",
      text: "The team is implementing the agreed API changes.",
    };
    conversations.reply(lead, response);
    expect(conversations.reply(lead, response).state).toBe("answered");
    expect(() => conversations.reply(lead, { ...response, text: "Different answer" })).toThrow(
      "different reply",
    );
    expect(
      store.database
        .prepare("SELECT * FROM foreman_inbox WHERE dedupe_key = ?")
        .all(`conversation-result:${request.id}`),
    ).toHaveLength(1);
    const inboxId = String(
      store.database
        .prepare("SELECT id FROM foreman_inbox WHERE dedupe_key = ?")
        .get(`conversation-result:${request.id}`)!.id,
    );
    expect(() => conversations.authorizeInbox(inboxId, "another-foreman")).toThrow(
      "another Foreman",
    );
    expect(() => conversations.authorizeInbox(inboxId, foreman.foremanId)).not.toThrow();
    const reopened = new NanasaStore(path);
    try {
      const restored = new ForemanConversationService(
        reopened,
        new ForemanGoalService(reopened, () => config),
        () => false,
      );
      expect(restored.read(foreman, { id: request.id }).requests[0]).toMatchObject({
        state: "answered",
        response: response.text,
      });
      restored.finish(foreman, request.id);
      expect(
        reopened.database
          .prepare("SELECT state FROM foreman_inbox WHERE dedupe_key = ?")
          .get(`conversation-result:${request.id}`)?.state,
      ).toBe("answered");
    } finally {
      reopened.close();
    }
    const followup = conversations.ask(foreman, {
      ...question,
      requestId: "follow-up",
      replyTo: request.id,
      text: "Any blockers?",
    });
    expect(followup.conversationId).toBe(request.conversationId);
    const proposal = {
      requestId: "promoted-goal",
      title: "Finish API changes",
      objective: "Complete the discussed work",
      constraints: [],
      sourceConversationIds: [request.id, followup.id],
    };
    expect(() =>
      service.propose({ ...proposal, sourceConversationIds: [request.conversationId] }),
    ).toThrowError(expect.objectContaining({ code: "foreman_goal_source_conversation_invalid" }));
    store.database
      .prepare("UPDATE foreman_conversations SET data_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...followup, foremanId: "another-foreman" }), followup.id);
    expect(() => service.propose(proposal)).toThrowError(
      expect.objectContaining({
        code: "foreman_goal_source_conversation_invalid",
        details: expect.objectContaining({ index: 1, effect: "none" }),
      }),
    );
    expect(service.list()).toEqual([]);
    store.database
      .prepare("UPDATE foreman_conversations SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(followup), followup.id);
    const goal = service.propose(proposal);
    expect(goal.state).toBe("proposed");
    expect(goal.sourceConversationIds).toEqual([request.id, followup.id]);
    expect(service.delegations()).toEqual([]);
  });

  it("queues ad hoc questions behind busy or Human-controlled recipients and expires without replay", async () => {
    const { store, service, foreman, lead } = teamFixture();
    store.database.exec("DELETE FROM foreman_coordination_records; DELETE FROM foreman_inbox");
    let controlled = true;
    let clock = new Date();
    const conversations = new ForemanConversationService(
      store,
      service,
      () => controlled,
      () => clock,
    );
    const actions = new AgentActionService(
      store,
      1,
      new PeerCapabilityPolicy(undefined, undefined, undefined, (principal, command) =>
        conversations.authorize(principal, command),
      ),
    );
    const request = conversations.ask(foreman, {
      requestId: "queue",
      groupId: lead.groupId,
      memberId: lead.memberId,
      text: "Status?",
      expiresInSeconds: 30,
    });
    await conversations.tick(actions);
    expect(store.listAgentActions()).toEqual([]);
    controlled = false;
    const status = store.getAgentStatus(lead.groupId, lead.memberId);
    const busy = vi.spyOn(store, "getAgentStatus").mockReturnValue({ ...status, state: "working" });
    try {
      await conversations.tick(actions);
      expect(store.listAgentActions()).toEqual([]);
    } finally {
      busy.mockRestore();
    }
    clock = new Date(clock.getTime() + 31000);
    await conversations.tick(actions);
    expect(conversations.get(request.id).state).toBe("expired");
    expect(store.listAgentActions()).toEqual([]);
    expect(() =>
      conversations.reply(lead, { id: request.id, requestId: "late", text: "Late answer" }),
    ).toThrow("expired");
  });

  it("keeps conversation authority separate from goals and rejects replaced recipients", async () => {
    const { store, service, foreman, lead } = teamFixture();
    store.database.exec("DELETE FROM foreman_coordination_records; DELETE FROM foreman_inbox");
    const conversations = new ForemanConversationService(store, service, () => false);
    const policy = new PeerCapabilityPolicy(undefined, undefined, undefined, (principal, command) =>
      conversations.authorize(principal, command),
    );
    const actions = new AgentActionService(store, 1, policy);
    const request = conversations.ask(foreman, {
      requestId: "identity",
      groupId: lead.groupId,
      memberId: lead.memberId,
      text: "Status?",
      expiresInSeconds: 3600,
    });
    await conversations.tick(actions);
    const action = store.getAgentAction(conversations.get(request.id).actionId!);
    expect(() => policy.assertNoPeerTerminalOrRunControl(action.principal)).toThrow(
      "cannot control",
    );
    expect(() =>
      actions.create(
        action.principal,
        CreateAgentActionCommandSchema.parse({
          kind: "prompt",
          groupId: lead.groupId,
          memberId: lead.memberId,
          prompt: "Unrelated execution",
        }),
        "bypass",
      ),
    ).toThrow("does not match");
    store.transitionAgentAction(action.id, ["created"], "stalled");
    await conversations.tick(actions);
    expect(conversations.get(request.id).state).toBe("ambiguous");
    await conversations.tick(actions);
    expect(store.listAgentActions()).toHaveLength(1);
    const second = conversations.ask(foreman, {
      requestId: "identity-two",
      groupId: lead.groupId,
      memberId: lead.memberId,
      text: "New status request",
      expiresInSeconds: 3600,
    });
    store.updateRuntimeRunStatus(lead.runId, "stopping");
    store.updateRuntimeRunStatus(lead.runId, "stopped");
    store.createRunForMembership(lead.groupId, lead.memberId);
    await conversations.tick(actions);
    expect(conversations.get(second.id).state).toBe("cancelled");
  });

  it("cancels queued conversation input without replay and keeps questions out of goal action budgets", async () => {
    const { store, service, foreman, lead, delegation } = teamFixture();
    const conversations = new ForemanConversationService(store, service, () => false);
    const actions = new AgentActionService(
      store,
      1,
      new PeerCapabilityPolicy(undefined, undefined, undefined, (principal, command) =>
        conversations.authorize(principal, command),
      ),
    );
    const request = conversations.ask(foreman, {
      requestId: "cancel-me",
      groupId: lead.groupId,
      memberId: lead.memberId,
      text: "What is your current status?",
      expiresInSeconds: 3600,
    });
    await conversations.tick(actions);
    const action = store.getAgentAction(conversations.get(request.id).actionId!);
    expect(service.unsettled(service.delegation(delegation.id))).toEqual([]);
    conversations.cancel(request.id);
    expect(store.getAgentAction(action.id).state).toBe("cancelled");
    expect(() => conversations.authorizeAction(action)).toThrow("expired or no longer");
    await conversations.tick(actions);
    expect(store.listAgentActions()).toHaveLength(1);
    expect(conversations.cancel(request.id).state).toBe("cancelled");
  });

  it("does not carry queued conversation authority through disable and re-enable", async () => {
    const { store, service, foreman, lead } = teamFixture();
    const conversations = new ForemanConversationService(store, service, () => false);
    const actions = new AgentActionService(
      store,
      1,
      new PeerCapabilityPolicy(undefined, undefined, undefined, (principal, command) =>
        conversations.authorize(principal, command),
      ),
    );
    const request = conversations.ask(foreman, {
      requestId: "before-revoke",
      groupId: lead.groupId,
      memberId: lead.memberId,
      text: "Status?",
      expiresInSeconds: 3600,
    });
    const actor = store.getForeman(foreman.foremanId);
    store.upsertForeman({ ...actor, enabled: false });
    store.upsertForeman({ ...actor, enabled: true });
    await conversations.tick(actions);
    expect(conversations.get(request.id).state).toBe("cancelled");
    expect(store.listAgentActions()).toEqual([]);
  });
  it("runs separate goals concurrently and pauses only the selected goal", async () => {
    const {
      service,
      actions,
      goal,
      delegation,
      lead,
      reviewer,
      second,
      store,
      config,
      path,
      foreman,
    } = multiTeamFixture(true);
    expect(() =>
      service.propose({
        requestId: "third-goal",
        title: "Third",
        objective: "Exceeds the two-goal limit",
        constraints: [],
      }),
    ).toThrow("capacity");
    expect(() =>
      service.delegate(foreman, {
        requestId: "double-book",
        goalId: second.goal.id,
        expectedRevision: service.get(second.goal.id).revision,
        groupId: delegation.groupId,
        memberId: delegation.memberId,
        expectedMembershipRevision: delegation.expectedMembershipRevision,
        expectedCheckoutRevision: delegation.expectedCheckoutRevision,
        rationale: "Try to reuse a reserved team",
        brief: "A conflicting assignment",
      }),
    ).toThrow("already reserved");
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected restart");
      },
    });
    for (const team of [{ delegation, lead }, second]) {
      service.report(team.lead, {
        requestId: "accept",
        delegationId: team.delegation.id,
        kind: "accepted",
        summary: "Workstream accepted",
        evidence: [],
        nextCheckSeconds: 900,
      });
    }
    const firstAction = actions.create(
      lead,
      CreateAgentActionCommandSchema.parse({
        kind: "prompt",
        groupId: lead.groupId,
        memberId: reviewer.memberId,
        prompt: "SDK work",
      }),
      "sdk-action",
    );
    const secondAction = actions.create(
      second.lead,
      CreateAgentActionCommandSchema.parse({
        kind: "prompt",
        groupId: second.group.id,
        memberId: second.reviewer.memberId,
        prompt: "Frontend work",
      }),
      "frontend-action",
    );
    const reviews = store.database
      .prepare("SELECT dedupe_key FROM foreman_inbox WHERE state = 'queued'")
      .all();
    expect(
      reviews.some((row) => String(row.dedupe_key).startsWith(`goal-review:${goal.id}:`)),
    ).toBe(true);
    expect(
      reviews.some((row) => String(row.dedupe_key).startsWith(`goal-review:${second.goal.id}:`)),
    ).toBe(true);
    expect(service.get(goal.id).turnsUsed).toBe(1);
    expect(service.get(second.goal.id).turnsUsed).toBe(1);
    service.control("human", {
      id: goal.id,
      expectedRevision: service.get(goal.id).revision,
      action: "pause",
    });
    expect(() => service.authorizeAction(firstAction)).toThrow("not running");
    expect(() => service.authorizeAction(secondAction)).not.toThrow();
    service.report(second.lead, {
      requestId: "progress",
      delegationId: second.delegation.id,
      kind: "progress",
      summary: "Frontend work continues",
      evidence: [],
      nextCheckSeconds: 900,
    });
    const reopened = new NanasaStore(path);
    try {
      const restored = new ForemanGoalService(reopened, () => config);
      expect(restored.get(goal.id).state).toBe("paused");
      expect(restored.get(second.goal.id).state).toBe("running");
      expect(restored.delegation(second.delegation.id).state).toBe("working");
      expect(() => restored.authorizeAction(secondAction)).not.toThrow();
    } finally {
      reopened.close();
    }
  });

  it("deduplicates pending reviews before charging the goal budget for more team reports", async () => {
    const { service, actions, goal, delegation, lead, second, store } = multiTeamFixture();
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected restart");
      },
    });
    const current = service.get(goal.id);
    store.database
      .prepare("UPDATE foreman_coordination_records SET data_json = ? WHERE id = ?")
      .run(
        JSON.stringify({ ...current, grant: { ...current.grant, maxForemanTurns: 1 } }),
        goal.id,
      );
    for (const team of [{ delegation, lead }, second]) {
      service.report(team.lead, {
        requestId: "blocked",
        delegationId: team.delegation.id,
        kind: "blocked",
        summary: "We need a progress review",
        evidence: [],
        nextCheckSeconds: 900,
      });
    }
    expect(service.get(goal.id)).toMatchObject({ state: "running", turnsUsed: 1 });
    expect(
      store.database
        .prepare("SELECT id FROM foreman_inbox WHERE state = 'queued' AND dedupe_key LIKE ?")
        .all(`goal-review:${goal.id}:%`),
    ).toHaveLength(1);
    service.finishReview(
      {
        kind: "foreman",
        foremanId: current.foremanId,
        runId: store.getActiveForemanRun(current.foremanId)!.id,
        generation: 1,
        authorityRevision: store.getForeman(current.foremanId).authorityRevision,
      },
      goal.id,
    );
    service.report(lead, {
      requestId: "blocked-again",
      delegationId: delegation.id,
      kind: "blocked",
      summary: "A new review is needed",
      evidence: [],
      nextCheckSeconds: 900,
    });
    expect(service.get(goal.id).state).toBe("blocked");
  });

  it("keeps equal question request IDs independent across teams", () => {
    const { service, goal, delegation, lead, second } = multiTeamFixture();
    const first = {
      requestId: "question-one",
      goalId: goal.id,
      delegationId: delegation.id,
      question: "SDK scope?",
      options: [],
      blocking: true,
    };
    const firstDecision = service.question(lead, first);
    const secondDecision = service.question(second.lead, {
      ...first,
      delegationId: second.delegation.id,
      question: "Frontend scope?",
    });
    expect(firstDecision.id).not.toBe(secondDecision.id);
    expect(service.question(lead, first)).toEqual(firstDecision);
    expect(service.own(lead)[0]!.delegations.map((item) => item.id)).toEqual([delegation.id]);
    expect(service.own(lead)[0]!.decisions.some((item) => item.id === secondDecision.id)).toBe(
      false,
    );
    expect(
      service.own(second.lead)[0]!.decisions.some((item) => item.id === firstDecision.id),
    ).toBe(false);
    service.resolve("human", {
      id: firstDecision.id,
      expectedRevision: 0,
      requestId: "answer",
      answer: "Core SDK only",
    });
    expect(
      service.workspace(goal.id).decisions.find((item) => item.id === secondDecision.id)?.state,
    ).toBe("pending");
  });

  it("continues reconciling another team after an unexpected failure", async () => {
    const { service, actions, delegation, second } = multiTeamFixture();
    const check = service.assertAssignment.bind(service);
    const fault = vi.spyOn(service, "assertAssignment").mockImplementation((candidate) => {
      if (candidate.id === delegation.id) throw new Error("Unavailable team dependency");
      check(candidate);
    });
    try {
      await service.tick(actions, {
        startRun: async () => {
          throw new Error("Unexpected restart");
        },
      });
      expect(service.delegation(delegation.id).state).toBe("queued");
      expect(service.delegation(second.delegation.id).state).toBe("offered");
      expect(service.notifications({}).notifications).toContainEqual(
        expect.objectContaining({
          kind: "health",
          delegationId: delegation.id,
          summary: "Delegation reconciliation failed; inspect the retained state.",
        }),
      );
    } finally {
      fault.mockRestore();
    }
  });

  it("lets two teams work concurrently and finish independently of another team's blocker", async () => {
    const { service, actions, goal, delegation, lead, reviewer, second, store } =
      multiTeamFixture();
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected restart");
      },
    });
    expect(service.delegation(delegation.id).state).toBe("offered");
    expect(service.delegation(second.delegation.id).state).toBe("offered");
    expect(store.listAgentActions()).toHaveLength(2);
    for (const team of [{ delegation, lead }, second]) {
      service.report(team.lead, {
        requestId: "accept",
        delegationId: team.delegation.id,
        kind: "accepted",
        summary: "We own our team's workstream",
        evidence: [],
        nextCheckSeconds: 900,
      });
    }
    const firstAction = actions.create(
      lead,
      CreateAgentActionCommandSchema.parse({
        kind: "prompt",
        groupId: lead.groupId,
        memberId: reviewer.memberId,
        prompt: "Review the SDK",
      }),
      "sdk-work",
    );
    const secondAction = actions.create(
      second.lead,
      CreateAgentActionCommandSchema.parse({
        kind: "prompt",
        groupId: second.lead.groupId,
        memberId: second.reviewer.memberId,
        prompt: "Review the frontend",
      }),
      "frontend-work",
    );
    const question = service.question(second.lead, {
      requestId: "frontend-question",
      goalId: goal.id,
      delegationId: second.delegation.id,
      question: "Which visual treatment is required?",
      options: [],
      blocking: true,
    });
    expect(() => service.authorizeAction(firstAction)).not.toThrow();
    expect(() => service.authorizeAction(secondAction)).toThrow("human decision");
    actions.cancel(lead, firstAction.id);
    const evidence = {
      delegationId: delegation.id,
      summary: "SDK checks and independent review passed",
      evidence: ["sdk-validation.md"],
      candidateHead: "d".repeat(40),
      nextCheckSeconds: 900,
    };
    service.report(reviewer, {
      ...evidence,
      requestId: "review",
      kind: "review",
      reviewOutcome: "approved",
    });
    service.report(lead, { ...evidence, requestId: "ready", kind: "ready" });
    expect(service.delegation(delegation.id).state).toBe("ready");
    expect(service.get(goal.id).state).toBe("running");
    expect(service.delegation(second.delegation.id).state).toBe("accepted");
    expect(
      service
        .own(second.lead)[0]!
        .reports.every((report) => report.delegationId === second.delegation.id),
    ).toBe(true);
    service.resolve("human", {
      id: question.id,
      expectedRevision: question.revision,
      requestId: "visual-choice",
      answer: "Use the existing design system",
    });
    actions.cancel(second.lead, secondAction.id);
    const frontendEvidence = {
      ...evidence,
      delegationId: second.delegation.id,
      candidateHead: "f".repeat(40),
      evidence: ["frontend-validation.md"],
    };
    service.report(second.reviewer, {
      ...frontendEvidence,
      requestId: "review",
      kind: "review",
      reviewOutcome: "approved",
    });
    service.report(second.lead, { ...frontendEvidence, requestId: "ready", kind: "ready" });
    expect(service.get(goal.id).state).toBe("awaiting-acceptance");
    expect(service.workspace(goal.id).delegations.every((item) => item.state === "ready")).toBe(
      true,
    );
  });

  it("shares a goal's concurrency budget across teams and applies goal-wide decisions to both", async () => {
    const { service, actions, foreman, goal, delegation, lead, reviewer, second } =
      multiTeamFixture();
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected restart");
      },
    });
    const teams = [{ delegation, lead, reviewer }, second];
    const pending = [];
    for (const team of teams) {
      service.report(team.lead, {
        requestId: "accept",
        delegationId: team.delegation.id,
        kind: "accepted",
        summary: "Accepted",
        evidence: [],
        nextCheckSeconds: 900,
      });
      for (const index of [1, 2]) {
        pending.push(
          actions.create(
            team.lead,
            CreateAgentActionCommandSchema.parse({
              kind: "prompt",
              groupId: team.lead.groupId,
              memberId: team.reviewer.memberId,
              prompt: `Work ${index}`,
            }),
            `work-${index}`,
          ),
        );
      }
    }
    expect(() =>
      actions.create(
        lead,
        CreateAgentActionCommandSchema.parse({
          kind: "prompt",
          groupId: lead.groupId,
          memberId: reviewer.memberId,
          prompt: "Excess work",
        }),
        "excess",
      ),
    ).toThrow("concurrency budget");
    const decision = service.question(foreman, {
      requestId: "shared-decision",
      goalId: goal.id,
      question: "Change the shared API contract?",
      options: [],
      blocking: true,
    });
    for (const team of teams) {
      expect(service.own(team.lead)[0]!.decisions).toContainEqual(decision);
      expect(() => service.authorizeTeamInput(team.lead)).toThrow("human decision");
    }
    for (const action of pending)
      expect(() => service.authorizeAction(action)).toThrow("human decision");
  });
  it("rejects stored mission-named goal budgets instead of bypassing renamed limits", () => {
    const { service, store, command } = fixture();
    const goal = service.propose(command);
    const legacy = { ...goal, grant: { ...goal.grant, maxMissionHours: goal.grant.maxGoalHours } };
    store.database
      .prepare("UPDATE foreman_coordination_records SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(legacy), goal.id);
    expect(() => service.get(goal.id)).toThrow("Stored goal policy");
    expect(() => service.list()).toThrow("Stored goal policy");
    expect(() =>
      service.control("human", { id: goal.id, expectedRevision: goal.revision, action: "approve" }),
    ).toThrow("Stored goal policy");
    expect(
      JSON.parse(
        String(
          store.database
            .prepare("SELECT data_json FROM foreman_coordination_records WHERE id = ?")
            .get(goal.id)!.data_json,
        ),
      ),
    ).toEqual(legacy);
  });
  it("keeps an unapproved proposal from capturing peer work or recovery authority", () => {
    const { service, actions, lead, reviewer, store, goal } = teamFixture(false, false);
    const action = actions.create(
      lead,
      CreateAgentActionCommandSchema.parse({
        kind: "prompt",
        groupId: lead.groupId,
        memberId: reviewer.memberId,
        prompt: "Continue the Human's existing work",
      }),
      "ordinary-work",
    );
    expect(
      store.database.prepare("SELECT * FROM delegation_actions WHERE action_id = ?").get(action.id),
    ).toBeUndefined();
    expect(service.authorizeRecovery(lead.groupId, lead.memberId)).toBeUndefined();
    const decision = service.workspace(goal.id).decisions[0]!;
    expect(() =>
      service.resolve("human", {
        id: decision.id,
        expectedRevision: 0,
        requestId: "late-approval",
        answer: "approve",
      }),
    ).toThrow("availability changed");
  });
  it("persists bounded recovery attempts and never recovers a paused goal", async () => {
    const { service, actions, store, config, goal, lead } = teamFixture(true);
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected launch");
      },
    });
    store.updateRuntimeRunStatus(lead.runId, "failed");
    expect(service.authorizeRecovery(lead.groupId, lead.memberId)).toBe(true);
    const restarted = new ForemanGoalService(store, () => config);
    expect(restarted.authorizeRecovery(lead.groupId, lead.memberId)).toBe(false);
    service.control("human", {
      id: goal.id,
      expectedRevision: service.get(goal.id).revision,
      action: "pause",
    });
    expect(restarted.authorizeRecovery(lead.groupId, lead.memberId)).toBe(false);
    service.control("human", {
      id: goal.id,
      expectedRevision: service.get(goal.id).revision,
      action: "cancel",
    });
    expect(restarted.authorizeRecovery(lead.groupId, lead.memberId)).toBe(false);
  });
  it("hands an outcome to a dynamically described owner and fences child work and stale decisions", async () => {
    const context = teamFixture();
    const { service, foreman, goal, delegation, actions, lead, reviewer, store } = context;
    expect(service.discover()[0]!.members[0]).toMatchObject({
      roleName: "Delivery owner",
      description: expect.stringContaining("research"),
    });
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Must not restart existing team runs");
      },
    });
    expect(
      service.notifications({}).notifications.filter((item) => item.kind === "health"),
    ).toEqual([]);
    expect(service.discover()[0]!.members[0]!.status).toMatchObject({
      state: "idle",
      interactiveReady: true,
      authorityKind: "reporter",
      processState: "present",
      staleAuthority: false,
    });
    expect(service.delegation(delegation.id)).toMatchObject({
      state: "offered",
      memberId: "alex",
      runId: lead.runId,
    });
    expect(store.listAgentActions()).toHaveLength(1);
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Must not restart");
      },
    });
    expect(store.listAgentActions()).toHaveLength(1);
    service.report(lead, {
      requestId: "accept",
      delegationId: delegation.id,
      kind: "accepted",
      summary: "I own research through review",
      evidence: [],
      nextCheckSeconds: 900,
    });
    const command = CreateAgentActionCommandSchema.parse({
      kind: "prompt",
      groupId: lead.groupId,
      memberId: reviewer.memberId,
      prompt: "Independently research conformance requirements",
    });
    const child = actions.create(lead, command, "research-one");
    expect(
      store.database
        .prepare("SELECT delegation_id FROM delegation_actions WHERE action_id = ?")
        .get(child.id)?.delegation_id,
    ).toBe(delegation.id);
    const question = service.question(lead, {
      requestId: "question",
      goalId: goal.id,
      delegationId: delegation.id,
      question: "Include the optional Events capability?",
      options: ["yes", "no"],
      blocking: true,
    });
    expect(() => service.authorizeAction(child)).toThrow("human decision");
    service.resolve("human", {
      id: question.id,
      expectedRevision: question.revision,
      requestId: "answer-one",
      answer: "yes",
    });
    expect(() => service.authorizeAction(child)).not.toThrow();
    expect(() =>
      service.resolve("other-human", {
        id: question.id,
        expectedRevision: 0,
        requestId: "late",
        answer: "no",
      }),
    ).toThrow("stale");
    service.control("human", {
      id: goal.id,
      expectedRevision: service.get(goal.id).revision,
      action: "pause",
    });
    expect(() => service.authorizeAction(child)).toThrow("not running");
    expect(() => actions.create(lead, command, "after-pause")).toThrow("not running");
    expect(() =>
      service.authorizeMessage(lead.groupId, {
        sender: { kind: "agent", memberId: lead.memberId, runId: lead.runId },
      }),
    ).toThrow("not running");
    expect(() =>
      service.authorizeMessage(lead.groupId, { sender: { kind: "operator" } }),
    ).not.toThrow();
    const inbox = store.database
      .prepare("SELECT id FROM foreman_inbox WHERE dedupe_key LIKE ?")
      .get(`goal-review:${goal.id}:%`)!;
    expect(() => service.authorizeInbox(String(inbox.id))).toThrow("not running");
    expect(() =>
      service.delegate(foreman, { ...delegation, requestId: "duplicate-owner" }),
    ).toThrow();
  });

  it("requires independent same-commit evidence and preserves reports across a real database reopen", async () => {
    const { service, goal, delegation, actions, lead, reviewer, store, config, path } =
      teamFixture();
    await service.tick(actions, {
      startRun: async () => {
        throw new Error("Unexpected restart");
      },
    });
    service.report(lead, {
      requestId: "accept",
      delegationId: delegation.id,
      kind: "accepted",
      summary: "Accepted",
      evidence: [],
      nextCheckSeconds: 900,
    });
    const evidence = {
      delegationId: delegation.id,
      summary: "Conformance checks passed",
      evidence: ["tests/conformance-results.md"],
      candidateHead: "d".repeat(40),
      nextCheckSeconds: 900,
    };
    expect(() =>
      service.report(lead, { ...evidence, requestId: "premature", kind: "ready" }),
    ).toThrow("Independent review");
    expect(() =>
      service.report(lead, {
        ...evidence,
        requestId: "self-review",
        kind: "review",
        reviewOutcome: "approved",
      }),
    ).toThrow("cannot supply");
    service.report(reviewer, {
      ...evidence,
      requestId: "review",
      kind: "review",
      reviewOutcome: "approved",
    });
    service.report(lead, { ...evidence, requestId: "ready", kind: "ready" });
    expect(service.get(goal.id).state).toBe("awaiting-acceptance");
    const reopened = new NanasaStore(path);
    try {
      const restored = new ForemanGoalService(reopened, () => config);
      expect(restored.workspace(goal.id).reports).toHaveLength(3);
      expect(restored.workspace(goal.id).goal.state).toBe("awaiting-acceptance");
    } finally {
      reopened.close();
    }
    store.database.prepare("UPDATE checkouts SET dirty = 1 WHERE id = ?").run("checkout-one");
    expect(() =>
      service.control("human", {
        id: goal.id,
        expectedRevision: service.get(goal.id).revision,
        action: "accept",
      }),
    ).toThrow("evidence");
  });
  it("persists an unplanned goal and requires a revision-fenced human approval", () => {
    const { service, command, store, config } = fixture();
    const proposed = service.propose(command);
    expect(proposed.state).toBe("proposed");
    expect(service.propose(command)).toEqual(proposed);
    expect(() => service.propose({ ...command, objective: "different" })).toThrow("reused");
    const running = service.control("human", {
      id: proposed.id,
      expectedRevision: 0,
      action: "approve",
    });
    expect(running.state).toBe("running");
    expect(() =>
      service.control("human", { id: proposed.id, expectedRevision: 0, action: "approve" }),
    ).toThrow("revision");
    expect(new ForemanGoalService(store, () => config).get(proposed.id)).toEqual(running);
  });
  it("retains notification cursors and catches up without a running model", () => {
    const { service, command, store, config } = fixture();
    service.propose(command);
    const page = service.notifications({ after: 0 });
    expect(page.notifications).toHaveLength(1);
    service.acknowledge("connector-one", page.nextAfter);
    const restarted = new ForemanGoalService(store, () => config);
    expect(restarted.cursor("connector-one")).toEqual({ after: page.nextAfter });
    expect(restarted.notifications(restarted.cursor("connector-one")).notifications).toEqual([]);
    expect(() => restarted.acknowledge("connector-one", 999)).toThrow("Invalid");
  });
  it("never treats a goal proposal as completion or permission to execute", () => {
    const { service, command } = fixture();
    const goal = service.propose(command);
    expect(() =>
      service.control("human", { id: goal.id, expectedRevision: 0, action: "accept" }),
    ).toThrow("state");
    service.control("human", { id: goal.id, expectedRevision: 0, action: "cancel" });
    expect(service.get(goal.id).state).toBe("cancelled");
  });
});
