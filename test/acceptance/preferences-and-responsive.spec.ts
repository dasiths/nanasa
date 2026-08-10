import { expect, test } from "./fixtures/package-fixture.js";

test("theme and terminal layout persist and synchronize across tabs", async ({
  context,
  page,
  nanasa,
}) => {
  const { group } = await nanasa.seedGroup("Preferences team", ["One", "Two"]);
  await nanasa.startAll(group.id);
  const secondPage = await context.newPage();
  await Promise.all([page.goto(nanasa.baseUrl), secondPage.goto(nanasa.baseUrl)]);

  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(secondPage.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Grid terminal layout" }).click();
  await expect(page.getByRole("button", { name: "Grid terminal layout" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(secondPage.getByRole("button", { name: "Grid terminal layout" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await secondPage.reload();
  await expect(secondPage.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(secondPage.getByRole("button", { name: "Grid terminal layout" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("desktop and mobile layouts remain usable without horizontal overflow", async ({
  page,
  nanasa,
}) => {
  await nanasa.seedGroup("Responsive team", ["Narrow"]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(nanasa.baseUrl);

  const desktopRail = await page
    .getByRole("complementary", { name: "Groups and agents" })
    .boundingBox();
  const desktopWorkspace = await page.locator(".workspace").boundingBox();
  expect(desktopRail).not.toBeNull();
  expect(desktopWorkspace).not.toBeNull();
  expect(desktopWorkspace!.x).toBeGreaterThanOrEqual(desktopRail!.x + desktopRail!.width - 1);
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  const desktopMessages = await page
    .getByRole("region", { name: "Messages overlay" })
    .boundingBox();
  expect(desktopMessages).not.toBeNull();
  expect(desktopMessages!.x).toBeGreaterThan(desktopWorkspace!.x);
  expect(desktopMessages!.y).toBeGreaterThan(0);
  expect(desktopMessages!.x + desktopMessages!.width).toBeLessThanOrEqual(1280);
  expect(desktopMessages!.y + desktopMessages!.height).toBeLessThanOrEqual(800);

  await expect(page.getByLabel("Message body")).toHaveCount(0);
  await expect(page.getByLabel("Compose message")).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent terminals" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const mobileRail = await page
    .getByRole("complementary", { name: "Groups and agents" })
    .boundingBox();
  const mobileWorkspace = await page.locator(".workspace").boundingBox();
  expect(mobileRail).not.toBeNull();
  expect(mobileWorkspace).not.toBeNull();
  expect(mobileWorkspace!.y).toBeGreaterThanOrEqual(mobileRail!.y + mobileRail!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("region", { name: "Messages overlay" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Messages", exact: true })).toBeHidden();
  await expect(page.getByRole("region", { name: "Messages", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent terminals" })).toBeVisible();
  await expect(page.getByLabel("Compose message")).toBeVisible();
  await expect(page.getByLabel("Message body")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start all non-running agents in Responsive team" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Remove agent Narrow" }).click();
  const memberDialog = page.getByRole("dialog", { name: "Remove Narrow?" });
  await expect(memberDialog).toBeVisible();
  await expect(memberDialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(memberDialog.getByRole("button", { name: "Remove agent" })).toBeVisible();
  const memberDialogBounds = await memberDialog.boundingBox();
  expect(memberDialogBounds).not.toBeNull();
  expect(memberDialogBounds!.x).toBeGreaterThanOrEqual(0);
  expect(memberDialogBounds!.y).toBeGreaterThanOrEqual(0);
  expect(memberDialogBounds!.x + memberDialogBounds!.width).toBeLessThanOrEqual(390);
  expect(memberDialogBounds!.y + memberDialogBounds!.height).toBeLessThanOrEqual(844);
  await memberDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Delete group Responsive team" }).click();
  const groupDialog = page.getByRole("dialog", { name: "Delete Responsive team?" });
  await expect(groupDialog).toBeVisible();
  await expect(groupDialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(groupDialog.getByRole("button", { name: "Delete group" })).toBeVisible();
  const groupDialogBounds = await groupDialog.boundingBox();
  expect(groupDialogBounds).not.toBeNull();
  expect(groupDialogBounds!.x).toBeGreaterThanOrEqual(0);
  expect(groupDialogBounds!.y).toBeGreaterThanOrEqual(0);
  expect(groupDialogBounds!.x + groupDialogBounds!.width).toBeLessThanOrEqual(390);
  expect(groupDialogBounds!.y + groupDialogBounds!.height).toBeLessThanOrEqual(844);
  await groupDialog.getByRole("button", { name: "Cancel" }).click();
});
