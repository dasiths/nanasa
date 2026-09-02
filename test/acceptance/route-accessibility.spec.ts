import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/package-fixture.js";

async function expectNoHighImpactViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

function deepLink(nanasa: { baseUrl: string; portalUrl: string }, path: string): string {
  return `${nanasa.baseUrl}${path}${new URL(nanasa.portalUrl).hash}`;
}

test("deep links, reload, history, keyboard palette, and focus remain coherent", async ({
  page,
  nanasa,
}) => {
  const { group } = await nanasa.seedGroup("Route team", ["Navigator"]);
  await nanasa.startAll(group.id);
  await page.goto(deepLink(nanasa, `/groups/${group.id}/messages`));
  await expect(page).toHaveURL(new RegExp(`/groups/${group.id}/messages$`));
  await expect(page.getByRole("region", { name: "Group messages" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("region", { name: "Group messages" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Route team sections" })
    .getByRole("link", { name: "Attention", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/groups/${group.id}/activity$`));
  await expect(page.getByRole("heading", { name: "Attention" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Group messages" })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("region", { name: "Group messages" })).toBeVisible();
  await page.goForward();
  await expect(page.locator("h1", { hasText: "Route team" })).toBeFocused();

  await page.goto(`${nanasa.baseUrl}/groups/${group.id}/activity#wait-example`);
  await expect(page).toHaveURL(new RegExp(`/groups/${group.id}/activity#wait-example$`));
  await expect(page.getByRole("heading", { name: "Attention" })).toBeVisible();
  await page.goto(`${nanasa.baseUrl}/groups/${group.id}/activity#action-example`);
  await expect(page).toHaveURL(new RegExp(`/groups/${group.id}/activity#action-example$`));
  const currentRun = (await nanasa.snapshot()).runs.find((run) => run.groupId === group.id)!;
  await page.goto(`${nanasa.baseUrl}/groups/${group.id}/terminals/${currentRun.id}`);
  await expect(page).toHaveURL(new RegExp(`/groups/${group.id}/terminals/${currentRun.id}$`));
  await expect(page.getByRole("region", { name: "Agent terminals" })).toBeVisible();

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox", { name: "Search commands" }).fill("diagnostics");
  await palette.getByRole("button", { name: /Open diagnostics/ }).click();
  await expect(page).toHaveURL(/\/diagnostics$/);
  await expect(
    page.getByRole("article").getByRole("heading", { name: "Diagnostics" }),
  ).toBeVisible();
});

test("preferences synchronize, mobile switching works, and xterm mounts stay stable", async ({
  context,
  page,
  nanasa,
}) => {
  const { group } = await nanasa.seedGroup("Stable team", ["One", "Two"]);
  await nanasa.startAll(group.id);
  await page.goto(deepLink(nanasa, `/groups/${group.id}/terminals`));
  const mount = page.locator("[data-terminal-mount-id]").first();
  await expect(mount).toBeVisible();
  const mountId = await mount.getAttribute("data-terminal-mount-id");

  const secondPage = await context.newPage();
  await secondPage.goto(`${nanasa.baseUrl}/settings`);
  await secondPage.getByRole("combobox", { name: "Theme", exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(`[data-terminal-mount-id="${mountId}"]`)).toHaveCount(1);

  await page.getByRole("link", { name: "Messages", exact: true }).click();
  await expect(page.getByRole("region", { name: "Group messages" })).toBeVisible();
  await page.getByRole("link", { name: "Terminals", exact: true }).click();
  await expect(page.locator(`[data-terminal-mount-id="${mountId}"]`)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open application menu" }).click();
  const mobileMenu = page.getByRole("dialog", { name: "Nanasa" });
  await expect(mobileMenu.getByRole("link", { name: "Stable team" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await mobileMenu.getByRole("link", { name: "Stable team" }).click();
  await expect(page).toHaveURL(new RegExp(`/groups/${group.id}/terminals`));
});

test("portal has no serious or critical a11y findings at 200 percent zoom", async ({
  page,
  nanasa,
}) => {
  const { group } = await nanasa.seedGroup("Accessible team", ["Keyboard"]);
  await page.goto(deepLink(nanasa, `/groups/${group.id}/terminals`));
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
  await expectNoHighImpactViolations(page);

  await page.locator('summary[aria-label="Portal utilities"]').click();
  await page.getByRole("link", { name: "Preferences", exact: true }).click();
  await page.getByLabel("Motion").selectOption("reduce");
  await page.getByLabel("Contrast").selectOption("forced");
  await expectNoHighImpactViolations(page);
});

test("provider extension catalog previews permissions and runs trusted lifecycle workflows", async ({
  page,
  nanasa,
}) => {
  await page.goto(deepLink(nanasa, "/extensions"));
  await expect(page.getByRole("heading", { name: "Provider catalog" })).toBeVisible();
  await page.getByRole("button", { name: /OpenCode/ }).click();
  await expect(page.getByRole("heading", { name: "Permission preview" })).toBeVisible();
  await expect(page.getByText("runtime:launch-provider")).toBeVisible();
  await expect(page.getByText(/environment names/)).toBeVisible();
  await page.getByRole("button", { name: /Trust exact plan/ }).click();
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByText("disabled", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /Trust exact plan/ }).click();
  await page.getByRole("button", { name: /Repair owned state/ }).click();
  await expect(page.getByText("current", { exact: true }).first()).toBeVisible();
  await expectNoHighImpactViolations(page);
});
