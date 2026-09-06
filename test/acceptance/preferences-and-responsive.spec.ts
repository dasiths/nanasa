import { expect, test } from "./fixtures/package-fixture.js";

test("theme and terminal columns persist and synchronize across tabs", async ({
  context,
  page,
  nanasa,
}) => {
  const { group } = await nanasa.seedGroup("Preferences team", ["One", "Two"]);
  await nanasa.startAll(group.id);
  const secondPage = await context.newPage();
  await page.goto(nanasa.portalUrl);
  await secondPage.goto(nanasa.baseUrl);

  await page.locator('summary[aria-label="Portal utilities"]').click();
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(secondPage.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "2 terminal columns" }).click();
  await expect(page.getByRole("button", { name: "2 terminal columns" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(secondPage.getByRole("button", { name: "2 terminal columns" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await Promise.all([
    page.getByRole("button", { name: "Pin One terminal" }).click(),
    secondPage.getByRole("button", { name: "Pin Two terminal" }).click(),
  ]);
  await expect(page.getByRole("button", { name: "Unpin One terminal" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Unpin Two terminal" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await Promise.all([
    page.getByRole("button", { name: "3 terminal columns" }).click(),
    secondPage.getByRole("button", { name: "Focus One terminal" }).click(),
  ]);
  await expect(page.getByRole("button", { name: "Unpin One terminal" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "3 terminal columns" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem("nanasa.portal.preferences.v2") ?? "{}") as {
        pinnedRunIdsByGroup?: Record<string, string[]>;
      };
      return Object.values(stored.pinnedRunIdsByGroup ?? {})[0]?.length;
    }),
  ).toBe(2);
  await expect(
    secondPage.getByRole("button", { name: "All terminals", exact: true }),
  ).toBeVisible();

  await secondPage.reload();
  await expect(secondPage.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(secondPage.getByRole("button", { name: "3 terminal columns" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(secondPage.getByRole("button", { name: "Unpin One terminal" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(secondPage.getByRole("button", { name: "All terminals", exact: true })).toHaveCount(
    0,
  );
});

test("desktop and mobile layouts remain usable without horizontal overflow", async ({
  page,
  nanasa,
}) => {
  await nanasa.seedGroup("Responsive team", ["Narrow"]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(nanasa.portalUrl);

  const desktopRail = await page
    .getByRole("complementary", { name: "Groups and agents" })
    .boundingBox();
  const desktopWorkspace = await page.locator(".workspace").boundingBox();
  expect(desktopRail).not.toBeNull();
  expect(desktopWorkspace).not.toBeNull();
  expect(desktopWorkspace!.x).toBeGreaterThanOrEqual(desktopRail!.x + desktopRail!.width - 1);
  await expect(
    page
      .getByRole("navigation", { name: "Operations" })
      .getByRole("link", { name: "Attention", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Attention" })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Compose message to Responsive team" }),
  ).toBeVisible();
  await expect(page.getByLabel("Message body")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Agent terminals" })).toBeVisible();
  await page.getByRole("button", { name: "Compose message to Responsive team" }).click();
  await expect(page.getByRole("dialog", { name: "New message" })).toBeVisible();
  await page.getByRole("button", { name: "Close message composer" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const mobileRail = await page.locator(".group-rail").boundingBox();
  const mobileWorkspace = await page.locator(".workspace").boundingBox();
  expect(mobileRail).toBeNull();
  expect(mobileWorkspace).not.toBeNull();
  const project = await page.getByRole("region", { name: "Project context" }).boundingBox();
  expect(mobileWorkspace!.y).toBeGreaterThanOrEqual(project!.y + project!.height);
  await expect(page.getByRole("button", { name: "Open application menu" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Attention" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("region", { name: "Agent terminals" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Compose message to Responsive team" }),
  ).toBeVisible();
  await expect(page.getByLabel("Message body")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start all non-running agents in Responsive team" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open application menu" }).click();
  const mobileMenu = page.getByRole("dialog", { name: "Nanasa" });
  await expect(mobileMenu.getByRole("link", { name: "Attention", exact: true })).toBeVisible();
  await expect(mobileMenu.getByRole("link", { name: "Responsive team" })).toBeVisible();
  await mobileMenu.getByText("More", { exact: true }).click();
  await expect(mobileMenu.getByRole("link", { name: "Preferences" })).toBeVisible();
  await mobileMenu.getByRole("button", { name: "Close menu" }).click();

  await page.setViewportSize({ width: 320, height: 720 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(page.getByRole("button", { name: "Open application menu" })).toBeVisible();
  const groupNavigation = page.getByRole("navigation", { name: "Responsive team sections" });
  await expect(groupNavigation.getByRole("link", { name: "Terminals" })).toBeVisible();
  await expect(groupNavigation.getByRole("link", { name: "Attention" })).toBeVisible();
  await expect(groupNavigation.getByRole("link", { name: "Members" })).toBeVisible();

  await page.setViewportSize({ width: 721, height: 844 });
  await groupNavigation.getByRole("link", { name: "Members", exact: true }).click();
  const memberRow = page.getByRole("button", { name: "Inspect Narrow", exact: true });
  await memberRow.click();
  const details = page.getByRole("complementary", { name: "Agent configuration" });
  await expect(details).toBeVisible();
  const detailsBounds = await details.boundingBox();
  expect(detailsBounds).not.toBeNull();
  expect(detailsBounds!.x).toBeGreaterThanOrEqual(0);
  expect(detailsBounds!.x + detailsBounds!.width).toBeLessThanOrEqual(721);
  await expect(memberRow).toBeHidden();
  await details.getByRole("button", { name: "Back to list", exact: true }).click();
  await expect(memberRow).toBeVisible();
  await memberRow.click();
  await details.getByRole("button", { name: "Session", exact: true }).click();
  await details.getByRole("button", { name: "Remove agent", exact: true }).click();
  const memberDialog = page.getByRole("dialog", { name: "Remove Narrow?" });
  await expect(memberDialog).toBeVisible();
  await expect(memberDialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(memberDialog.getByRole("button", { name: "Remove agent" })).toBeVisible();
  const memberDialogBounds = await memberDialog.boundingBox();
  expect(memberDialogBounds).not.toBeNull();
  expect(memberDialogBounds!.x).toBeGreaterThanOrEqual(0);
  expect(memberDialogBounds!.y).toBeGreaterThanOrEqual(0);
  expect(memberDialogBounds!.x + memberDialogBounds!.width).toBeLessThanOrEqual(721);
  expect(memberDialogBounds!.y + memberDialogBounds!.height).toBeLessThanOrEqual(844);
  await memberDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Open application menu", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Nanasa", exact: true })
    .getByRole("link", { name: "Teams", exact: true })
    .click();
  await page.getByRole("button", { name: "Inspect team Responsive team", exact: true }).click();
  await page.getByRole("button", { name: "Delete group", exact: true }).click();
  const groupDialog = page.getByRole("dialog", { name: "Delete Responsive team?" });
  await expect(groupDialog).toBeVisible();
  await expect(groupDialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(groupDialog.getByRole("button", { name: "Delete group" })).toBeVisible();
  const groupDialogBounds = await groupDialog.boundingBox();
  expect(groupDialogBounds).not.toBeNull();
  expect(groupDialogBounds!.x).toBeGreaterThanOrEqual(0);
  expect(groupDialogBounds!.y).toBeGreaterThanOrEqual(0);
  expect(groupDialogBounds!.x + groupDialogBounds!.width).toBeLessThanOrEqual(721);
  expect(groupDialogBounds!.y + groupDialogBounds!.height).toBeLessThanOrEqual(844);
  await groupDialog.getByRole("button", { name: "Cancel" }).click();
});

test("recovery results remain bounded and operable in portrait and landscape", async ({
  page,
  nanasa,
}) => {
  const { group } = await nanasa.seedGroup("Recovery layout team", ["Layout agent"]);
  await nanasa.startAll(group.id);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(nanasa.portalUrl);

  await page
    .getByRole("button", { name: "Check setup and restart needs for Recovery layout team" })
    .click();
  const trigger = page.getByRole("button", { name: "View results" });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Team recovery preview" });
  const body = dialog.locator(".recovery-results-body");
  const footer = dialog.locator(".recovery-results-footer");
  await expect(dialog.getByRole("heading", { name: "Agent outcomes" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recover team" })).toBeVisible();

  const portraitBounds = await dialog.boundingBox();
  expect(portraitBounds).not.toBeNull();
  expect(portraitBounds!.x).toBeGreaterThanOrEqual(0);
  expect(portraitBounds!.y).toBeGreaterThanOrEqual(0);
  expect(portraitBounds!.x + portraitBounds!.width).toBeLessThanOrEqual(360);
  expect(portraitBounds!.y + portraitBounds!.height).toBeLessThanOrEqual(800);
  expect(portraitBounds!.width).toBeGreaterThanOrEqual(340);
  expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  expect(
    await footer.evaluate((element) => ({
      position: getComputedStyle(element).position,
      bottom: getComputedStyle(element).bottom,
    })),
  ).toEqual({ position: "sticky", bottom: "0px" });

  await page.setViewportSize({ width: 800, height: 360 });
  const landscapeBounds = await dialog.boundingBox();
  expect(landscapeBounds).not.toBeNull();
  expect(landscapeBounds!.x).toBeGreaterThanOrEqual(0);
  expect(landscapeBounds!.y).toBeGreaterThanOrEqual(0);
  expect(landscapeBounds!.x + landscapeBounds!.width).toBeLessThanOrEqual(800);
  expect(landscapeBounds!.y + landscapeBounds!.height).toBeLessThanOrEqual(360);
  expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  await expect(dialog.getByRole("button", { name: "Recover team" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
