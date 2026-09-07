import { expect, test } from "./fixtures/package-fixture.js";

test("supplied logo replaces rail text without crowding controls", async ({
  page,
  nanasa,
}, testInfo) => {
  const { group } = await nanasa.seedGroup("Brand check", ["Engineer"]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(nanasa.portalUrl);
  const rail = page.getByRole("complementary", { name: "Groups and agents" });
  const logo = rail.getByRole("img", { name: "Nanasa", exact: true });
  await expect(logo).toBeVisible();
  await expect
    .poll(() =>
      logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  const heading = rail.locator(".rail-heading");
  await expect(heading.getByText("Operations", { exact: true })).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.locator('summary[aria-label="Portal utilities"]').click();
    await page.getByRole("button", { name: `Use ${theme} theme`, exact: true }).click();
    await page.locator('summary[aria-label="Portal utilities"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const imageBounds = await logo.boundingBox();
    const actionBounds = await heading.locator(".rail-heading-actions").boundingBox();
    expect(imageBounds!.x + imageBounds!.width).toBeLessThanOrEqual(actionBounds!.x);
    expect(imageBounds!.width / imageBounds!.height).toBeCloseTo(1391 / 374, 1);
    await expect(
      heading.getByRole("button", { name: "Open command palette", exact: true }),
    ).toBeVisible();
    await expect(heading.getByRole("button", { name: "Create group", exact: true })).toBeVisible();
    for (const width of [1920, 1280]) {
      await page.setViewportSize({ width, height: 1080 });
      for (const section of ["terminals", "messages", "activity"]) {
        await page.goto(`${nanasa.baseUrl}/groups/${group.id}/${section}`);
        await expect(page.getByRole("heading", { name: "Brand check", exact: true })).toBeVisible();
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        const railBounds = await heading.boundingBox();
        const headerBounds = await page.locator(".workspace-header").boundingBox();
        expect(
          Math.abs(railBounds!.y + railBounds!.height - headerBounds!.y - headerBounds!.height),
        ).toBeLessThanOrEqual(1);
        await expect(page.getByRole("navigation", { name: "Brand check sections" })).toBeVisible();
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${nanasa.baseUrl}/groups/${group.id}/terminals`);
    await expect(page.getByRole("heading", { name: "Brand check", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`portal-brand-${theme}.png`) });
  }
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(page.getByRole("navigation", { name: "Brand check sections" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Open application menu", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
