import { expect, test } from "./fixtures/package-fixture.js";

test("theme and terminal layout persist and synchronize across tabs", async ({
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

  await page.getByRole("button", { name: "Grid terminal layout" }).click();
  await expect(page.getByRole("button", { name: "Grid terminal layout" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(secondPage.getByRole("button", { name: "Grid terminal layout" })).toHaveAttribute(
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
    page.getByRole("slider", { name: "Terminal split ratio" }).fill("65"),
    secondPage.getByRole("button", { name: "Maximize One terminal" }).click(),
  ]);
  await expect(page.getByRole("button", { name: "Unpin One terminal" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Restore One terminal" })).toHaveAttribute(
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
  await expect(page.getByRole("slider", { name: "Terminal split ratio" })).toHaveValue("65");
  await expect(secondPage.getByRole("button", { name: "Restore One terminal" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await secondPage.reload();
  await expect(secondPage.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(secondPage.getByRole("button", { name: "Grid terminal layout" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(secondPage.getByRole("button", { name: "Unpin One terminal" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(secondPage.getByRole("slider", { name: "Terminal split ratio" })).toHaveValue("65");
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
      .getByRole("navigation", { name: "Repository operations" })
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
  expect(mobileWorkspace!.y).toBe(0);
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
  await expect(mobileMenu.getByRole("link", { name: "Preferences" })).toBeVisible();
  await mobileMenu.getByRole("button", { name: "Close menu" }).click();

  await page.setViewportSize({ width: 320, height: 720 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(page.getByRole("button", { name: "Open application menu" })).toBeVisible();
  const groupNavigation = page.getByRole("navigation", { name: "Responsive team sections" });
  await expect(groupNavigation.getByRole("link", { name: "Terminals" })).toBeVisible();
  await expect(groupNavigation.getByRole("link", { name: "Attention" })).toBeVisible();
  await expect(groupNavigation.getByRole("link", { name: "Overview" })).toBeVisible();

  await page.setViewportSize({ width: 721, height: 844 });
  const groupRow = page.locator(".tree-group-row").filter({ hasText: "Responsive team" });
  const groupLabelBounds = await groupRow.locator(".tree-select").boundingBox();
  const groupActionBounds = await groupRow
    .getByRole("button", { name: "Actions for group Responsive team" })
    .boundingBox();
  expect(groupLabelBounds).not.toBeNull();
  expect(groupActionBounds).not.toBeNull();
  expect(groupLabelBounds!.x + groupLabelBounds!.width).toBeLessThanOrEqual(groupActionBounds!.x);

  const memberRow = page.locator(".member-row").filter({ hasText: "Narrow" });
  const memberLabelBounds = await memberRow
    .getByRole("button", { name: "View details for Narrow" })
    .boundingBox();
  const memberActionBounds = await memberRow
    .getByRole("button", { name: "Actions for agent Narrow" })
    .boundingBox();
  expect(memberLabelBounds).not.toBeNull();
  expect(memberActionBounds).not.toBeNull();
  expect(memberLabelBounds!.x + memberLabelBounds!.width).toBeLessThanOrEqual(
    memberActionBounds!.x,
  );

  await memberRow.getByRole("button", { name: "View details for Narrow" }).click();
  const details = page.getByRole("dialog", { name: "Agent details for Narrow" });
  await expect(details).toBeVisible();
  const detailsBounds = await details.boundingBox();
  expect(detailsBounds).not.toBeNull();
  expect(detailsBounds!.x).toBeGreaterThanOrEqual(0);
  expect(detailsBounds!.x + detailsBounds!.width).toBeLessThanOrEqual(721);
  expect(
    await details.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      pointerEvents: getComputedStyle(element).pointerEvents,
    })),
  ).toEqual({ overflowY: "auto", pointerEvents: "auto" });
  await details.getByRole("button", { name: "Close details for Narrow" }).click();

  await memberRow.getByRole("button", { name: "Actions for agent Narrow" }).click();
  const memberMenu = page.getByRole("menu", { name: "Actions for agent Narrow" });
  const memberMenuBounds = await memberMenu.boundingBox();
  expect(memberMenuBounds).not.toBeNull();
  expect(memberMenuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(memberMenuBounds!.x + memberMenuBounds!.width).toBeLessThanOrEqual(721);
  await memberMenu.getByRole("menuitem", { name: "Remove agent Narrow" }).click();
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

  await groupRow.getByRole("button", { name: "Actions for group Responsive team" }).click();
  const groupMenu = page.getByRole("menu", { name: "Actions for group Responsive team" });
  const groupMenuBounds = await groupMenu.boundingBox();
  expect(groupMenuBounds).not.toBeNull();
  expect(groupMenuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(groupMenuBounds!.x + groupMenuBounds!.width).toBeLessThanOrEqual(721);
  await groupMenu.getByRole("menuitem", { name: "Delete group Responsive team" }).click();
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
