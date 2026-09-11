import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NanasaConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { MissionRepository } from "../src/mission-repository.js";
import { NanasaStore } from "../src/store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nanasa-missions-"));
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
    roles: { engineer: { name: "Engineer" } },
    teamTemplates: {
      build: { members: { engineer: { integrationId: "copilot", roleId: "engineer" } } },
    },
    foreman: {
      integrationId: "copilot",
      enabled: true,
      autonomy: { mode: "bounded", permittedTeamTemplates: ["build"], maxActiveMissions: 2 },
    },
    groups: {},
  });
  let clock = new Date("2026-09-11T00:00:00Z");
  const repository = new MissionRepository(
    store,
    () => config,
    () => clock,
  );
  const profile = store.createInternalAgentProfile({
    name: "Foreman",
    agentType: "copilot",
    kind: "copilot",
    command: "copilot",
    args: [],
    environment: {},
  });
  store.upsertForeman({ id: "repository-foreman", agentProfileId: profile.id, enabled: true });
  const run = store.createRunForForeman("repository-foreman").run;
  const principal = {
    kind: "foreman" as const,
    foremanId: run.foremanId,
    runId: run.id,
    generation: run.generation,
    authorityRevision: 0,
  };
  const command = {
    requestId: "mission-one",
    title: "Build a feature",
    objective: "Implement the bounded feature",
    acceptance: ["Tests pass", "Review passes"],
    grant: config.foreman!.autonomy,
  };
  const task = {
    requestId: "task-one",
    expectedGrantRevision: 1,
    title: "Implementation",
    instructions: "Implement the feature and tests",
    roleId: "engineer",
    templateId: "build",
    dependencies: [],
    acceptanceIndexes: [0],
  };
  return {
    repository,
    store,
    config,
    principal,
    command,
    task,
    path,
    setClock: (value: Date) => {
      clock = value;
    },
  };
}

describe("durable mission authority", () => {
  it("requires exact operator decisions in supervised mode and fences approved work on pause", () => {
    const context = fixture();
    const mission = context.repository.create("human", {
      ...context.command,
      grant: { ...context.command.grant, mode: "supervised" },
    });
    const running = context.repository.control("human", mission.id, {
      expectedRevision: 0,
      action: "start",
    });
    expect(
      context.repository.requestApproval(running, "task", "task-one", "Execute task one"),
    ).toBe(false);
    const approval = context.repository.approvals(mission.id)[0]!;
    context.repository.decideApproval("human", approval.id, {
      expectedGrantRevision: running.grantRevision,
      decision: "approved",
    });
    expect(
      context.repository.requestApproval(running, "task", "task-one", "Execute task one"),
    ).toBe(true);
    expect(
      context.repository.requestApproval(running, "task", "task-two", "Execute task two"),
    ).toBe(false);
    const paused = context.repository.control("human", mission.id, {
      expectedRevision: running.revision,
      action: "pause",
    });
    const resumed = context.repository.control("human", mission.id, {
      expectedRevision: paused.revision,
      action: "resume",
    });
    expect(
      context.repository.requestApproval(resumed, "task", "task-one", "Execute task one"),
    ).toBe(false);
    expect(() =>
      context.repository.decideApproval("human", approval.id, {
        expectedGrantRevision: running.grantRevision,
        decision: "approved",
      }),
    ).toThrow("no longer matches");
  });

  it("deduplicates durable due reviews and accounts for turns only at write intent", () => {
    const context = fixture();
    const mission = context.repository.create("human", context.command);
    const running = context.repository.control("human", mission.id, {
      expectedRevision: 0,
      action: "start",
    });
    context.repository.queueDueReviews();
    context.repository.queueDueReviews();
    const rows = context.store.database
      .prepare("SELECT * FROM foreman_inbox WHERE mission_id = ?")
      .all(mission.id);
    expect(rows).toHaveLength(1);
    expect(context.repository.get(mission.id).turnsUsed).toBe(0);
    const inboxId = String(rows[0]!.id);
    const target = { runId: context.principal.runId, generation: context.principal.generation };
    expect(context.repository.claimReview(context.principal, mission.id, inboxId, target)).toBe(
      true,
    );
    expect(context.repository.claimReview(context.principal, mission.id, inboxId, target)).toBe(
      false,
    );
    expect(context.repository.get(mission.id).turnsUsed).toBe(1);
    context.repository.finishReview(context.principal, mission.id, running.grantRevision);
    expect(
      context.store.database.prepare("SELECT state FROM foreman_inbox WHERE id = ?").get(inboxId)
        ?.state,
    ).toBe("answered");
    context.setClock(new Date("2026-09-11T00:10:00Z"));
    context.repository.queueDueReviews();
    const paused = context.repository.control("human", mission.id, {
      expectedRevision: running.revision,
      action: "pause",
    });
    expect(paused.state).toBe("paused");
    expect(
      context.store.database
        .prepare("SELECT COUNT(*) AS count FROM foreman_inbox WHERE state = 'queued'")
        .get()?.count,
    ).toBe(0);
  });

  it("persists immutable acceptance and grant, and rejects request reuse and expanded authority", () => {
    const context = fixture();
    const mission = context.repository.create("human", context.command);
    expect(context.repository.create("human", context.command)).toEqual(mission);
    expect(() =>
      context.repository.create("human", { ...context.command, objective: "Changed" }),
    ).toThrow("different content");
    expect(() =>
      context.repository.create("human", {
        ...context.command,
        requestId: "expanded",
        grant: { ...context.command.grant, maxConcurrentTasks: 32 },
      }),
    ).toThrow("exceeds repository");
    expect(() =>
      context.repository.control("human", mission.id, { expectedRevision: 0, action: "accept" }),
    ).toThrow("evidence");
    const reopened = new NanasaStore(context.path);
    try {
      expect(new MissionRepository(reopened, () => context.config).get(mission.id)).toEqual(
        mission,
      );
    } finally {
      reopened.close();
    }
  });

  it("fences pause, resume, revoke, expiry, and replaced Foreman identities", () => {
    const context = fixture();
    const mission = context.repository.create("human", context.command);
    const paused = context.repository.control("human", mission.id, {
      expectedRevision: 0,
      action: "pause",
    });
    expect(() =>
      context.repository.createTask(context.principal, mission.id, context.task),
    ).toThrow("grant changed");
    expect(() =>
      context.repository.control("human", mission.id, { expectedRevision: 0, action: "resume" }),
    ).toThrow("Mission changed");
    const resumed = context.repository.control("human", mission.id, {
      expectedRevision: paused.revision,
      action: "resume",
    });
    const task = context.repository.createTask(context.principal, mission.id, {
      ...context.task,
      expectedGrantRevision: resumed.grantRevision,
    });
    expect(task.state).toBe("queued");
    context.setClock(new Date(mission.expiresAt));
    expect(() =>
      context.repository.createTask(context.principal, mission.id, {
        ...context.task,
        requestId: "expired",
        expectedGrantRevision: resumed.grantRevision,
      }),
    ).toThrow("expired");
    const revoked = context.repository.control("human", mission.id, {
      expectedRevision: resumed.revision,
      action: "revoke",
    });
    expect(revoked.state).toBe("revoked");
    expect(context.repository.workspace(mission.id).tasks[0]?.state).toBe("cancelled");
    context.store.updateRuntimeRunStatus(context.principal.runId, "failed");
    expect(() =>
      context.repository.assertForeman(context.principal, mission.id, revoked.grantRevision),
    ).toThrow("not current");
  });

  it("restricts task roles and dependencies to the grant and immutable prior tasks", () => {
    const context = fixture();
    const mission = context.repository.create("human", context.command);
    const first = context.repository.createTask(context.principal, mission.id, context.task);
    expect(context.repository.createTask(context.principal, mission.id, context.task)).toEqual(
      first,
    );
    expect(() =>
      context.repository.createTask(context.principal, mission.id, {
        ...context.task,
        title: "changed",
      }),
    ).toThrow("different content");
    expect(() =>
      context.repository.createTask(context.principal, mission.id, {
        ...context.task,
        requestId: "role",
        roleId: "admin",
      }),
    ).toThrow("approved template");
    expect(() =>
      context.repository.createTask(context.principal, mission.id, {
        ...context.task,
        requestId: "acceptance",
        acceptanceIndexes: [2],
      }),
    ).toThrow("existing acceptance");
    expect(() =>
      context.repository.createTask(context.principal, mission.id, {
        ...context.task,
        requestId: "future",
        dependencies: ["future-task"],
      }),
    ).toThrow("prior tasks");
    const other = context.repository.create("human", { ...context.command, requestId: "other" });
    expect(() =>
      context.repository.createTask(context.principal, other.id, {
        ...context.task,
        dependencies: [first.id],
      }),
    ).toThrow("prior tasks");
    const second = context.repository.createTask(context.principal, mission.id, {
      ...context.task,
      requestId: "task-two",
      dependencies: [first.id],
      acceptanceIndexes: [1],
    });
    expect(second.dependencies).toEqual([first.id]);
    expect(() =>
      context.repository.create("human", { ...context.command, requestId: "too-many" }),
    ).toThrow("limit reached");
  });
});
