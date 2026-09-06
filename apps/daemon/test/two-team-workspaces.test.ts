import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { loadNanasaConfig } from "../src/config-loader.js";
import { resolveProviderStateHome } from "../src/provider-state-home.js";
import { createDaemon } from "../src/server.js";

it("places worktrees beside the Git checkout for a nested configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "nanasa-nested-worktrees-"));
  const repository = join(root, "repository");
  const sample = join(repository, "examples", "sample");
  mkdirSync(join(sample, ".nanasa"), { recursive: true });
  writeFileSync(join(sample, ".nanasa", "config.yaml"), "version: 2\nintegrations: {}\n");
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Nanasa Test",
    "-c",
    "user.email=nanasa@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "sample",
  ]);
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  try {
    daemon = await createDaemon({ loadedConfig: loadNanasaConfig(sample) });
    const primary = daemon.store.listCheckouts()[0]!;
    expect(primary.path).toBe(repository);
    const created = await daemon.worktrees.create({
      sourceCheckoutId: primary.id,
      branch: "feature/frontend",
      base: "HEAD",
    });
    expect(created.checkout?.path).toBe(
      join(root, ".nanasa-worktrees", "repository", "feature-frontend"),
    );
    const gitLink = readFileSync(join(created.checkout!.path, ".git"), "utf8").trim();
    expect(gitLink.startsWith("gitdir: ")).toBe(true);
    expect(isAbsolute(gitLink.slice("gitdir: ".length))).toBe(false);
  } finally {
    await daemon?.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the sample teams in separate checkouts and persists local assignments", async () => {
  const root = mkdtempSync(join(tmpdir(), "nanasa-two-team-sample-"));
  const repository = join(root, "repository");
  const suffix = join("examples", "multi-coding-agents");
  const sample = join(repository, suffix);
  const source = resolve(import.meta.dirname, "../../../examples/multi-coding-agents");
  const configPath = join(sample, ".nanasa", "config.yaml");
  mkdirSync(join(sample, ".nanasa"), { recursive: true });
  copyFileSync(join(source, ".nanasa", "config.yaml"), configPath);
  copyFileSync(join(source, ".nanasa", ".gitignore"), join(sample, ".nanasa", ".gitignore"));
  for (const folder of ["instructions", "providers"]) {
    cpSync(join(source, ".nanasa", folder), join(sample, ".nanasa", folder), { recursive: true });
  }
  cpSync(join(source, "bin"), join(sample, "bin"), { recursive: true });
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Nanasa Test",
    "-c",
    "user.email=nanasa@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "two-team sample",
  ]);
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  try {
    const configBefore = readFileSync(configPath, "utf8");
    const loaded = loadNanasaConfig(sample);
    const backendId = "grp_852f1819-0614-49b4-b193-71bf5e98becf";
    const frontendId = "team-frontend";
    daemon = await createDaemon({ loadedConfig: loaded, reconcileIntervalMs: 60_000 });
    const primary = daemon.store.getEffectiveGroupCheckout(backendId)!;
    const branchBefore = execFileSync("git", ["-C", repository, "branch", "--show-current"], {
      encoding: "utf8",
    });
    const created = await daemon.worktrees.create({
      sourceCheckoutId: primary.id,
      branch: "feature/frontend",
      base: "HEAD",
    });
    const frontendCheckout = created.checkout!;
    const assignment = await daemon.coordinator.assignGroupCheckout(frontendId, {
      checkoutId: frontendCheckout.id,
      expectedCheckoutRevision: 0,
      switchPolicy: "require-stopped",
    });
    expect(assignment.group.checkoutRevision).toBe(1);
    await expect(
      daemon.coordinator.assignGroupCheckout(backendId, {
        checkoutId: frontendCheckout.id,
        expectedCheckoutRevision: 0,
        switchPolicy: "require-stopped",
      }),
    ).rejects.toMatchObject({ code: "checkout_already_assigned" });

    const homes = new Set<string>();
    const runIds: string[] = [];
    for (const [groupId, group] of Object.entries(loaded.config.groups)) {
      for (const [agentId, agent] of Object.entries(group.agents)) {
        const run = daemon.store.createRunForMembership(groupId, agent.memberId).run;
        runIds.push(run.id);
        const expectedCheckout = groupId === backendId ? primary : frontendCheckout;
        expect(run.checkoutId).toBe(expectedCheckout.id);
        expect(run.resolvedWorkingDirectory).toBe(join(expectedCheckout.path, suffix));
        expect(existsSync(run.resolvedWorkingDirectory!)).toBe(true);
        const integration = loaded.config.integrations[agent.integrationId]!;
        homes.add(
          resolveProviderStateHome(
            join(sample, ".nanasa", "integrations"),
            agent.integrationId,
            integration.providerState,
            agentId,
          ),
        );
        daemon.store.stopDesiredRun(run.id, run.generation);
        daemon.store.updateRunStatus(run.id, "stopping");
        daemon.store.updateRunStatus(run.id, "stopped");
      }
    }
    expect(runIds).toHaveLength(6);
    expect(homes.size).toBe(6);
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    expect(
      execFileSync("git", ["-C", repository, "branch", "--show-current"], { encoding: "utf8" }),
    ).toBe(branchBefore);
    expect(existsSync(join(frontendCheckout.path, suffix, ".nanasa", "integrations"))).toBe(false);
    await daemon.app.close();
    daemon = undefined;
    daemon = await createDaemon({
      loadedConfig: loadNanasaConfig(sample),
      reconcileIntervalMs: 60_000,
    });
    expect(daemon.store.getEffectiveGroupCheckout(backendId)?.id).toBe(primary.id);
    expect(daemon.store.getGroup(frontendId)).toMatchObject({
      checkoutId: frontendCheckout.id,
      checkoutRevision: 1,
    });
    for (const runId of runIds) expect(daemon.store.getRun(runId).status).toBe("stopped");
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    await daemon.topologyOrder.reparentAgent(frontendId, "frontend-builder", {
      targetGroupId: backendId,
      expectedOrderRevision: daemon.store.getOrderRevision(),
    });
    const movedRun = daemon.store.createRunForMembership(backendId, "frontend-builder").run;
    expect(movedRun.checkoutId).toBe(primary.id);
    expect(movedRun.resolvedWorkingDirectory).toBe(sample);
    daemon.store.stopDesiredRun(movedRun.id, movedRun.generation);
    daemon.store.updateRunStatus(movedRun.id, "stopping");
    daemon.store.updateRunStatus(movedRun.id, "stopped");
  } finally {
    await daemon?.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
