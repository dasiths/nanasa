import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NanasaConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AgentActionService } from "../src/actions/agent-action-service.js";
import { PeerCapabilityPolicy } from "../src/actions/peer-capability-policy.js";
import { ConfigRepository } from "../src/config-repository.js";
import { CheckoutService } from "../src/git/checkout-service.js";
import { GitCommandAdapter } from "../src/git/git-command-adapter.js";
import { GitStatusService } from "../src/git/git-status-service.js";
import { RepositoryDiscoveryService } from "../src/git/repository-discovery-service.js";
import { safeWorktreeSlug, WorktreeService } from "../src/git/worktree-service.js";
import { MissionRepository } from "../src/mission-repository.js";
import { MissionTaskScheduler } from "../src/mission-task-scheduler.js";
import { MissionTeamService, runtimeMissionGroups } from "../src/mission-team-service.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { NanasaStore } from "../src/store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nanasa-worktree-"));
  directories.push(root);
  const repository = join(root, "repository");
  const managedRoot = join(root, "managed");
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync(
    "git",
    [
      "-C",
      repository,
      "-c",
      "user.name=Nanasa Test",
      "-c",
      "user.email=nanasa@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { stdio: "ignore" },
  );
  const store = new NanasaStore(":memory:");
  const git = new GitCommandAdapter();
  const discovery = new RepositoryDiscoveryService(git);
  const checkouts = new CheckoutService(store, discovery, new GitStatusService(git));
  const worktrees = new WorktreeService(store, git, checkouts, managedRoot);
  return { root, repository, managedRoot, store, git, checkouts, worktrees };
}

describe("managed worktree ownership", () => {
  it("provisions an owned mission team without rewriting authored groups and preserves it on reload", async () => {
    const context = fixture();
    try {
      const source = (await context.checkouts.initialize(context.repository)).checkout;
      mkdirSync(join(context.repository, ".nanasa"));
      const path = join(context.repository, ".nanasa", "config.yaml");
      const authored = `version: 2
integrations:
  copilot:
    name: Copilot
    kind: copilot
roles:
  engineer:
    name: Engineer
teamTemplates:
  build:
    members:
      engineer:
        integrationId: copilot
        roleId: engineer
foreman:
  integrationId: copilot
  enabled: true
  autonomy:
    mode: bounded
    permittedTeamTemplates: [build]
groups: {}
`;
      writeFileSync(path, authored);
      const config = new ConfigRepository(context.repository, () =>
        runtimeMissionGroups(context.store),
      );
      const missions = new MissionRepository(context.store, () => config.load().config);
      const mission = missions.create("human", {
        requestId: "mission",
        title: "Build",
        objective: "Build a tested feature",
        acceptance: ["Tests pass"],
        grant: config.load().config.foreman!.autonomy,
      });
      const running = missions.control("human", mission.id, {
        expectedRevision: 0,
        action: "start",
      });
      const profile = context.store.createInternalAgentProfile({
        name: "Foreman",
        agentType: "copilot",
        kind: "copilot",
        command: "copilot",
        args: [],
        environment: {},
      });
      context.store.upsertForeman({
        id: "repository-foreman",
        agentProfileId: profile.id,
        enabled: true,
      });
      const run = context.store.createRunForForeman("repository-foreman").run;
      const principal = {
        kind: "foreman" as const,
        foremanId: run.foremanId,
        runId: run.id,
        generation: run.generation,
        authorityRevision: 0,
      };
      const snapshot = (await buildTrustedBuiltinCopilotPackage()).snapshot;
      const teams = new MissionTeamService(
        context.store,
        missions,
        config,
        context.worktrees,
        context.git,
        {
          assignGroupCheckout: async (groupId, command) => ({
            group: context.store.assignGroupCheckout(
              groupId,
              command.checkoutId,
              command.expectedCheckoutRevision,
            ),
            checkoutId: command.checkoutId,
            outcomes: [],
          }),
        },
        { resolveActiveSnapshot: async () => snapshot },
      );
      const command = {
        requestId: "team",
        expectedGrantRevision: running.grantRevision,
        expectedConfigRevision: config.load().status.revision!,
        templateId: "build",
        sourceCheckoutId: source.id,
        baseCommit: source.head!,
      };
      const allocation = await teams.provision(principal, mission.id, command);
      expect(allocation.state).toBe("ready");
      expect(context.store.getGroup(allocation.groupId).checkoutId).toBe(allocation.checkoutId);
      const members = context.store.listActiveMemberships(allocation.groupId);
      expect(members).toHaveLength(1);
      expect(members[0]?.roleId).toBe("engineer");
      expect(readFileSync(path, "utf8")).toBe(authored);
      expect(await teams.provision(principal, mission.id, command)).toEqual(allocation);
      expect(context.store.listWorktrees()).toHaveLength(1);
      context.store.reconcileTopology(config.load().config);
      expect(context.store.getGroup(allocation.groupId).checkoutId).toBe(allocation.checkoutId);
      const checkout = context.store.getCheckout(allocation.checkoutId!);
      writeFileSync(join(checkout.path, "dirty.txt"), "preserve mission work\n");
      teams.recoverInterrupted();
      expect(readFileSync(join(checkout.path, "dirty.txt"), "utf8")).toBe(
        "preserve mission work\n",
      );
      const worker = context.store.createRunForMembership(
        allocation.groupId,
        members[0]!.memberId,
      ).run;
      expect(worker.resolvedWorkingDirectory).toBe(checkout.path);
      expect(worker.checkoutId).toBe(allocation.checkoutId);
      context.store.updateRunStatus(worker.id, "running");
      const timestamp = new Date().toISOString();
      context.store.registerReporterSession({
        id: "mission-reporter",
        runId: worker.id,
        generation: worker.generation,
        providerId: "copilot",
        adapterId: "copilot",
        reporterId: "copilot-hooks",
        source: "copilot",
        protocolVersion: 2,
        reporterVersion: "2",
        reporterEpoch: "mission-epoch",
        readinessCoverage: "full",
        sourceSequence: 0,
        openedAt: timestamp,
        leaseExpiresAt: "2099-01-01T00:00:00Z",
      });
      context.store.bindReporterProcess(worker.id, worker.generation, "a".repeat(64));
      context.store.recordProcessStatus(worker.id, {
        event: "process.alive",
        eventId: "mission-alive",
        observedAt: timestamp,
        process: {
          foregroundPgid: 1,
          leaderPid: 1,
          pidStartIdentity: "1:1",
          executableFingerprint: "b".repeat(64),
          argvFingerprint: "c".repeat(64),
          processFingerprint: "a".repeat(64),
          expectedProviderMatch: "match",
          wrapperChain: ["copilot"],
        },
      });
      context.store.ingestAgentStatusEvent(
        {
          groupId: allocation.groupId,
          memberId: worker.memberId,
          runId: worker.id,
          generation: worker.generation,
        },
        {
          version: 2,
          eventId: "mission-ready",
          providerId: "copilot",
          adapterId: "copilot",
          reporterId: "copilot-hooks",
          source: "copilot",
          protocolVersion: 2,
          reporterVersion: "2",
          reporterEpoch: "mission-epoch",
          runId: worker.id,
          generation: worker.generation,
          sourceSequence: 1,
          event: "session.ready",
          data: {},
        },
      );
      const task = missions.createTask(principal, mission.id, {
        requestId: "task",
        expectedGrantRevision: running.grantRevision,
        title: "Implementation",
        instructions: "Implement bounded work",
        templateId: "build",
        roleId: "engineer",
        dependencies: [],
        acceptanceIndexes: [0],
      });
      const actions = new AgentActionService(
        context.store,
        1,
        new PeerCapabilityPolicy((caller, command) => scheduler.authorize(caller, command)),
      );
      const scheduler = new MissionTaskScheduler(
        context.store,
        missions,
        teams,
        actions,
        {
          startRun: async () => {
            throw new Error("Worker already running");
          },
        },
        () => false,
      );
      await scheduler.tick();
      await scheduler.tick();
      const assigned = missions.workspace(mission.id).tasks.find((item) => item.id === task.id)!;
      expect(assigned).toMatchObject({
        state: "assigned",
        runId: worker.id,
        generation: worker.generation,
        groupId: allocation.groupId,
      });
      expect(context.store.listAgentActions()).toHaveLength(1);
      const action = context.store.getAgentAction(assigned.actionId!);
      expect(action.principal).toMatchObject({
        kind: "foreman",
        missionId: mission.id,
        taskId: task.id,
      });
      scheduler.authorizeAction(action);
      missions.control("human", mission.id, {
        expectedRevision: running.revision,
        action: "pause",
      });
      expect(() => scheduler.authorizeAction(action)).toThrow("grant changed");
      await scheduler.close();
    } finally {
      context.store.close();
    }
  });

  it("fetches and prunes remote refs without changing the current branch or local files", async () => {
    const context = fixture();
    try {
      const source = (await context.checkouts.initialize(context.repository)).checkout;
      const remote = join(context.root, "remote.git");
      execFileSync("git", ["clone", "--bare", "--quiet", context.repository, remote]);
      execFileSync("git", ["-C", context.repository, "remote", "add", "origin", remote]);
      execFileSync("git", ["-C", remote, "update-ref", "refs/heads/outdated", "HEAD"]);
      await context.worktrees.fetch(source.id);
      expect(await context.worktrees.listReferences(source.id)).toContainEqual({
        name: "origin/outdated",
        kind: "remote",
      });
      execFileSync("git", ["-C", remote, "update-ref", "-d", "refs/heads/outdated"]);
      execFileSync("git", ["-C", remote, "update-ref", "refs/heads/new-feature", "HEAD"]);
      const localFile = join(context.repository, "uncommitted.txt");
      writeFileSync(localFile, "keep these changes\n");
      const statuses = await context.worktrees.fetch(source.id);
      const references = await context.worktrees.listReferences(source.id);
      expect(references).toContainEqual({ name: "origin/new-feature", kind: "remote" });
      expect(references).not.toContainEqual({ name: "origin/outdated", kind: "remote" });
      expect(statuses).toContainEqual(
        expect.objectContaining({ checkoutId: source.id, untracked: 1, branch: source.branch }),
      );
      expect(context.store.getCheckout(source.id).head).toBe(source.head);
      expect(readFileSync(localFile, "utf8")).toBe("keep these changes\n");
    } finally {
      context.store.close();
    }
  });

  it("lists local, remote, and tag base references without ambiguous names", async () => {
    const context = fixture();
    try {
      const source = (await context.checkouts.initialize(context.repository)).checkout;
      execFileSync("git", ["-C", context.repository, "branch", "feature/frontend"]);
      execFileSync("git", ["-C", context.repository, "branch", "release"]);
      execFileSync("git", ["-C", context.repository, "tag", "release"]);
      execFileSync("git", [
        "-C",
        context.repository,
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);
      execFileSync("git", [
        "-C",
        context.repository,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      ]);
      const references = await context.worktrees.listReferences(source.id);
      expect(references).toEqual(
        expect.arrayContaining([
          { name: "feature/frontend", kind: "branch" },
          { name: "heads/release", kind: "branch" },
          { name: "tags/release", kind: "tag" },
          { name: "origin/main", kind: "remote" },
        ]),
      );
      expect(references.some((ref) => ref.name === "origin/HEAD")).toBe(false);
      await expect(context.worktrees.listReferences("missing-checkout")).rejects.toMatchObject({
        code: "checkout_not_found",
      });
    } finally {
      context.store.close();
    }
  });

  it("creates once, safely reuses a concurrent branch request, and records provenance", async () => {
    const context = fixture();
    try {
      const source = (await context.checkouts.initialize(context.repository)).checkout;
      const command = {
        sourceCheckoutId: source.id,
        branch: "feature/safe-race",
        base: "HEAD",
      };
      const [first, second] = await Promise.all([
        context.worktrees.create(command),
        context.worktrees.create(command),
      ]);
      expect(first.worktree).toMatchObject({
        state: "ready",
        branch: "feature/safe-race",
        provenanceToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(second.checkout?.id).toBe(first.checkout?.id);
      expect(context.store.listWorktrees()).toHaveLength(1);
      expect(first.checkout?.path).toContain(safeWorktreeSlug("feature/safe-race"));
      expect(readFileSync(join(first.checkout!.path, ".git"), "utf8")).not.toContain(
        context.repository,
      );
    } finally {
      context.store.close();
    }
  });

  it("requires dirty confirmation, removes only owned identity, and preserves the branch", async () => {
    const context = fixture();
    try {
      const source = (await context.checkouts.initialize(context.repository)).checkout;
      const created = await context.worktrees.create({
        sourceCheckoutId: source.id,
        branch: "feature/dirty",
        base: "HEAD",
      });
      writeFileSync(join(created.checkout!.path, "dirty.txt"), "keep me\n");
      await expect(
        context.worktrees.remove(created.worktree!.id, {
          force: false,
          expectedOperationGeneration: created.worktree!.operationGeneration,
        }),
      ).rejects.toMatchObject({ code: "dirty_worktree_requires_force" });
      const current = context.store.getWorktree(created.worktree!.id);
      await expect(
        context.worktrees.remove(current.id, {
          force: true,
          expectedOperationGeneration: current.operationGeneration,
        }),
      ).resolves.toMatchObject({ worktree: { state: "removed" } });
      expect(existsSync(created.checkout!.path)).toBe(false);
      expect(context.store.listCheckouts()).not.toContainEqual(
        expect.objectContaining({ id: created.checkout!.id }),
      );
      expect(
        execFileSync(
          "git",
          ["-C", context.repository, "show-ref", "--verify", "refs/heads/feature/dirty"],
          {
            encoding: "utf8",
          },
        ),
      ).toContain("refs/heads/feature/dirty");
    } finally {
      context.store.close();
    }
  });

  it("refuses active-run deletion and never treats discovered worktrees as owned", async () => {
    const context = fixture();
    try {
      const source = (await context.checkouts.initialize(context.repository)).checkout;
      const created = await context.worktrees.create({
        sourceCheckoutId: source.id,
        branch: "feature/active",
        base: "HEAD",
      });
      const config = NanasaConfigSchema.parse({
        version: 2,
        integrations: {
          test: {
            id: "test",
            name: "Test",
            kind: "pi",
            command: ["pi"],
            commandSource: "builtin",
            cwd: context.repository,
          },
        },
        groups: {
          team: {
            name: "Team",
            agents: {
              worker: {
                memberId: "worker",
                name: "Worker",
                integrationId: "test",
                order: 0,
              },
            },
          },
        },
      });
      context.store.reconcileTopology(config);
      context.store.assignGroupCheckout("team", created.checkout!.id, 0);
      await expect(
        context.worktrees.remove(created.worktree!.id, {
          force: true,
          expectedOperationGeneration: created.worktree!.operationGeneration,
        }),
      ).rejects.toMatchObject({ code: "worktree_has_assignments" });
      const run = context.store.createRunForMembership("team", "worker").run;
      expect(run).toMatchObject({
        checkoutId: created.checkout!.id,
        resolvedWorkingDirectory: created.checkout!.path,
      });
      await expect(
        context.worktrees.remove(created.worktree!.id, {
          force: true,
          expectedOperationGeneration: created.worktree!.operationGeneration,
        }),
      ).rejects.toMatchObject({ code: "worktree_has_active_runs" });

      const manualPath = join(context.root, "manual");
      execFileSync("git", [
        "-C",
        context.repository,
        "worktree",
        "add",
        "-b",
        "feature/manual",
        manualPath,
        "HEAD",
      ]);
      const opened = await context.worktrees.open({
        sourceCheckoutId: source.id,
        path: manualPath,
      });
      expect(opened.checkout?.kind).toBe("linked");
      expect(opened.worktree).toBeUndefined();
      expect(context.store.listWorktrees()).toHaveLength(1);
    } finally {
      context.store.close();
    }
  });

  it("recovers completed creation after restart and rejects an unrelated replacement directory", async () => {
    const context = fixture();
    try {
      const source = (await context.checkouts.initialize(context.repository)).checkout;
      const target = join(context.managedRoot, "recovered");
      const worktreeId = "worktree_recovered";
      const createdAt = new Date().toISOString();
      const operation = context.store.beginGitOperation({
        repositoryId: source.repositoryId,
        checkoutId: source.id,
        worktreeId,
        kind: "create-worktree",
        targetPath: target,
        request: {
          worktreeId,
          sourceCheckoutId: source.id,
          branch: "feature/recovered",
          base: "HEAD",
          provenanceToken: "a".repeat(64),
          createdAt,
        },
      });
      mkdirSync(context.managedRoot, { recursive: true });
      execFileSync("git", [
        "-C",
        context.repository,
        "worktree",
        "add",
        "-b",
        "feature/recovered",
        target,
        "HEAD",
      ]);
      await context.worktrees.recover();
      expect(context.store.getGitOperation(operation.id).state).toBe("succeeded");
      const recovered = context.store.getWorktree(worktreeId);
      expect(recovered).toMatchObject({
        state: "ready",
        operationGeneration: operation.generation,
      });

      execFileSync("git", ["-C", context.repository, "worktree", "remove", "--force", target]);
      mkdirSync(target);
      writeFileSync(join(target, "unrelated.txt"), "unrelated\n");
      await expect(
        context.worktrees.remove(worktreeId, {
          force: true,
          expectedOperationGeneration: recovered.operationGeneration,
        }),
      ).rejects.toBeDefined();
      expect(existsSync(join(target, "unrelated.txt"))).toBe(true);
    } finally {
      context.store.close();
    }
  });
});
