import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures/package-fixture.js";

test("entity shell keeps project status contextual and exposes all navigation", async ({
  page,
  nanasa,
}, testInfo) => {
  const backend = await nanasa.seedGroup("Backend Team", ["Engineer", "Reviewer"]);
  await nanasa.seedGroup("Frontend Team", ["Designer"]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${nanasa.baseUrl}/agents${new URL(nanasa.portalUrl).hash}`);
  const project = page.getByRole("region", { name: "Project context" });
  await expect(
    project.getByRole("button", { name: "System connected, open System status" }),
  ).toBeVisible();
  await expect(page.locator(".portal-topbar")).toBeVisible();
  await expect(page.locator(".workspace-header .portal-project-connection")).toHaveCount(0);
  const operations = page
    .locator(".group-rail")
    .getByRole("navigation", { name: "Operations", exact: true });
  await expect(operations.getByRole("link")).toHaveText(["Workspaces", "Teams", "Attention"]);
  await expect(operations.getByRole("link", { name: "Teams", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.locator(".group-rail").getByRole("link", { name: "Providers", exact: true }),
  ).toBeHidden();
  await page.locator('summary[aria-label="Portal utilities"]').click();
  for (const name of ["Providers", "Diagnostics", "Service", "Remote access"]) {
    await expect(
      page.locator(".group-rail").getByRole("link", { name, exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("more-desktop.png") });
  await page.locator('summary[aria-label="Portal utilities"]').click();
  await operations.getByRole("link", { name: "Teams", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Teams views", exact: true })
    .getByRole("link", { name: "All agents", exact: true })
    .click();
  await expect(page).toHaveURL(/\/agents$/);
  const geometry = await project.evaluate((element) => {
    const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
    return {
      iconTop: rect(".portal-project-glyph").top,
      nameTop: rect(".portal-project-name").top,
      nameLeft: rect(".portal-project-name").left,
      statusLeft: rect(".portal-connection-name").left,
      freshnessLeft: rect(".portal-connection-freshness").left,
    };
  });
  expect(geometry.iconTop).toBe(geometry.nameTop);
  expect(geometry.nameLeft).toBe(geometry.statusLeft);
  expect(geometry.nameLeft).toBe(geometry.freshnessLeft);
  for (const theme of ["light", "dark"]) {
    await page.locator('summary[aria-label="Portal utilities"]').click();
    await page.getByRole("button", { name: `Use ${theme} theme`, exact: true }).click();
    await page.locator('summary[aria-label="Portal utilities"]').click();
    await page.screenshot({ path: testInfo.outputPath(`shell-${theme}-1440.png`) });
    await project.screenshot({ path: testInfo.outputPath(`project-${theme}-1440.png`) });
    const accessibility = await new AxeBuilder({ page })
      .include(".portal-topbar")
      .include(".portal-project-context")
      .include(".repository-navigation")
      .analyze();
    expect(
      accessibility.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  }
  await project.getByRole("button").click();
  await expect(page.getByRole("dialog", { name: "System status" })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.getByRole("button", { name: "Close command palette" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(project.getByRole("button")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open application menu" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("shell-dark-390.png") });
  await page.getByRole("button", { name: "Open application menu" }).click();
  const drawer = page.getByRole("dialog", { name: "Nanasa", exact: true });
  await expect(
    drawer.getByRole("navigation", { name: "Operations", exact: true }).getByRole("link"),
  ).toHaveText(["Workspaces", "Teams", "Attention"]);
  await expect(drawer.getByRole("link", { name: "Providers", exact: true })).toBeHidden();
  await drawer.getByText("More", { exact: true }).click();
  for (const name of [
    "Attention",
    "Teams",
    "Workspaces",
    "Providers",
    "Diagnostics",
    "Service",
    "Remote access",
    "Preferences",
    "Help",
    "About Nanasa",
  ]) {
    await expect(drawer.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("navigation-dark-390.png") });
  await drawer.getByRole("link", { name: "Diagnostics", exact: true }).click();
  await expect(page).toHaveURL(/\/diagnostics$/);
  await page.getByRole("button", { name: "Open application menu" }).click();
  await page
    .getByRole("dialog", { name: "Nanasa" })
    .getByRole("link", { name: "Backend Team", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/groups/${backend.group.id}/terminals$`));
  await expect(
    page.getByRole("button", { name: "Start all non-running agents in Backend Team" }),
  ).toBeVisible();
});
