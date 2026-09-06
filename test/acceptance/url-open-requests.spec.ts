import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures/package-fixture.js";

test("managed browser requests become actionable Attention on desktop and mobile", async ({
  page,
  context,
  nanasa,
}, testInfo) => {
  const team = await nanasa.seedGroup("Browser requests", ["Browser Agent"]);
  await nanasa.startAll(team.group.id);
  const run = (await nanasa.snapshot()).runs.find(
    (candidate) => candidate.groupId === team.group.id && candidate.status === "running",
  )!;
  await nanasa.waitForTerminalReady(run.id);
  const pid = execFileSync(
    "tmux",
    ["-L", nanasa.tmuxServer, "display-message", "-p", "-t", run.terminal!.paneId, "#{pane_pid}"],
    { encoding: "utf8" },
  ).trim();
  const environment = Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
  let referer: string | undefined;
  await context.route("https://browser-request.invalid/**", async (route) => {
    referer = route.request().headers().referer;
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Requested URL</title><h1>Requested URL</h1>",
    });
  });
  const loaded = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/url-open-requests") && response.ok(),
  );
  await page.goto(`${nanasa.baseUrl}/agents${new URL(nanasa.portalUrl).hash}`);
  await loaded;
  await expect(
    page.getByRole("heading", { name: "All agents", exact: true, level: 1 }),
  ).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const url = `https://browser-request.invalid/login?code=private-${viewport.width}`;
    execFileSync(environment.BROWSER!, [url], { env: { ...process.env, ...environment } });
    const notices = page.getByRole("complementary", { name: "Attention notifications" });
    await expect(notices).toContainText("Browser Agent wants to open a URL");
    await expect(notices).not.toContainText("private");
    await notices.getByRole("button", { name: "Open", exact: true }).click();
    const item = page
      .locator(".attention-inbox-row")
      .filter({ hasText: "Browser Agent wants to open a URL" });
    await expect(item.getByRole("button", { name: "Open URL", exact: true })).toBeVisible();
    await item.getByText("Full URL", { exact: true }).click();
    await expect(item).toContainText(url);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`url-request-${viewport.width}.png`),
      fullPage: true,
    });
    const popupPromise = page.waitForEvent("popup");
    await item.getByRole("button", { name: "Open URL", exact: true }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(url);
    await expect(popup.getByRole("heading", { name: "Requested URL" })).toBeVisible();
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(referer).toBeUndefined();
    await popup.close();
    await expect(item).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Attention", exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Open URL", exact: true })).toHaveCount(0);
  }
});
