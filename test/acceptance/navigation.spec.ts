import { expect, test } from "@playwright/test";
import { PackageAcceptanceService } from "./fixtures/package-fixture.js";

test("navigation opens Foreman by default and keeps desktop and mobile destinations consistent", async ({
  page,
  browserName,
}, testInfo) => {
  const nanasa = await PackageAcceptanceService.create(browserName);
  try {
    const backend = await nanasa.seedGroup("Backend Team", [
      "Project Manager",
      "Engineer 1",
      "Engineer 2",
    ]);
    await nanasa.seedGroup("Frontend Experience and Accessibility", [
      "Frontend Engineer",
      "Accessibility and Internationalization Reviewer",
    ]);
    await nanasa.seedGroup("Platform", ["Release Engineer"]);
    await page.addInitScript(() =>
      localStorage.setItem(
        "nanasa.portal.preferences.v2",
        JSON.stringify({
          version: 2,
          theme: "light",
          expandedGroupIds: [],
          lastSectionByGroup: {},
        }),
      ),
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(nanasa.portalUrl);
    await expect(page).toHaveURL(/\/foreman$/);
    await expect(page.getByRole("textbox", { name: "Message Foreman", exact: true })).toBeVisible();
    const rail = page.getByRole("complementary", { name: "Groups and agents" });
    const navigation = rail.getByRole("navigation", { name: "Operations" });
    await expect(navigation.getByRole("link")).toHaveText([
      "Foreman",
      "Team workspaces",
      "All agents",
      "Attention",
    ]);
    await expect(navigation.getByRole("link", { name: "Foreman", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await rail.locator('[aria-current="page"]').count()).toBe(1);
    const dimensions = await navigation.getByRole("link").evaluateAll((elements) =>
      elements.map((element) => ({
        height: element.getBoundingClientRect().height,
        font: getComputedStyle(element).fontSize,
        padding: getComputedStyle(element).paddingLeft,
      })),
    );
    expect(new Set(dimensions.map((value) => JSON.stringify(value))).size).toBe(1);
    expect(dimensions[0]?.font).toBe("14px");
    await rail
      .getByRole("button", { name: "Expand Frontend Experience and Accessibility", exact: true })
      .click();
    await page.screenshot({
      path: testInfo.outputPath("sidebar-light-desktop.png"),
      fullPage: true,
    });
    await navigation.getByRole("link", { name: "Team workspaces", exact: true }).click();
    await expect(page).toHaveURL(/\/checkouts$/);
    await expect(
      navigation.getByRole("link", { name: "Team workspaces", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.goto(`${nanasa.baseUrl}/groups/${backend.group.id}/messages`);
    await expect(page.getByRole("heading", { name: "Backend Team", exact: true })).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "Foreman", exact: true }),
    ).not.toHaveAttribute("aria-current", "page");
    await navigation.getByRole("link", { name: "Foreman", exact: true }).click();
    await page.evaluate(() => {
      const key = "nanasa.portal.preferences.v2";
      const value = JSON.stringify({
        ...JSON.parse(localStorage.getItem(key) ?? "{}"),
        theme: "dark",
      });
      localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(navigation).toBeVisible();
    const expandFrontend = rail.getByRole("button", {
      name: "Expand Frontend Experience and Accessibility",
      exact: true,
    });
    if (await expandFrontend.count()) await expandFrontend.click();
    await page.screenshot({
      path: testInfo.outputPath("sidebar-dark-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open application menu", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Nanasa", exact: true });
    await expect(menu).toBeVisible();
    await menu
      .getByRole("button", {
        name: "Expand Frontend Experience and Accessibility members",
        exact: true,
      })
      .click();
    await expect(
      menu.getByRole("link", { name: /Accessibility and Internationalization Reviewer/ }),
    ).toBeVisible();
    await expect(menu.getByRole("button", { name: "Console", exact: true })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Platform", exact: true })).toBeInViewport();
    await expect(
      menu.getByRole("link", { name: /Accessibility and Internationalization Reviewer/ }),
    ).toBeInViewport();
    await expect(menu.getByRole("navigation", { name: "Operations" }).getByRole("link")).toHaveText(
      ["Foreman", "Team workspaces", "All agents", "Attention"],
    );
    await page.screenshot({ path: testInfo.outputPath("sidebar-dark-mobile.png"), fullPage: true });
    await menu.getByRole("button", { name: "Use light theme", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.screenshot({
      path: testInfo.outputPath("sidebar-light-mobile.png"),
      fullPage: true,
    });
    await menu.getByRole("link", { name: "Foreman", exact: true }).click();
    await expect(menu).not.toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Foreman", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await nanasa.close();
  }
});
