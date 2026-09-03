import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NanasaConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { DATABASE_SCHEMA_VERSION } from "../src/persistence/schema.js";
import { NanasaStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("NanasaStore persistence", () => {
  it("persists isolated Attention subscription overrides across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-attention-subscriptions-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);
    const group = store.createGroup({ name: "Team" });
    const profile = store.createInternalAgentProfile({
      name: "Builder",
      agentType: "copilot",
      kind: "copilot",
      command: "copilot",
      args: [],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "builder",
      agentProfileId: profile.id,
      alias: "Builder",
    });

    expect(
      store.setAttentionSubscription("operator_1", group.id, "builder", "completion", false),
    ).toMatchObject({
      subscriptions: expect.arrayContaining([
        { eventType: "completion", enabled: false, source: "operator-override" },
      ]),
    });
    expect(store.listAttentionSubscriptions("operator_2").members[0]?.subscriptions).toEqual(
      expect.arrayContaining([
        { eventType: "completion", enabled: true, source: "repository-default" },
      ]),
    );
    store.close();

    const reopened = new NanasaStore(databasePath);
    expect(reopened.listAttentionSubscriptions("operator_1").members[0]?.subscriptions).toEqual(
      expect.arrayContaining([
        { eventType: "completion", enabled: false, source: "operator-override" },
      ]),
    );
    expect(
      reopened.resetAttentionSubscriptions("operator_1", group.id, "builder").subscriptions,
    ).toEqual(
      expect.arrayContaining([
        { eventType: "completion", enabled: true, source: "repository-default" },
      ]),
    );
    reopened.close();
  });

  it("persists attention dismissals by operator across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-attention-dismissals-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);

    expect(store.dismissAttentionItems("operator_1", ["attention:health|run:1"])).toEqual([
      expect.objectContaining({ itemId: "attention:health|run:1" }),
    ]);
    expect(store.listAttentionDismissals("operator_2")).toEqual([]);
    store.close();

    const reopened = new NanasaStore(databasePath);
    expect(reopened.listAttentionDismissals("operator_1")).toEqual([
      expect.objectContaining({ itemId: "attention:health|run:1" }),
    ]);
    reopened.close();
  });

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
          commandSource: "custom",
          launcher: { providerArguments: "append" },
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
    expect(
      reopened.transitionRunRecovery(run.id, run.generation, "recovered").recoveryNotBefore,
    ).toBeUndefined();
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
          commandSource: "builtin",
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
describe("NanasaStore HTTP idempotency transactions", () => {
  it("rolls back reservation and SQLite domain mutation after a killed process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-idempotency-kill-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    new NanasaStore(databasePath).close();
    const moduleUrl = new URL("../src/store.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { NanasaStore } from ${JSON.stringify(moduleUrl)};
const store = new NanasaStore(${JSON.stringify(databasePath)});
store.executeHttpIdempotency(
  { principalId: "operator", routeId: "groups.create", key: "killed", requestDigest: "digest" },
  () => {
    store.createGroup({ name: "Must roll back" });
    process.stdout.write("transaction-open\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return { statusCode: 201, response: {} };
  },
);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");

    const reopened = new NanasaStore(databasePath);
    expect(reopened.getSnapshot().groups).toEqual([]);
    expect(
      reopened.executeHttpIdempotency(
        {
          principalId: "operator",
          routeId: "groups.create",
          key: "killed",
          requestDigest: "digest",
        },
        () => {
          const group = reopened.createGroup({ name: "Committed" });
          return { statusCode: 201, response: group };
        },
      ),
    ).toMatchObject({ kind: "executed", statusCode: 201 });
    expect(reopened.getSnapshot().groups).toHaveLength(1);
    reopened.close();
  });

  it("never expires an uncertain stale reservation into re-execution", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-idempotency-stale-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);
    const input = {
      principalId: "operator",
      routeId: "external.effect",
      key: "uncertain",
      requestDigest: "digest",
      now: new Date("2026-08-30T00:00:00.000Z"),
      inProgressTtlMs: 1,
    };
    expect(store.claimHttpIdempotency(input)).toEqual({ kind: "execute" });
    store.close();
    const reopened = new NanasaStore(databasePath);
    expect(() =>
      reopened.claimHttpIdempotency({
        ...input,
        now: new Date("2026-09-30T00:00:00.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "idempotency_outcome_uncertain" }));
    reopened.close();
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

  it("derives causal depth, validates visibility, and rejects repeated actor-audience cycles", () => {
    const store = new NanasaStore(":memory:");
    const fixture = createRoutingFixture(store);
    store.createRun({
      id: "run_beta",
      groupId: fixture.groupId,
      memberId: "beta",
      agentProfileId: fixture.profileId,
      generation: 1,
      status: "running",
      startedAt: "2026-08-29T12:00:00.000Z",
    });
    const common = {
      body: { contentType: "text/plain" as const, text: "Coordinate" },
      delivery: {},
    };
    const root = store.submitMessage(fixture.groupId, {
      ...common,
      intent: "request",
      sender: { kind: "operator", operatorId: "operator" },
      audience: { kind: "dm", memberId: "alpha" },
    });
    const alpha = store.submitMessage(fixture.groupId, {
      ...common,
      intent: "response",
      sender: { kind: "agent", memberId: "alpha", runId: "run_alpha" },
      audience: { kind: "dm", memberId: "beta" },
      replyTo: root.message.id,
      causationId: root.message.id,
    });
    expect(alpha.message).toMatchObject({
      conversationId: root.message.conversationId,
      rootId: root.message.id,
      hop: 1,
    });
    const beta = store.submitMessage(fixture.groupId, {
      ...common,
      intent: "response",
      sender: { kind: "agent", memberId: "beta", runId: "run_beta" },
      audience: { kind: "dm", memberId: "alpha" },
      causationId: alpha.message.id,
    });
    expect(beta.message.hop).toBe(2);
    expect(() =>
      store.submitMessage(fixture.groupId, {
        ...common,
        intent: "response",
        sender: { kind: "agent", memberId: "alpha", runId: "run_alpha" },
        audience: { kind: "dm", memberId: "beta" },
        causationId: beta.message.id,
      }),
    ).toThrowError(expect.objectContaining({ code: "message_causal_cycle" }));
    expect(() =>
      store.submitMessage(fixture.groupId, {
        ...common,
        intent: "response",
        sender: { kind: "agent", memberId: "beta", runId: "run_beta" },
        audience: { kind: "dm", memberId: "gamma" },
        replyTo: root.message.id,
      }),
    ).toThrowError(expect.objectContaining({ code: "message_causation_forbidden" }));
    store.close();
  });

  it("enforces automated reply and fan-out budgets on the server", () => {
    const store = new NanasaStore(":memory:");
    const fixture = createRoutingFixture(store);
    for (let index = 0; index < 33; index += 1) {
      store.addMembership(fixture.groupId, {
        memberId: `fanout-${index}`,
        agentProfileId: fixture.profileId,
        alias: `Fanout ${index}`,
      });
    }
    expect(() =>
      store.submitMessage(fixture.groupId, {
        intent: "inform",
        sender: { kind: "operator", operatorId: "operator" },
        audience: {
          kind: "group",
          membershipRevision: store.getGroup(fixture.groupId).membershipRevision,
        },
        body: { contentType: "text/plain", text: "Too many recipients" },
        delivery: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "message_fan_out_exceeded" }));

    for (let index = 0; index < 16; index += 1) {
      store.submitMessage(fixture.groupId, {
        conversationId: "conversation-budget",
        intent: "inform",
        sender: { kind: "agent", memberId: "alpha", runId: "run_alpha" },
        audience: { kind: "dm", memberId: `fanout-${index}` },
        body: { contentType: "text/plain", text: `Automated ${index}` },
        delivery: {},
      });
    }
    expect(() =>
      store.submitMessage(fixture.groupId, {
        conversationId: "conversation-budget",
        intent: "inform",
        sender: { kind: "agent", memberId: "alpha", runId: "run_alpha" },
        audience: { kind: "dm", memberId: "fanout-16" },
        body: { contentType: "text/plain", text: "One too many" },
        delivery: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "message_automated_reply_budget_exhausted" }));
    store.close();
  });
});

describe("NanasaStore schema compatibility", () => {
  it("refuses old schemas", () => {
    const path = join(mkdtempSync(join(tmpdir(), "nanasa-schema-old-")), "nanasa.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE old_state (id TEXT PRIMARY KEY) STRICT; PRAGMA user_version = 4");
    database.close();
    expect(() => new NanasaStore(path)).toThrow(/Refusing to mutate old database schema 4/);
  });

  it("refuses future schemas", () => {
    const path = join(mkdtempSync(join(tmpdir(), "nanasa-schema-future-")), "nanasa.sqlite");
    const database = new DatabaseSync(path);
    database.exec(
      "CREATE TABLE future_state (id TEXT PRIMARY KEY) STRICT; PRAGMA user_version = 999",
    );
    database.close();
    expect(() => new NanasaStore(path)).toThrow(/Refusing to mutate future database schema 999/);
  });

  it("refuses unversioned nonempty databases", () => {
    const path = join(mkdtempSync(join(tmpdir(), "nanasa-schema-unversioned-")), "nanasa.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE unknown_state (id TEXT PRIMARY KEY) STRICT");
    database.close();
    expect(() => new NanasaStore(path)).toThrow(/Refusing to mutate old database schema 0/);
  });

  it("reopens the current baseline without mutation", () => {
    const path = join(mkdtempSync(join(tmpdir(), "nanasa-schema-current-")), "nanasa.sqlite");
    new NanasaStore(path).close();
    new NanasaStore(path).close();
    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(DATABASE_SCHEMA_VERSION);
    database.close();
  });
});
