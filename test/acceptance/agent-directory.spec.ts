import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures/package-fixture.js";

test("All agents groups live configuration and opens selected terminals or teams", async ({
  page,
  nanasa,
}, testInfo) => {
  mkdirSync(join(nanasa.configRoot, ".nanasa", "instructions"), { recursive: true });
  writeFileSync(
    join(nanasa.configRoot, ".nanasa", "instructions", "frontend.md"),
    "# Frontend\nWork in the assigned frontend checkout.\n",
  );
  writeFileSync(
    join(nanasa.configRoot, ".nanasa", "instructions", "review.md"),
    "# Review\nReport findings to the operator.\n",
  );
  const backend = await nanasa.seedGroup("Backend Team", [
    "Manager",
    "Engineer 1",
    "Engineer 2",
    "Backend Reviewer",
  ]);
  const frontend = await nanasa.seedGroup("Frontend Team", [
    "Frontend Engineer",
    "Frontend Reviewer",
  ]);
  const primary = (await nanasa.snapshot()).checkouts.find(
    (checkout) => checkout.kind === "primary",
  )!;
  const worktree = await nanasa.request<{ checkout: { id: string; path: string } }>(
    "/api/v1/worktrees",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceCheckoutId: primary.id,
        branch: "feature/directory",
        base: "HEAD",
      }),
    },
  );
  await nanasa.request(`/api/v1/groups/${frontend.group.id}/checkout`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkoutId: worktree.checkout.id,
      expectedCheckoutRevision: 0,
      switchPolicy: "require-stopped",
    }),
  });
  await nanasa.request(`/api/v1/groups/${frontend.group.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instructions: [".nanasa/instructions/frontend.md"] }),
  });
  await nanasa.request(`/api/v1/groups/${frontend.group.id}/agents/${frontend.agents[1]!.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instructions: [".nanasa/instructions/review.md"] }),
  });
  await nanasa.startAll(backend.group.id);
  const managerRun = (await nanasa.snapshot()).runs.find(
    (run) =>
      run.groupId === backend.group.id &&
      run.memberId === backend.agents[0]!.memberId &&
      run.status === "running",
  )!;
  await nanasa.waitForTerminalReady(managerRun.id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${nanasa.baseUrl}/agents${new URL(nanasa.portalUrl).hash}`);
  const directory = page.getByRole("article");
  await expect(directory.getByRole("heading", { name: "All agents", exact: true })).toBeVisible();
  await expect(directory.getByRole("button", { name: /^Inspect / })).toHaveCount(6);
  await expect(
    directory
      .getByRole("button", { name: "Inspect Manager", exact: true })
      .getByText(backend.agents[0]!.memberId, { exact: true }),
  ).toBeVisible();
  await directory.getByRole("button", { name: "Inspect Manager", exact: true }).click();
  await directory.getByRole("link", { name: "Open terminal", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/groups/${backend.group.id}/terminals/${managerRun.id}$`),
  );
  await expect(page.getByRole("region", { name: "Agent terminals" })).toBeVisible();

  await page.goBack();
  await directory.getByRole("button", { name: "Inspect Frontend Reviewer", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Agent configuration" });
  await expect(inspector.getByRole("button", { name: "Open terminal" })).toBeDisabled();
  await expect(inspector.getByRole("region", { name: "Workspace configuration" })).toContainText(
    worktree.checkout.path,
  );
  await inspector.getByRole("link", { name: "Open team", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/groups/${frontend.group.id}/terminals$`));
  await page.goBack();
  await directory.getByLabel("Group by", { exact: true }).selectOption("provider");
  await expect(directory.getByRole("button", { name: /^Inspect / })).toHaveCount(6);
  await directory.getByLabel("Search agents").fill(frontend.agents[1]!.memberId);
  await expect(directory.getByRole("button", { name: /^Inspect / })).toHaveCount(1);
  await expect(
    directory.getByRole("button", { name: "Inspect Frontend Reviewer", exact: true }),
  ).toBeVisible();
  await directory.getByLabel("Search agents").fill("Frontend");
  await expect(directory.getByRole("button", { name: /^Inspect / })).toHaveCount(2);
  await directory.getByLabel("Search agents").fill("");
  await directory.getByLabel("Group by", { exact: true }).selectOption("team");
  await directory.getByRole("button", { name: "Inspect Frontend Reviewer", exact: true }).click();
  await inspector.getByRole("button", { name: "Prompt layers", exact: true }).click();
  await expect(
    inspector.getByText(".nanasa/instructions/frontend.md", { exact: true }),
  ).toBeVisible();
  await expect(inspector.getByRole("region", { name: "Prompt composition" })).toContainText(
    "4 sources",
  );
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.screenshot({ path: testInfo.outputPath("all-agents-desktop.png") });
  const accessibility = await new AxeBuilder({ page }).include(".agent-directory").analyze();
  expect(
    accessibility.violations
      .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
      .map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => node.target),
      })),
  ).toEqual([]);
  await inspector.getByRole("button", { name: "Configuration", exact: true }).click();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await directory.evaluate((element) => {
      element.scrollTop = 0;
    });
    expect(await directory.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`all-agents-${width}.png`) });
  }
  await directory.getByRole("button", { name: "Inspect Frontend Engineer", exact: true }).click();
  await expect(
    inspector.getByRole("heading", { name: "Frontend Engineer", exact: true }),
  ).toBeFocused();
  await expect(inspector.getByRole("link", { name: "Open team", exact: true })).toBeInViewport();
  await expect(inspector.getByText(frontend.agents[0]!.memberId, { exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("all-agents-mobile-inspector.png") });
  await inspector.getByRole("link", { name: "Open team", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/groups/${frontend.group.id}/terminals$`));
});
