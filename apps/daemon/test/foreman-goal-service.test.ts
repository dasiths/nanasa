import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRun,
  CreateAgentActionCommandSchema,
  NanasaConfigSchema,
} from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActionService } from "../src/actions/agent-action-service.js";
import { PeerCapabilityPolicy } from "../src/actions/peer-capability-policy.js";
import { ForemanConversationService } from "../src/foreman-conversation-service.js";
import { ForemanGoalService } from "../src/foreman-goal-service.js";
import { NanasaStore } from "../src/store.js";

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

function teamFixture(recovery = false, approve = true) {
  const context = fixture();
  const { store, config, service, root } = context;
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
  store.assignGroupCheckout(group.id, "checkout-one", 0);
  const goal = service.propose(context.command);
  service.control("human", { id: goal.id, expectedRevision: 0, action: "approve" });
  const team = service.discover()[0]!;
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
  if (approve)
    service.resolve("human", {
      id: decision.id,
      expectedRevision: 0,
      requestId: "approve-team",
      answer: "approve",
    });
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
  const lead = start("alex");
  const reviewer = start("sam");
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
    const goal = service.propose({
      requestId: "promoted-goal",
      title: "Finish API changes",
      objective: "Complete the discussed work",
      constraints: [],
      sourceConversationIds: [request.id, followup.id],
    });
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
    service.report(reviewer, { ...evidence, requestId: "review", kind: "review" });
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
    service.report(second.reviewer, { ...frontendEvidence, requestId: "review", kind: "review" });
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
      service.report(lead, { ...evidence, requestId: "self-review", kind: "review" }),
    ).toThrow("cannot supply");
    service.report(reviewer, { ...evidence, requestId: "review", kind: "review" });
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
