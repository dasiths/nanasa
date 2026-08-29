import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NanasaConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { NanasaStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("NanasaStore persistence", () => {
  it("persists all domain state and append-only events across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);

    const group = store.createGroup({ name: "Review team" });
    const profile = store.createInternalAgentProfile({
      name: "Reviewer",
      agentType: "copilot",
      kind: "copilot",
      command: "copilot",
      args: ["--allow-all-tools"],
      environment: { NANASA_ROLE: "reviewer" },
    });
    const membership = store.addMembership(group.id, {
      memberId: "reviewer",
      agentProfileId: profile.id,
      alias: "Reviewer",
    });
    const run = store.createRun({
      id: "run_1",
      groupId: group.id,
      memberId: membership.memberId,
      agentProfileId: profile.id,
      generation: 1,
      status: "running",
      startedAt: "2026-08-09T15:00:00Z",
    });
    const submission = store.submitMessage(group.id, {
      intent: "request",
      sender: { kind: "operator", operatorId: "operator_1" },
      audience: { kind: "dm", memberId: membership.memberId },
      body: { contentType: "text/markdown", text: "Review the API." },
      delivery: {},
      hop: 0,
    });

    expect(store.getSnapshot()).toMatchObject({
      sequence: 5,
      groups: [{ id: group.id, name: group.name, membershipRevision: 1 }],
      agentProfiles: [profile],
      memberships: [membership],
      runs: [run],
      messages: [submission.message],
      deliveryOutcomes: submission.deliveryOutcomes,
    });
    store.close();

    const reopened = new NanasaStore(databasePath);
    expect(reopened.getSnapshot()).toMatchObject({
      sequence: 5,
      groups: [{ id: group.id, name: group.name, membershipRevision: 1 }],
      agentProfiles: [profile],
      memberships: [membership],
      runs: [run],
      messages: [submission.message],
      deliveryOutcomes: submission.deliveryOutcomes,
    });
    expect(reopened.listEvents().map((event) => event.type)).toEqual([
      "group.created",
      "agent-profile.created",
      "membership.added",
      "run.created",
      "message.submitted",
    ]);
    reopened.close();
  });

  it("projects configured agents to same-ID private profiles and memberships", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-agent-projection-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const config = NanasaConfigSchema.parse({
      version: 2,
      integrations: {
        copilot: {
          id: "copilot",
          name: "GitHub Copilot",
          kind: "copilot",
          command: ["copilot", "--allow-all-tools"],
          cwd: ".",
        },
      },
      roles: { reviewer: { name: "Reviewer" } },
      groups: {
        group_one: {
          name: "Review team",
          agents: {
            agent_one: {
              memberId: "copilot.alpha",
              name: "Alpha",
              integrationId: "copilot",
              roleId: "reviewer",
              instructions: [],
              order: 0,
            },
          },
        },
      },
    });
    const store = new NanasaStore(databasePath, { config });
    store.reconcileTopology(config);

    expect(store.getSnapshot()).toMatchObject({
      groups: [{ id: "group_one", membershipRevision: 1 }],
      agentProfiles: [
        {
          id: "agent_one",
          name: "Alpha",
          agentType: "copilot",
          command: "copilot",
          args: ["--allow-all-tools"],
        },
      ],
      memberships: [
        {
          id: "agent_one",
          groupId: "group_one",
          memberId: "copilot.alpha",
          agentProfileId: "agent_one",
          alias: "Alpha",
          roleId: "reviewer",
        },
      ],
    });

    const renamed = structuredClone(config);
    renamed.groups.group_one!.agents.agent_one!.name = "Renamed Alpha";
    store.reconcileTopology(renamed);
    expect(store.getGroup("group_one").membershipRevision).toBe(1);
    expect(store.getAgentProfile("agent_one").name).toBe("Renamed Alpha");
    expect(store.listActiveMemberships("group_one")[0]?.alias).toBe("Renamed Alpha");
    store.close();

    const reopened = new NanasaStore(databasePath, { config: renamed });
    expect(reopened.getAgentProfile("agent_one").id).toBe("agent_one");
    expect(reopened.listActiveMemberships("group_one")[0]).toMatchObject({
      id: "agent_one",
      memberId: "copilot.alpha",
      agentProfileId: "agent_one",
    });
    reopened.close();
  });

  it("persists bounded recovery transitions and fences callbacks after operator stop", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-recovery-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);
    const group = store.createGroup({ name: "Recovery" });
    const profile = store.createInternalAgentProfile({
      name: "Recoverable",
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
    const run = store.createRun({
      id: "run_recovery",
      groupId: group.id,
      memberId: "alpha",
      agentProfileId: profile.id,
      generation: 3,
      status: "running",
      startedAt: "2026-08-10T12:00:00.000Z",
    });
    const cooldown = "2026-08-10T12:00:30.000Z";

    expect(
      store.transitionRunRecovery(run.id, run.generation, "reconciling", {
        incrementAttempt: true,
        recoveryNotBefore: cooldown,
        reason: "daemon_restart",
      }),
    ).toMatchObject({
      recoveryPhase: "reconciling",
      recoveryAttempts: 1,
      recoveryNotBefore: cooldown,
      recoveryReason: "daemon_restart",
    });
    store.close();

    const reopened = new NanasaStore(databasePath);
    expect(reopened.getRun(run.id)).toMatchObject({
      recoveryPhase: "reconciling",
      recoveryAttempts: 1,
      recoveryNotBefore: cooldown,
    });
    expect(reopened.listEvents().map((event) => event.type)).toContain("run.recovery-changed");
    reopened.updateRunStatus(run.id, "stopping");
    expect(() => reopened.transitionRunRecovery(run.id, run.generation, "recovered")).toThrowError(
      expect.objectContaining({ code: "recovery_generation_fenced" }),
    );
    reopened.close();
  });

  it("persists one idempotent Start All outcome and operation event across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-start-all-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);
    const group = store.createGroup({ name: "Start All" });
    const result = {
      groupId: group.id,
      outcomes: [
        {
          groupId: group.id,
          memberId: "alpha",
          status: "failed" as const,
          reason: "launch_failed",
        },
      ],
    };

    expect(store.recordGroupStartAllResult(result, "operation-one")).toEqual(result);
    expect(store.recordGroupStartAllResult(result, "operation-one")).toEqual(result);
    expect(store.listEvents().filter((event) => event.type === "group.runs-started")).toHaveLength(
      1,
    );
    store.close();

    const reopened = new NanasaStore(databasePath);
    expect(reopened.getGroupStartAllResult(group.id, "operation-one")).toEqual(result);
    reopened.close();
  });

  it("retains bounded message pages, clears history, and preserves sequence high-water", () => {
    const config = NanasaConfigSchema.parse({
      version: 2,
      integrations: {
        copilot: {
          id: "copilot",
          name: "Copilot",
          kind: "copilot",
          command: ["copilot"],
        },
      },
      messages: { retentionPerGroup: 2 },
    });
    const store = new NanasaStore(":memory:", { config });
    const group = store.createGroup({ name: "Messages" });
    const profile = store.createInternalAgentProfile({
      name: "Reviewer",
      agentType: "copilot",
      kind: "copilot",
      command: "copilot",
      args: [],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "reviewer",
      agentProfileId: profile.id,
      alias: "Reviewer",
    });
    const send = (text: string, key: string) =>
      store.submitMessage(
        group.id,
        {
          intent: "request",
          sender: { kind: "operator", operatorId: "operator" },
          audience: { kind: "dm", memberId: "reviewer" },
          body: { contentType: "text/plain", text },
          delivery: {},
          hop: 0,
        },
        key,
      );

    const first = send("one", "one");
    send("two", "two");
    send("three", "three");

    expect(store.getGroupMessageState(group.id)).toMatchObject({
      latestGroupSeq: 3,
      oldestRetainedGroupSeq: 2,
      retainedMessageCount: 2,
    });
    expect(store.listMessagePage(group.id).messages.map((message) => message.body.text)).toEqual([
      "two",
      "three",
    ]);
    expect(store.listMessagePage(group.id, { limit: 1 }).messages[0]?.body.text).toBe("three");
    expect(store.listMessagePage(group.id, { limit: 1 }).pageInfo).toMatchObject({
      hasOlder: true,
      nextBefore: 3,
    });
    expect(store.listMessagePage(group.id, { before: 3 }).messages[0]?.body.text).toBe("two");
    expect(() => send("duplicate", "one")).toThrowError(
      expect.objectContaining({ code: "idempotency_result_expired", statusCode: 410 }),
    );
    expect(first.message.groupSeq).toBe(1);

    const cleared = store.clearMessageHistory(group.id, "clear");
    expect(cleared).toMatchObject({ deletedMessages: 2, deletedDeliveries: 2 });
    expect(store.getGroupMessageState(group.id)).toMatchObject({
      latestGroupSeq: 3,
      retainedMessageCount: 0,
    });
    expect(store.clearMessageHistory(group.id, "clear")).toEqual(cleared);
    expect(send("four", "four").message.groupSeq).toBe(4);
    store.close();
  });
});

describe("NanasaStore group and membership updates", () => {
  it("generates readable member IDs and retries docker-name collisions", () => {
    const generatedNames = ["calm_hopper", "calm_hopper", "bold_lovelace"];
    const store = new NanasaStore(":memory:", {
      memberNameGenerator: () => generatedNames.shift() ?? "unused_name",
    });
    const group = store.createGroup({ name: "Readable IDs" });
    const profile = store.createInternalAgentProfile({
      name: "Claude profile",
      agentType: "claude-code",
      kind: "claude-code",
      command: "claude",
      args: [],
      environment: {},
    });

    const first = store.addMembership(group.id, {
      agentProfileId: profile.id,
      alias: "First",
    });
    const second = store.addMembership(group.id, {
      agentProfileId: profile.id,
      alias: "Second",
    });
    const explicit = store.addMembership(group.id, {
      memberId: "fixture-member",
      agentProfileId: profile.id,
      alias: "Explicit",
    });

    expect(first.memberId).toBe("calm-hopper");
    expect(second.memberId).toBe("bold-lovelace");
    expect(explicit.memberId).toBe("fixture-member");
    store.close();
  });

  it("renames groups and active memberships idempotently without changing recipient revisions", () => {
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Original group" });
    const profile = store.createInternalAgentProfile({
      name: "Reusable profile",
      agentType: "opencode",
      kind: "opencode",
      command: "opencode",
      args: [],
      environment: {},
    });
    const membership = store.addMembership(group.id, {
      memberId: "builder",
      agentProfileId: profile.id,
      alias: "Original alias",
    });

    const renamedGroup = store.updateGroup(group.id, { name: "Renamed group" }, "group-rename");
    expect(store.updateGroup(group.id, { name: "Ignored replay" }, "group-rename")).toEqual(
      renamedGroup,
    );
    const renamedMembership = store.updateMembership(
      group.id,
      membership.memberId,
      { alias: "Renamed alias" },
      "member-rename",
    );
    expect(
      store.updateMembership(
        group.id,
        membership.memberId,
        { alias: "Ignored replay" },
        "member-rename",
      ),
    ).toEqual(renamedMembership);

    expect(store.getSnapshot()).toMatchObject({
      groups: [{ id: group.id, name: "Renamed group", membershipRevision: 1 }],
      agentProfiles: [profile],
      memberships: [{ memberId: "builder", alias: "Renamed alias", state: "active" }],
    });
    expect(store.listEvents().map((event) => event.type)).toEqual([
      "group.created",
      "agent-profile.created",
      "membership.added",
      "group.updated",
      "membership.updated",
    ]);

    store.removeMembership(group.id, membership.memberId);
    expect(() =>
      store.updateMembership(group.id, membership.memberId, { alias: "Too late" }),
    ).toThrowError(expect.objectContaining({ code: "membership_not_active" }));
    expect(store.getSnapshot().groups[0]?.membershipRevision).toBe(2);
    store.close();
  });

  it("deletes the group graph idempotently while retaining profiles and append-only events", () => {
    const store = new NanasaStore(":memory:");
    const fixture = createRoutingFixture(store);
    store.updateGroup(fixture.groupId, { name: "Renamed before deletion" }, "stale-group-update");
    const submission = store.submitMessage(fixture.groupId, {
      intent: "request",
      sender: { kind: "operator", operatorId: "operator" },
      audience: { kind: "multicast", memberIds: ["alpha", "beta"] },
      body: { contentType: "text/plain", text: "Before deletion" },
      delivery: {},
      hop: 0,
    });
    const linkedGroup = store.createGroup({ name: "Linked group" });
    store.addMembership(linkedGroup.id, {
      memberId: "linked-member",
      agentProfileId: fixture.profileId,
      alias: "Linked member",
    });
    const linkedSubmission = store.submitMessage(linkedGroup.id, {
      intent: "response",
      sender: { kind: "operator", operatorId: "operator" },
      audience: { kind: "dm", memberId: "linked-member" },
      body: { contentType: "text/plain", text: "Cross-group reply" },
      delivery: {},
      replyTo: submission.message.id,
      rootId: submission.message.id,
      causationId: submission.message.id,
      hop: 0,
    });

    expect(store.listGroupRunsRequiringStop(fixture.groupId)).toMatchObject([
      { id: "run_alpha", memberId: "alpha", desiredState: "running" },
    ]);
    store.updateRunStatus("run_alpha", "stopping");
    store.updateRunStatus("run_alpha", "stopped");
    const deleted = store.deleteGroup(fixture.groupId, "delete-group");
    expect(deleted).toEqual({
      groupId: fixture.groupId,
      deletedMemberships: 3,
      deletedRuns: 1,
      deletedMessages: 1,
      deletedDeliveries: 2,
    });
    expect(store.deleteGroup(fixture.groupId, "delete-group")).toEqual(deleted);
    expect(store.getSnapshot()).toMatchObject({
      groups: [{ id: linkedGroup.id }],
      memberships: [{ memberId: "linked-member" }],
      runs: [],
      messages: [{ id: linkedSubmission.message.id }],
      deliveryOutcomes: [{ messageId: linkedSubmission.message.id }],
      agentProfiles: [{ id: fixture.profileId }],
    });
    expect(store.getSnapshot().messages[0]).toMatchObject({
      replyTo: undefined,
      rootId: undefined,
      causationId: undefined,
    });
    expect(() =>
      store.updateGroup(fixture.groupId, { name: "Stale replay" }, "stale-group-update"),
    ).toThrowError(expect.objectContaining({ code: "group_not_found" }));
    expect(store.listEvents().map((event) => event.type)).toContain("group.deleted");
    expect(store.listEvents().find((event) => event.type === "message.submitted")).toMatchObject({
      aggregateId: submission.message.id,
    });
    store.close();
  });
});

function createRoutingFixture(store: NanasaStore) {
  const group = store.createGroup({ name: "Builders" });
  const profile = store.createInternalAgentProfile({
    name: "Builder",
    agentType: "opencode",
    kind: "opencode",
    command: "opencode",
    args: [],
    environment: {},
  });
  const memberIds = ["alpha", "beta", "gamma"];
  for (const memberId of memberIds) {
    store.addMembership(group.id, {
      memberId,
      agentProfileId: profile.id,
      alias: memberId,
    });
  }
  store.createRun({
    id: "run_alpha",
    groupId: group.id,
    memberId: "alpha",
    agentProfileId: profile.id,
    generation: 1,
    status: "running",
    startedAt: "2026-08-09T15:00:00Z",
  });
  return { groupId: group.id, profileId: profile.id, memberIds };
}

describe("NanasaStore message routing", () => {
  it("fans out DM, multicast, and agent broadcasts to the eligible snapshot", () => {
    const store = new NanasaStore(":memory:");
    const fixture = createRoutingFixture(store);
    const operator = { kind: "operator" as const, operatorId: "operator_1" };
    const common = {
      intent: "request" as const,
      body: { contentType: "text/plain" as const, text: "Check this." },
      delivery: {},
      hop: 0,
    };

    const direct = store.submitMessage(fixture.groupId, {
      ...common,
      sender: operator,
      audience: { kind: "dm", memberId: "alpha" },
    });
    const multicast = store.submitMessage(fixture.groupId, {
      ...common,
      sender: operator,
      audience: { kind: "multicast", memberIds: ["alpha", "gamma"] },
    });
    const broadcast = store.submitMessage(fixture.groupId, {
      ...common,
      sender: { kind: "agent", memberId: "alpha", runId: "run_alpha" },
      audience: { kind: "group", membershipRevision: 3 },
      delivery: {},
    });

    expect(direct.deliveryOutcomes.map((outcome) => outcome.recipientMemberId)).toEqual(["alpha"]);
    expect(multicast.deliveryOutcomes.map((outcome) => outcome.recipientMemberId)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(broadcast.deliveryOutcomes).toMatchObject([
      {
        recipientMemberId: "beta",
        status: "queued",
      },
      {
        recipientMemberId: "gamma",
        status: "queued",
      },
    ]);
    expect(broadcast.deliveryOutcomes[0]).not.toHaveProperty("requestedMode");

    const terminal = store.submitMessage(fixture.groupId, {
      ...common,
      sender: operator,
      audience: { kind: "multicast", memberIds: ["alpha", "beta"] },
      delivery: {},
    });
    expect(terminal.deliveryOutcomes).toMatchObject([
      {
        recipientMemberId: "alpha",
        status: "queued",
      },
      {
        recipientMemberId: "beta",
        status: "queued",
      },
    ]);

    const agentTerminalBroadcast = store.submitMessage(fixture.groupId, {
      ...common,
      sender: { kind: "agent", memberId: "alpha", runId: "run_alpha" },
      audience: { kind: "group", membershipRevision: 3 },
      delivery: {},
    });
    expect(agentTerminalBroadcast.deliveryOutcomes).toMatchObject([
      {
        recipientMemberId: "beta",
        status: "queued",
      },
      {
        recipientMemberId: "gamma",
        status: "queued",
      },
    ]);
    store.close();
  });

  it("rejects stale broadcasts, inactive recipients, and unauthorized agent runs", () => {
    const store = new NanasaStore(":memory:");
    const fixture = createRoutingFixture(store);
    const base = {
      intent: "request" as const,
      body: { contentType: "text/plain" as const, text: "Check this." },
      delivery: {},
      hop: 0,
    };

    expect(() =>
      store.submitMessage(fixture.groupId, {
        ...base,
        sender: { kind: "operator", operatorId: "operator_1" },
        audience: { kind: "group", membershipRevision: 2 },
      }),
    ).toThrowError(expect.objectContaining({ code: "membership_revision_mismatch" }));

    const queued = store.submitMessage(fixture.groupId, {
      ...base,
      sender: { kind: "operator", operatorId: "operator_1" },
      audience: { kind: "dm", memberId: "gamma" },
    });
    store.removeMembership(fixture.groupId, "gamma");
    expect(store.listDeliveries(queued.message.id)).toMatchObject([
      { recipientMemberId: "gamma", status: "revoked", reason: "membership_removed" },
    ]);
    expect(() =>
      store.submitMessage(fixture.groupId, {
        ...base,
        sender: { kind: "operator", operatorId: "operator_1" },
        audience: { kind: "dm", memberId: "gamma" },
      }),
    ).toThrowError(expect.objectContaining({ code: "recipient_not_active" }));
    expect(() =>
      store.submitMessage(fixture.groupId, {
        ...base,
        sender: { kind: "agent", memberId: "beta", runId: "run_alpha" },
        audience: { kind: "dm", memberId: "alpha" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_sender_run" }));
    store.close();
  });
});

describe("NanasaStore schema migration", () => {
  it("refuses schema 4 rather than migrating alpha state", () => {
    const legacyPath = join(mkdtempSync(join(tmpdir(), "nanasa-schema-4-")), "nanasa.sqlite");
    const oldSchema = new DatabaseSync(legacyPath);
    oldSchema.exec("CREATE TABLE legacy (id TEXT PRIMARY KEY) STRICT; PRAGMA user_version = 4");
    oldSchema.close();
    expect(() => new NanasaStore(legacyPath)).toThrowError(
      /Refusing to mutate old database schema 4/,
    );
    return;
    const directory = mkdtempSync(join(tmpdir(), "nanasa-terminal-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const sessionDirectory = join(directory, "pi");
    const sessionFile = join(sessionDirectory, "session.jsonl");
    mkdirSync(sessionDirectory);
    writeFileSync(sessionFile, '{"type":"session"}\n');

    const store = new NanasaStore(databasePath);
    const group = store.createGroup({ name: "Migration fixture" });
    const profile = store.createInternalAgentProfile(
      {
        name: "Legacy Pi",
        agentType: "pi",
        kind: "pi",
        command: "pi",
        args: [],
        environment: {},
      },
      "profile-key",
    );
    store.addMembership(group.id, {
      memberId: "worker",
      agentProfileId: profile.id,
      alias: "Worker",
    });
    const terminal = {
      serverName: "nanasa-test",
      sessionId: "nanasa-group",
      windowId: "@1",
      paneId: "%1",
    };
    store.createRun({
      id: "run_active",
      groupId: group.id,
      memberId: "worker",
      agentProfileId: profile.id,
      generation: 1,
      status: "running",
      desiredState: "running",
      recoveryPhase: "resuming",
      recoveryAttempts: 2,
      recoveryNotBefore: "2026-08-10T13:00:00.000Z",
      adapterSessionId: "active-session",
      adapterSession: {
        adapter: "pi-rpc",
        sessionId: "active-session",
        sessionFile,
        updatedAt: "2026-08-10T12:00:00.000Z",
      },
      terminal,
      startedAt: "2026-08-10T12:00:00.000Z",
    });
    store.createRun({
      id: "run_historical",
      groupId: group.id,
      memberId: "worker",
      agentProfileId: profile.id,
      generation: 2,
      status: "failed",
      desiredState: "stopped",
      recoveryPhase: "resuming",
      recoveryAttempts: 4,
      startedAt: "2026-08-10T12:30:00.000Z",
      stoppedAt: "2026-08-10T12:31:00.000Z",
    });
    const pending = store.submitMessage(group.id, {
      intent: "request",
      sender: { kind: "operator", operatorId: "operator" },
      audience: { kind: "dm", memberId: "worker" },
      body: { contentType: "text/plain", text: "Pending" },
      delivery: {},
      hop: 0,
    });
    const completed = store.submitMessage(group.id, {
      intent: "request",
      sender: { kind: "operator", operatorId: "operator" },
      audience: { kind: "dm", memberId: "worker" },
      body: { contentType: "text/plain", text: "Completed" },
      delivery: {},
      hop: 0,
    });
    const eventIds = store.listEvents().map((event) => event.id);
    store.close();

    const legacy = new DatabaseSync(databasePath);
    legacy
      .prepare(
        "UPDATE agent_profiles SET adapter = 'pi-rpc', capabilities_json = '[\"queue\",\"steer\"]' WHERE id = ?",
      )
      .run(profile.id);
    legacy
      .prepare(
        `UPDATE runs
         SET recovery_phase = 'resuming', recovery_attempts = 2,
             recovery_not_before = '2026-08-10T13:00:00.000Z',
             adapter_session_id = 'active-session',
             adapter_session_json = ?
         WHERE id = 'run_active'`,
      )
      .run(
        JSON.stringify({
          adapter: "pi-rpc",
          sessionId: "active-session",
          sessionFile,
          updatedAt: "2026-08-10T12:00:00.000Z",
        }),
      );
    legacy.prepare("UPDATE runs SET recovery_phase = 'resuming' WHERE id = 'run_historical'").run();
    legacy
      .prepare(
        `UPDATE deliveries
         SET requested_mode = 'steer', applied_mode = 'steer', fallback_applied = 0,
             status = 'delivering', adapter = 'pi-rpc',
             adapter_session_id = 'pending-session', adapter_message_id = 'pending-message',
             lease_owner = 'legacy-worker', lease_expires_at = '2099-01-01T00:00:00.000Z',
             next_attempt_at = '2099-01-01T00:00:00.000Z',
             run_id = 'run_active', run_generation = 1
         WHERE message_id = ?`,
      )
      .run(pending.message.id);
    legacy
      .prepare(
        `UPDATE deliveries
         SET requested_mode = 'queue', applied_mode = 'steer', fallback_applied = 1,
             status = 'processed', adapter = 'pi-rpc',
             adapter_session_id = 'completed-session', adapter_message_id = 'completed-message'
         WHERE message_id = ?`,
      )
      .run(completed.message.id);
    legacy
      .prepare(
        `UPDATE idempotency_keys
         SET response_json = json_set(
           response_json,
           '$.adapter', 'pi-rpc',
           '$.capabilities', json('["queue","steer"]')
         )
         WHERE scope = 'agent-profile.create' AND key = 'profile-key'`,
      )
      .run();
    legacy.exec("PRAGMA user_version = 0");
    legacy.close();

    const migrated = new NanasaStore(databasePath);
    const snapshot = migrated.getSnapshot();
    expect(snapshot.groups.map((item) => item.id)).toEqual([group.id]);
    expect(snapshot.agentProfiles.map((item) => item.id)).toEqual([profile.id]);
    expect(snapshot.agentProfiles[0]).not.toHaveProperty("adapter");
    expect(snapshot.agentProfiles[0]).not.toHaveProperty("capabilities");
    expect(snapshot.runs.find((run) => run.id === "run_active")).toMatchObject({
      generation: 1,
      recoveryPhase: "reconciling",
      recoveryAttempts: 0,
      recoveryReason: "terminal_runtime_migration",
      terminal,
    });
    expect(snapshot.runs.find((run) => run.id === "run_active")).not.toHaveProperty(
      "adapterSession",
    );
    expect(snapshot.runs.find((run) => run.id === "run_historical")).toMatchObject({
      generation: 2,
      recoveryPhase: "restarting",
    });
    expect(snapshot.deliveryOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: pending.message.id, status: "queued" }),
        expect.objectContaining({ messageId: completed.message.id, status: "processed" }),
      ]),
    );
    expect(snapshot.deliveryOutcomes[0]).not.toHaveProperty("requestedMode");
    expect(migrated.listEvents().map((event) => event.id)).toEqual(eventIds);
    expect(
      migrated.createInternalAgentProfile(
        {
          name: "Legacy Pi",
          agentType: "pi",
          kind: "pi",
          command: "pi",
          args: [],
          environment: {},
        },
        "profile-key",
      ),
    ).not.toHaveProperty("adapter");
    migrated.close();

    const inspected = new DatabaseSync(databasePath);
    expect(
      (inspected.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(4);
    expect(
      inspected
        .prepare("PRAGMA table_info(memberships)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toContain("role_id");
    expect(
      inspected
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'agent_status_events', 'agent_status_current', 'agent_task_reports'
           )
           ORDER BY name`,
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["agent_status_current", "agent_status_events", "agent_task_reports"]);
    expect(
      inspected
        .prepare("SELECT adapter, capabilities_json FROM agent_profiles WHERE id = ?")
        .get(profile.id),
    ).toEqual({ adapter: "terminal", capabilities_json: "[]" });
    expect(
      inspected.prepare("SELECT * FROM deliveries WHERE message_id = ?").get(pending.message.id),
    ).toMatchObject({
      requested_mode: "terminal",
      applied_mode: "terminal",
      fallback_applied: 0,
      status: "queued",
      adapter: "terminal",
      adapter_session_id: null,
      adapter_message_id: null,
      lease_owner: null,
      lease_expires_at: null,
      next_attempt_at: null,
      run_id: null,
      run_generation: null,
    });
    expect(
      inspected.prepare("SELECT * FROM deliveries WHERE message_id = ?").get(completed.message.id),
    ).toMatchObject({
      requested_mode: "queue",
      applied_mode: "steer",
      fallback_applied: 1,
      status: "processed",
      adapter: "pi-rpc",
      adapter_session_id: "completed-session",
      adapter_message_id: "completed-message",
    });
    inspected.prepare("UPDATE runs SET recovery_attempts = 2 WHERE id = 'run_active'").run();
    inspected.close();

    const reopened = new NanasaStore(databasePath);
    expect(reopened.getRun("run_active").recoveryAttempts).toBe(2);
    reopened.close();
    expect(existsSync(sessionFile)).toBe(true);
  });

  it("refuses future schemas for mutation", () => {
    const futurePath = join(mkdtempSync(join(tmpdir(), "nanasa-schema-future-")), "nanasa.sqlite");
    const future = new DatabaseSync(futurePath);
    future.exec("CREATE TABLE future (id TEXT PRIMARY KEY) STRICT; PRAGMA user_version = 999");
    future.close();
    expect(() => new NanasaStore(futurePath)).toThrowError(
      /Refusing to mutate future database schema 999/,
    );
    return;
    const directory = mkdtempSync(join(tmpdir(), "nanasa-copilot-adapter-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);
    const profile = store.createInternalAgentProfile({
      name: "Historical Copilot",
      agentType: "copilot",
      kind: "copilot",
      command: "copilot",
      args: [],
      environment: {},
    });
    store.close();

    const historical = new DatabaseSync(databasePath);
    historical
      .prepare("UPDATE agent_profiles SET adapter = ?, capabilities_json = ? WHERE id = ?")
      .run("copilot-sdk", '["queue","steer"]', profile.id);
    historical.close();

    const migrated = new NanasaStore(databasePath);
    const migratedProfile = migrated.getAgentProfile(profile.id);
    expect(migratedProfile).toBeDefined();
    expect(migratedProfile).not.toHaveProperty("adapter");
    expect(migratedProfile).not.toHaveProperty("capabilities");
    migrated.close();
  });

  it("refuses unversioned nonempty databases", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-schema-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        working_directory TEXT,
        environment_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        agent_profile_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        adapter_session_id TEXT,
        terminal_json TEXT,
        started_at TEXT NOT NULL,
        stopped_at TEXT
      ) STRICT;
      CREATE TABLE deliveries (
        message_id TEXT NOT NULL,
        recipient_member_id TEXT NOT NULL,
        requested_mode TEXT NOT NULL,
        applied_mode TEXT,
        fallback_applied INTEGER NOT NULL,
        reason TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, recipient_member_id)
      ) STRICT;
      INSERT INTO agent_profiles
        (id, name, kind, command, args_json, working_directory, environment_json,
         created_at, updated_at)
      VALUES
        ('legacy_claude', 'Claude via Copilot', 'claude-code', 'make', '["claude-copilot"]',
         NULL, '{}', '2026-08-09T15:00:00Z', '2026-08-09T15:00:00Z');
    `);
    legacy.close();

    expect(() => new NanasaStore(databasePath)).toThrowError(
      /Refusing to mutate old database schema 0/,
    );
    return;
    const store = new NanasaStore(databasePath);
    expect(store.getAgentProfile("legacy_claude")).toMatchObject({
      id: "legacy_claude",
      agentType: "claude-copilot",
    });
    expect(store.getAgentProfile("legacy_claude")).not.toHaveProperty("adapter");
    expect(store.getAgentProfile("legacy_claude")).not.toHaveProperty("capabilities");
    expect(store.getSnapshot().agentProfiles).toEqual([]);
    store.close();

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    const columnNames = (table: string) =>
      (migrated.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
    expect(columnNames("runs")).toEqual(
      expect.arrayContaining([
        "desired_state",
        "recovery_phase",
        "recovery_attempts",
        "recovery_not_before",
        "recovery_reason",
        "adapter_session_json",
      ]),
    );
    expect(columnNames("deliveries")).toEqual(
      expect.arrayContaining([
        "adapter",
        "adapter_session_id",
        "adapter_message_id",
        "lease_owner",
        "lease_expires_at",
        "next_attempt_at",
        "run_id",
        "run_generation",
      ]),
    );
    migrated.close();
  });

  it("reopens the cohesive baseline idempotently", () => {
    const baselineDirectory = mkdtempSync(join(tmpdir(), "nanasa-baseline-reopen-"));
    const baselinePath = join(baselineDirectory, "nanasa.sqlite");
    new NanasaStore(baselinePath).close();
    new NanasaStore(baselinePath).close();
    const baseline = new DatabaseSync(baselinePath, { readOnly: true });
    expect(
      (baseline.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(5);
    baseline.close();
    return;
    const directory = mkdtempSync(join(tmpdir(), "nanasa-delivery-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);
    const group = store.createGroup({ name: "Legacy delivery" });
    const profile = store.createInternalAgentProfile({
      name: "Legacy",
      agentType: "opencode",
      kind: "opencode",
      command: "opencode",
      args: [],
      environment: {},
    });
    const member = store.addMembership(group.id, {
      memberId: "legacy",
      agentProfileId: profile.id,
      alias: "Legacy",
    });
    const submission = store.submitMessage(group.id, {
      intent: "request",
      sender: { kind: "operator", operatorId: "operator" },
      audience: { kind: "dm", memberId: member.memberId },
      body: { contentType: "text/plain", text: "Historical" },
      delivery: {},
      hop: 0,
    });
    store.close();

    const legacy = new DatabaseSync(databasePath);
    legacy
      .prepare("UPDATE messages SET delivery_json = ? WHERE id = ?")
      .run('{"mode":"inbox","fallback":"terminal"}', submission.message.id);
    legacy
      .prepare(
        "UPDATE deliveries SET requested_mode = 'interrupt', applied_mode = 'terminal' WHERE message_id = ?",
      )
      .run(submission.message.id);
    legacy.close();

    const reopened = new NanasaStore(databasePath);
    expect(reopened.getSnapshot()).toMatchObject({
      messages: [{ delivery: {} }],
      deliveryOutcomes: [{ status: "queued" }],
    });
    expect(reopened.getSnapshot().deliveryOutcomes[0]).not.toHaveProperty("requestedMode");
    expect(reopened.getSnapshot().deliveryOutcomes[0]).not.toHaveProperty("appliedMode");
    reopened.close();
  });
});
