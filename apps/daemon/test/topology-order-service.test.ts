import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckoutService } from "../src/git/checkout-service.js";
import { GitCommandAdapter } from "../src/git/git-command-adapter.js";
import { GitStatusService } from "../src/git/git-status-service.js";
import { RepositoryDiscoveryService } from "../src/git/repository-discovery-service.js";
import { ConfigRepository } from "../src/config-repository.js";
import { loadNanasaConfig } from "../src/config-v2.js";
import { NanasaStore } from "../src/store.js";
import { TopologyOrderService } from "../src/topology-order-service.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const repository = mkdtempSync(join(tmpdir(), "nanasa-topology-order-"));
  directories.push(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  mkdirSync(join(repository, ".nanasa"));
  writeFileSync(
    join(repository, ".nanasa", "config.yaml"),
    `version: 2
integrations:
  test:
    name: Test
    kind: pi
    command: [pi]
    cwd: .
groups:
  alpha:
    name: Alpha
    agents:
      builder:
        memberId: builder
        name: Builder
        integrationId: test
      reviewer:
        memberId: reviewer
        name: Reviewer
        integrationId: test
  beta:
    name: Beta
    agents: {}
`,
  );
  const loaded = loadNanasaConfig(repository);
  const store = new NanasaStore(":memory:", { config: loaded.config, configStatus: loaded.status });
  const git = new GitCommandAdapter();
  const discovery = new RepositoryDiscoveryService(git);
  const checkouts = new CheckoutService(store, discovery, new GitStatusService(git));
  await checkouts.initialize(repository);
  store.reconcileTopology(loaded.config, loaded.status);
  const service = new TopologyOrderService(new ConfigRepository(repository), store);
  return { repository, store, service };
}

describe("canonical topology order", () => {
  it("uses one revision for group and member order and rejects stale writers", async () => {
    const { store, service } = await fixture();
    try {
      const initial = store.getSnapshot();
      expect(initial.groups.map((group) => group.id)).toEqual(["alpha", "beta"]);
      expect(initial.memberships.map((membership) => membership.id)).toEqual([
        "builder",
        "reviewer",
      ]);
      const groups = await service.reorderGroups({
        groupIds: ["beta", "alpha"],
        expectedOrderRevision: initial.orderRevision,
      });
      expect(groups.orderRevision).toBe(initial.orderRevision + 1);
      const agents = await service.reorderAgents("alpha", {
        agentIds: ["reviewer", "builder"],
        expectedOrderRevision: groups.orderRevision,
      });
      expect(agents.orderRevision).toBe(groups.orderRevision + 1);
      expect(store.getSnapshot()).toMatchObject({
        orderRevision: agents.orderRevision,
        groups: [{ id: "beta" }, { id: "alpha" }],
        memberships: [{ id: "reviewer" }, { id: "builder" }],
      });
      await expect(
        service.reorderGroups({
          groupIds: ["alpha", "beta"],
          expectedOrderRevision: initial.orderRevision,
        }),
      ).rejects.toMatchObject({ code: "topology_order_stale" });
    } finally {
      store.close();
    }
  });

  it("refuses live movement, then reparents a stopped agent without changing identity or history", async () => {
    const { store, service } = await fixture();
    try {
      const created = store.createRunForMembership("alpha", "builder").run;
      await expect(
        service.reparentAgent("alpha", "builder", {
          targetGroupId: "beta",
          expectedOrderRevision: store.getOrderRevision(),
        }),
      ).rejects.toMatchObject({ code: "active_run_reparent_refused" });
      store.stopDesiredRun(created.id, created.generation);
      store.updateRunStatus(created.id, "stopping");
      store.updateRunStatus(created.id, "stopped");
      const before = store.getOrderRevision();
      const moved = await service.reparentAgent("alpha", "builder", {
        targetGroupId: "beta",
        expectedOrderRevision: before,
      });
      expect(moved).toMatchObject({
        agentId: "builder",
        memberId: "builder",
        sourceGroupId: "alpha",
        targetGroupId: "beta",
        orderRevision: before + 1,
      });
      expect(store.getRun(created.id)).toMatchObject({ groupId: "alpha", memberId: "builder" });
      expect(store.listActiveMemberships("beta")).toEqual([
        expect.objectContaining({ id: "builder", memberId: "builder", groupId: "beta" }),
      ]);
      const next = store.createRunForMembership("beta", "builder").run;
      expect(next).toMatchObject({ generation: created.generation + 1, groupId: "beta" });
    } finally {
      store.close();
    }
  });

  it("makes Start All iteration consume persisted member order", async () => {
    const { store, service } = await fixture();
    try {
      await service.reorderAgents("alpha", {
        agentIds: ["reviewer", "builder"],
        expectedOrderRevision: store.getOrderRevision(),
      });
      expect(store.listActiveMemberships("alpha").map((membership) => membership.memberId)).toEqual(
        ["reviewer", "builder"],
      );
    } finally {
      store.close();
    }
  });
});
