import type { PortalSnapshot } from "@nanasa/contracts";
import { expect, test } from "./fixtures/package-fixture.js";

test("legacy agent menu stops failed active recovery and starts only that agent fresh", async ({
  page,
  nanasa,
}) => {
  const { group, agents } = await nanasa.seedGroup("Recovery controls", ["Engineer", "Teammate"]);
  await nanasa.startAll(group.id);
  const before = await nanasa.snapshot();
  const original = before.runs.find(
    (run) => run.memberId === agents[0]!.memberId && run.status === "running",
  )!;
  const teammate = before.runs.find(
    (run) => run.memberId === agents[1]!.memberId && run.status === "running",
  )!;
  await nanasa.waitForTerminalReady(original.id);
  await nanasa.waitForTerminalReady(teammate.id);
  await page.route("**/api/v1/snapshot", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const snapshot = (await response.json()) as PortalSnapshot;
    snapshot.runs = snapshot.runs.map((run) =>
      run.id === original.id && run.status === "running"
        ? {
            ...run,
            recoveryPhase: "failed",
            recoveryAttempts: 3,
            recoveryReason: "recovery_attempts_exhausted",
          }
        : run,
    );
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto(nanasa.portalUrl);
  await page.getByRole("button", { name: "Actions for agent Engineer", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Retry Engineer", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Stop Engineer", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await nanasa.snapshot()).runs.find((run) => run.id === original.id)?.desiredState,
    )
    .toBe("stopped");
  await nanasa.waitForPaneStopped(original.terminal!.paneId);
  await page.getByRole("button", { name: "Actions for agent Engineer", exact: true }).click();
  await page.getByRole("menuitem", { name: "Start Engineer", exact: true }).click();
  await expect
    .poll(async () =>
      (await nanasa.snapshot()).runs.some(
        (run) =>
          run.memberId === original.memberId && run.id !== original.id && run.status === "running",
      ),
    )
    .toBe(true);
  const after = await nanasa.request<PortalSnapshot>("/api/v1/snapshot");
  const fresh = after.runs.find(
    (run) => run.memberId === original.memberId && run.status === "running",
  )!;
  expect(fresh).toMatchObject({ launchKind: "fresh", recoveryAttempts: 0 });
  expect(fresh.nativeSessionId).toBeUndefined();
  expect(fresh.generation).toBeGreaterThan(original.generation);
  expect(after.runs.find((run) => run.id === teammate.id)).toMatchObject({
    status: "running",
    terminal: { paneId: teammate.terminal!.paneId },
  });
  expect(nanasa.paneExists(teammate.terminal!.paneId)).toBe(true);
});

test("invalid workspace creation keeps the real API error inside the dialog", async ({
  page,
  nanasa,
}, testInfo) => {
  await nanasa.seedGroup("Workspace checks", ["Engineer"]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${nanasa.baseUrl}/checkouts${new URL(nanasa.portalUrl).hash}`);
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add workspace", exact: true });
  await dialog
    .getByRole("textbox", { name: "New branch", exact: true })
    .fill("invalid branch name");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/worktrees") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create workspace", exact: true }).click();
  expect((await responsePromise).ok()).toBe(false);
  await expect(dialog.getByRole("alert")).toContainText("Worktree branch name is invalid");
  await dialog.getByText("invalid_worktree_branch", { exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("invalid_worktree_branch");
  await expect(dialog.getByRole("textbox", { name: "New branch", exact: true })).toHaveValue(
    "invalid branch name",
  );
  const errorBounds = await dialog.getByRole("alert").boundingBox();
  const dialogBounds = await dialog.boundingBox();
  expect(errorBounds!.y).toBeGreaterThanOrEqual(dialogBounds!.y);
  expect(errorBounds!.y + errorBounds!.height).toBeLessThanOrEqual(
    dialogBounds!.y + dialogBounds!.height,
  );
  await page.screenshot({ path: testInfo.outputPath("workspace-error-in-dialog.png") });
});
