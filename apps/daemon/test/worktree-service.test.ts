import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NanasaConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CheckoutService } from "../src/git/checkout-service.js";
import { GitCommandAdapter } from "../src/git/git-command-adapter.js";
import { GitStatusService } from "../src/git/git-status-service.js";
import { RepositoryDiscoveryService } from "../src/git/repository-discovery-service.js";
import { safeWorktreeSlug, WorktreeService } from "../src/git/worktree-service.js";
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
  it("creates once, safely reuses a concurrent branch request, and records provenance", async () => {
    const context = fixture();
    try {
      const source = (await context.checkouts.initialize(context.repository)).checkout;
      const command = {
        sourceCheckoutId: source.id,
        branch: "feature/safe-race",
        base: "HEAD",
        assignAgentIds: [],
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
        assignAgentIds: [],
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
        assignAgentIds: [],
      });
      const config = NanasaConfigSchema.parse({
        version: 2,
        integrations: {
          test: { id: "test", name: "Test", kind: "pi", command: ["pi"], cwd: context.repository },
        },
        groups: {
          team: {
            name: "Team",
            agents: {
              worker: {
                memberId: "worker",
                name: "Worker",
                integrationId: "test",
                checkoutId: created.checkout!.id,
                order: 0,
              },
            },
          },
        },
      });
      context.store.reconcileTopology(config);
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
