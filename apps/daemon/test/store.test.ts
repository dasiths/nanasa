import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      adapter: "copilot-cli",
      capabilities: ["queue"],
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
      delivery: { mode: "steer" },
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

  it("persists Pi session identity and replays worker settlement after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-pi-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const sessionFile = join(directory, ".nanasa", "state", "pi", "session.jsonl");
    const store = new NanasaStore(databasePath);
    const group = store.createGroup({ name: "Pi persistence" });
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
    const membership = store.addMembership(group.id, {
      memberId: "pi-worker",
      agentProfileId: profile.id,
      alias: "Pi",
    });
    const run = store.createRun({
      id: "run_pi",
      groupId: group.id,
      memberId: membership.memberId,
      agentProfileId: profile.id,
      generation: 2,
      status: "running",
      startedAt: "2026-08-10T12:00:00.000Z",
    });
    const submission = store.submitMessage(group.id, {
      intent: "request",
      sender: { kind: "operator", operatorId: "operator" },
      audience: { kind: "dm", memberId: membership.memberId },
      body: { contentType: "text/plain", text: "Continue." },
      delivery: { mode: "queue" },
      hop: 0,
    });
    const claim = store.claimDeliveries({
      owner: "test",
      now: new Date("2026-08-10T12:00:01.000Z"),
      leaseMs: 30_000,
      limit: 1,
    })[0]!;
    expect(store.beginDelivery(claim, "test", "queue", false)).toBe(true);
    expect(
      store.markDeliveryConsumed(claim, "test", {
        adapterSessionId: "session-persisted",
        adapterMessageId: submission.message.id,
      }),
    ).toBe(true);
    store.updateRunAdapterSession(run.id, run.generation, {
      adapterSessionId: "session-persisted",
      sessionFile,
    });
    store.close();

    const reopened = new NanasaStore(databasePath);
    expect(reopened.getRun(run.id)).toMatchObject({
      adapterSessionId: "session-persisted",
      adapterSession: {
        adapter: "pi-rpc",
        sessionId: "session-persisted",
        sessionFile,
      },
    });
    expect(reopened.settleRunDeliveries(run.id, run.generation, [submission.message.id])).toBe(1);
    expect(reopened.listDeliveries(submission.message.id)).toMatchObject([
      { status: "processed", adapterMessageId: submission.message.id },
    ]);
    expect(reopened.listEvents().map((event) => event.type)).toContain(
      "run.adapter-session-changed",
    );
    expect(reopened.listEvents().map((event) => event.type)).toContain("delivery.adapter-settled");
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
});

function createRoutingFixture(store: NanasaStore) {
  const group = store.createGroup({ name: "Builders" });
  const profile = store.createInternalAgentProfile({
    name: "Builder",
    agentType: "opencode",
    kind: "opencode",
    adapter: "terminal",
    capabilities: ["queue"],
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
      delivery: { mode: "queue" as const },
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
      delivery: { mode: "steer" },
    });

    expect(direct.deliveryOutcomes.map((outcome) => outcome.recipientMemberId)).toEqual(["alpha"]);
    expect(multicast.deliveryOutcomes.map((outcome) => outcome.recipientMemberId)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(broadcast.deliveryOutcomes).toMatchObject([
      {
        recipientMemberId: "beta",
        requestedMode: "steer",
        appliedMode: "queue",
        fallbackApplied: true,
        reason: "requested_mode_not_supported",
        adapter: "terminal",
      },
      {
        recipientMemberId: "gamma",
        requestedMode: "steer",
        appliedMode: "queue",
        fallbackApplied: true,
        reason: "requested_mode_not_supported",
        adapter: "terminal",
      },
    ]);

    const terminal = store.submitMessage(fixture.groupId, {
      ...common,
      sender: operator,
      audience: { kind: "multicast", memberIds: ["alpha", "beta"] },
      delivery: { mode: "terminal" },
    });
    expect(terminal.deliveryOutcomes).toMatchObject([
      {
        requestedMode: "terminal",
        appliedMode: "terminal",
        fallbackApplied: false,
        adapter: "terminal",
      },
      {
        requestedMode: "terminal",
        appliedMode: "terminal",
        fallbackApplied: false,
        adapter: "terminal",
      },
    ]);

    const agentTerminalBroadcast = store.submitMessage(fixture.groupId, {
      ...common,
      sender: { kind: "agent", memberId: "alpha", runId: "run_alpha" },
      audience: { kind: "group", membershipRevision: 3 },
      delivery: { mode: "terminal" },
    });
    expect(agentTerminalBroadcast.deliveryOutcomes).toMatchObject([
      {
        recipientMemberId: "beta",
        requestedMode: "terminal",
        appliedMode: "terminal",
        fallbackApplied: false,
      },
      {
        recipientMemberId: "gamma",
        requestedMode: "terminal",
        appliedMode: "terminal",
        fallbackApplied: false,
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
      delivery: { mode: "queue" as const },
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
  it("migrates persisted Copilot SDK adapter rows to queue-only Copilot CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-copilot-adapter-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);
    const profile = store.createInternalAgentProfile({
      name: "Historical Copilot",
      agentType: "copilot",
      kind: "copilot",
      adapter: "copilot-cli",
      capabilities: ["queue"],
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
    expect(migrated.getAgentProfile(profile.id)).toMatchObject({
      adapter: "copilot-cli",
      capabilities: ["queue"],
    });
    migrated.close();
  });

  it("infers configured profile metadata for legacy rows", () => {
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

    const store = new NanasaStore(databasePath);
    expect(store.getSnapshot().agentProfiles).toMatchObject([
      {
        id: "legacy_claude",
        agentType: "claude-copilot",
        adapter: "terminal",
        capabilities: ["queue"],
      },
    ]);
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

  it("normalizes historical delivery modes when hydrating portal state", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-delivery-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const store = new NanasaStore(databasePath);
    const group = store.createGroup({ name: "Legacy delivery" });
    const profile = store.createInternalAgentProfile({
      name: "Legacy",
      agentType: "opencode",
      kind: "opencode",
      adapter: "terminal",
      capabilities: ["queue"],
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
      delivery: { mode: "queue" },
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
      messages: [{ delivery: { mode: "queue" } }],
      deliveryOutcomes: [{ requestedMode: "steer", appliedMode: "terminal" }],
    });
    reopened.close();
  });
});
