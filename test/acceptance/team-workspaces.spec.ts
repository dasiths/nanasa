import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/package-fixture.js";

interface Checkout {
  id: string;
  path: string;
  kind: string;
  branch?: string;
}

interface Worktree {
  id: string;
  checkoutId: string;
  branch: string;
  operationGeneration: number;
  state: string;
}

interface WorktreeResult {
  checkout: Checkout;
  worktree: Worktree;
}

interface CheckoutAssignmentResult {
  group: { id: string; checkoutId?: string; checkoutRevision: number };
  checkoutId: string;
  outcomes: Array<{ memberId: string; status: string; runId?: string }>;
}

test("team workspace lifecycle remains consistent across runs and restart", async ({
  nanasa,
  page,
}, testInfo) => {
  const { group, agents } = await nanasa.seedGroup("Workspace team", ["Builder", "Reviewer"]);
  const competing = await nanasa.seedGroup("Competing team", []);
  const initialSnapshot = await nanasa.snapshot();
  const primary = initialSnapshot.checkouts.find((checkout) => checkout.kind === "primary");
  expect(primary).toBeDefined();
  expect(group.checkoutId).toBeUndefined();

  await nanasa.startAll(group.id);
  const initialRuns = (await nanasa.snapshot()).runs.filter(
    (run) => run.groupId === group.id && run.status === "running",
  );
  expect(initialRuns).toHaveLength(2);
  expect(initialRuns.every((run) => run.checkoutId === primary!.id)).toBe(true);
  expect(
    initialRuns.every(
      (run) => run.resolvedWorkingDirectory === join(nanasa.repository, "packages", "api"),
    ),
  ).toBe(true);

  const created = await nanasa.request<WorktreeResult>("/api/v1/worktrees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceCheckoutId: primary!.id,
      branch: "feature/team-workspace",
      base: "HEAD",
    }),
  });
  expect(created.checkout.kind).toBe("linked");
  expect(readFileSync(join(created.checkout.path, ".git"), "utf8")).not.toContain(
    nanasa.repository,
  );

  await expect(
    nanasa.request(`/api/v1/groups/${group.id}/checkout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkoutId: created.checkout.id,
        expectedCheckoutRevision: 0,
        switchPolicy: "require-stopped",
      }),
    }),
  ).rejects.toThrow(/Stop every agent/);

  const switched = await nanasa.request<CheckoutAssignmentResult>(
    `/api/v1/groups/${group.id}/checkout`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkoutId: created.checkout.id,
        expectedCheckoutRevision: 0,
        switchPolicy: "stop-switch-restart",
      }),
    },
  );
  expect(switched.group).toMatchObject({
    checkoutId: created.checkout.id,
    checkoutRevision: 1,
  });
  expect(switched.outcomes).toEqual(
    expect.arrayContaining(
      agents.map((agent) =>
        expect.objectContaining({ memberId: agent.memberId, status: "restarted" }),
      ),
    ),
  );

  await expect
    .poll(async () =>
      (await nanasa.snapshot()).runs.filter(
        (run) => run.groupId === group.id && run.status === "running",
      ),
    )
    .toHaveLength(2);
  const linkedRuns = (await nanasa.snapshot()).runs.filter(
    (run) => run.groupId === group.id && run.status === "running",
  );
  expect(linkedRuns.every((run) => run.checkoutId === created.checkout.id)).toBe(true);
  expect(
    linkedRuns.every(
      (run) => run.resolvedWorkingDirectory === join(created.checkout.path, "packages", "api"),
    ),
  ).toBe(true);
  expect(linkedRuns.map((run) => run.id)).not.toEqual(initialRuns.map((run) => run.id));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(nanasa.portalUrl);
  await page.getByRole("link", { name: "Team workspaces" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Team workspaces" })).toBeVisible();
  await expect(page.getByLabel("Workspace for Workspace team")).toHaveValue(created.checkout.id);
  await page.getByText("Exclusive", { exact: true }).hover();
  await expect(page.getByText("A linked working tree reserved for this team.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("team-workspaces-desktop.png") });
  await page.getByRole("button", { name: "Add workspace" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add workspace" });
  await expect(addDialog).toBeVisible();
  await expect(addDialog.getByRole("button", { name: "Create new" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await addDialog.getByRole("button", { name: "Attach existing" }).click();
  await expect(addDialog.getByLabel("Existing worktree path")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("add-workspace-desktop.png") });
  await addDialog.getByRole("button", { name: "Close add workspace" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Workspace for Workspace team")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("team-workspaces-mobile.png") });
  await page.getByRole("button", { name: "Add workspace" }).click();
  await expect(addDialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("add-workspace-mobile.png") });
  await addDialog.getByRole("button", { name: "Close add workspace" }).click();

  await expect(
    nanasa.request(`/api/v1/groups/${competing.group.id}/checkout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkoutId: created.checkout.id,
        expectedCheckoutRevision: 0,
        switchPolicy: "require-stopped",
      }),
    }),
  ).rejects.toThrow(/already assigned/);

  await nanasa.request(`/api/v1/groups/${group.id}/runs/stop-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await expect(
    nanasa.request(`/api/v1/worktrees/${created.worktree.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        force: true,
        expectedOperationGeneration: created.worktree.operationGeneration,
      }),
    }),
  ).rejects.toThrow(/Reassign every team/);

  await nanasa.request<CheckoutAssignmentResult>(`/api/v1/groups/${group.id}/checkout`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkoutId: primary!.id,
      expectedCheckoutRevision: 1,
      switchPolicy: "require-stopped",
    }),
  });
  const removed = await nanasa.request<WorktreeResult>(`/api/v1/worktrees/${created.worktree.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      force: true,
      expectedOperationGeneration: created.worktree.operationGeneration,
    }),
  });
  expect(removed.worktree.state).toBe("removed");
  expect((await nanasa.snapshot()).checkouts.some((item) => item.id === created.checkout.id)).toBe(
    false,
  );
  const branch = spawnSync(
    "git",
    ["-C", nanasa.repository, "show-ref", "--verify", "refs/heads/feature/team-workspace"],
    { encoding: "utf8" },
  );
  expect(branch.status).toBe(0);

  await nanasa.restartDaemon();
  const recovered = await nanasa.snapshot();
  expect(recovered.groups.find((candidate) => candidate.id === group.id)).toMatchObject({
    checkoutId: primary!.id,
    checkoutRevision: 2,
  });
  expect(recovered.worktrees.find((item) => item.id === created.worktree.id)).toMatchObject({
    state: "removed",
  });
});
