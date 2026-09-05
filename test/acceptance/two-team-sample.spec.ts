import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expect, test } from "@playwright/test";
import { PackageAcceptanceService } from "./fixtures/package-fixture.js";

test("nested sample runs Backend and Frontend in independent workspaces", async () => {
  const suffix = join("examples", "multi-coding-agents");
  const nanasa = await PackageAcceptanceService.create("two-team", {
    configSubdirectory: suffix,
    integrationCwd: ".",
  });
  try {
    const backend = await nanasa.seedGroup("Backend Team", [
      "Manager",
      "Engineer 1",
      "Engineer 2",
      "Reviewer",
    ]);
    const frontend = await nanasa.seedGroup("Frontend Team", [
      "Frontend Engineer",
      "Frontend Reviewer",
    ]);
    const primary = (await nanasa.snapshot()).checkouts.find(
      (checkout) => checkout.kind === "primary",
    )!;
    const configPath = join(nanasa.configRoot, ".nanasa", "config.yaml");
    const configBefore = readFileSync(configPath, "utf8");
    const created = await nanasa.request<{
      checkout: { id: string; path: string; branch: string };
      worktree: { id: string; operationGeneration: number };
    }>("/api/v1/worktrees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceCheckoutId: primary.id,
        branch: "feature/frontend",
        base: "HEAD",
      }),
    });
    expect(created.checkout.path).toBe(
      join(nanasa.root, ".nanasa-worktrees", "repository", "feature-frontend"),
    );
    const gitLink = readFileSync(join(created.checkout.path, ".git"), "utf8").trim();
    expect(isAbsolute(gitLink.slice("gitdir: ".length))).toBe(false);
    await nanasa.request(`/api/v1/groups/${frontend.group.id}/checkout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkoutId: created.checkout.id,
        expectedCheckoutRevision: 0,
        switchPolicy: "require-stopped",
      }),
    });
    await nanasa.startAll(backend.group.id);
    await nanasa.startAll(frontend.group.id);
    const beforeRestart = await nanasa.snapshot();
    const active = beforeRestart.runs.filter((run) => run.status === "running");
    expect(active).toHaveLength(6);
    for (const run of active) {
      const checkout = run.groupId === backend.group.id ? primary : created.checkout;
      expect(run.checkoutId).toBe(checkout.id);
      expect(run.resolvedWorkingDirectory).toBe(join(checkout.path, suffix));
      await nanasa.waitForPaneText(run.terminal!.paneId, "SAFE_ECHO_READY:");
      expect(
        execFileSync(
          "tmux",
          [
            "-L",
            nanasa.tmuxServer,
            "display-message",
            "-p",
            "-t",
            run.terminal!.paneId,
            "#{pane_current_path}",
          ],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(run.resolvedWorkingDirectory);
    }
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    expect(
      execFileSync("git", ["-C", nanasa.repository, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(primary.branch);
    await nanasa.restartDaemon();
    const recovered = await nanasa.snapshot();
    expect(recovered.groups.find((group) => group.id === frontend.group.id)).toMatchObject({
      checkoutId: created.checkout.id,
      checkoutRevision: 1,
    });
    for (const run of active) {
      expect(recovered.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
        checkoutId: run.checkoutId,
        resolvedWorkingDirectory: run.resolvedWorkingDirectory,
        status: "running",
        terminal: { paneId: run.terminal!.paneId },
      });
    }
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  } finally {
    await nanasa.close();
  }
});
