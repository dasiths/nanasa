import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { PortalSnapshot } from "@nanasa/contracts";
import { expect, test } from "./fixtures/package-fixture.js";

test("failed active recovery can stop and start fresh without interrupting a teammate", async ({
  page,
  nanasa,
}, testInfo) => {
  const { group, agents } = await nanasa.seedGroup("Restart team", ["Engineer", "Teammate"]);
  await nanasa.startAll(group.id);
  const before = await nanasa.snapshot();
  const original = before.runs.find(
    (run) => run.memberId === agents[0]!.memberId && run.status === "running",
  )!;
  const teammate = before.runs.find(
    (run) => run.memberId === agents[1]!.memberId && run.status === "running",
  )!;
  await page.route("**/api/v1/snapshot", async (route) => {
    const response = await route.fetch();
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
  await page.goto(`${nanasa.baseUrl}/groups/${group.id}/members${new URL(nanasa.portalUrl).hash}`);
  await page.getByRole("button", { name: "Inspect Engineer", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Agent configuration" });
  await inspector.getByRole("button", { name: "Session", exact: true }).click();
  await expect(inspector.getByRole("button", { name: "Start agent", exact: true })).toBeDisabled();
  await inspector.getByRole("button", { name: "Stop run", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop Engineer?", exact: true })
    .getByRole("button", { name: "Stop run", exact: true })
    .click();
  await expect(inspector.getByRole("button", { name: "Start agent", exact: true })).toBeEnabled();
  await inspector.getByRole("button", { name: "Start agent", exact: true }).click();
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
  expect(fresh).toMatchObject({ recoveryAttempts: 0, launchKind: "fresh" });
  expect(fresh.nativeSessionId).toBeUndefined();
  expect(fresh.generation).toBeGreaterThan(original.generation);
  expect(after.runs.find((run) => run.id === teammate.id)).toMatchObject({
    status: "running",
    terminal: { paneId: teammate.terminal!.paneId },
  });
  expect(nanasa.paneExists(teammate.terminal!.paneId)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("fresh-restart.png") });
});

test("production entity workspaces expose their complete desktop and mobile views", async ({
  page,
  nanasa,
}) => {
  test.setTimeout(180_000);
  const backend = await nanasa.seedGroup("Backend Team", ["Engineer", "Reviewer"]);
  await nanasa.seedGroup("Frontend Team", ["Designer"]);
  await nanasa.startAll(backend.group.id);
  const run = (await nanasa.snapshot()).runs.find(
    (item) => item.groupId === backend.group.id && item.status === "running",
  )!;
  await nanasa.waitForTerminalReady(run.id);
  const output = resolve("test-results/portal-production");
  mkdirSync(output, { recursive: true });
  const captures: string[] = [];
  await page.goto(`${nanasa.baseUrl}/agents${new URL(nanasa.portalUrl).hash}`);
  await expect(page.getByRole("button", { name: "Inspect Engineer", exact: true })).toBeVisible();
  for (const [width, theme] of [
    [1440, "light"],
    [1440, "dark"],
    [390, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${nanasa.baseUrl}/settings`);
    await page
      .getByRole("group", { name: "Theme", exact: true })
      .getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true })
      .click();
    const capture = async (name: string) => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await page.screenshot({ path: resolve(output, `${name}-${theme}-${width}.png`) });
      captures.push(`${name}-${theme}-${width}.png`);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        name,
      ).toBe(true);
    };
    for (const route of [
      "agents",
      "teams",
      "attention",
      "checkouts",
      "extensions",
      "diagnostics",
      "settings",
      "service",
      "remote",
      "help",
      "release",
    ]) {
      await page.goto(`${nanasa.baseUrl}/${route}`);
      await expect(page.locator("article.route-surface")).toBeVisible();
      await capture(route);
      if (route === "agents") {
        await page.getByRole("button", { name: "Inspect Engineer", exact: true }).click();
        const inspector = page.getByRole("complementary", { name: "Agent configuration" });
        for (const tab of ["Configuration", "Prompt layers", "Session", "Attention"]) {
          await inspector.getByRole("button", { name: tab, exact: true }).click();
          await capture(`agent-${tab.toLowerCase().replaceAll(" ", "-")}`);
        }
        await inspector.getByRole("button", { name: "Configuration", exact: true }).click();
        await inspector
          .getByRole("button", { name: "Edit agent settings Engineer", exact: true })
          .click();
        await capture("agent-edit");
        await inspector.getByRole("button", { name: "Cancel", exact: true }).click();
        await inspector.getByRole("button", { name: "Session", exact: true }).click();
        await inspector.getByRole("button", { name: "Stop run", exact: true }).click();
        await capture("agent-stop-impact");
        await page
          .getByRole("dialog", { name: "Stop Engineer?", exact: true })
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await inspector.getByRole("button", { name: "Remove agent", exact: true }).click();
        await capture("agent-remove-impact");
        await page
          .getByRole("dialog", { name: "Remove Engineer?", exact: true })
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await inspector.getByRole("button", { name: "Close inspector", exact: true }).click();
        await page.getByRole("button", { name: "Add agent", exact: true }).click();
        await capture("agent-create");
        await page
          .getByRole("dialog", { name: "Add agent", exact: true })
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
      } else if (route === "teams") {
        await page.getByRole("button", { name: "Inspect team Backend Team", exact: true }).click();
        await capture("team-inspector");
        await page
          .getByRole("button", { name: "Edit group settings Backend Team", exact: true })
          .click();
        await capture("team-edit");
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.getByRole("button", { name: "Delete group", exact: true }).click();
        await capture("team-delete-impact");
        await page
          .getByRole("dialog", { name: "Delete Backend Team?", exact: true })
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
      } else if (route === "checkouts") {
        await page
          .getByRole("button", { name: /^Inspect workspace / })
          .first()
          .click();
        for (const tab of ["Assignment", "Git facts", "Maintenance"]) {
          await page
            .getByRole("navigation", { name: "Workspace details" })
            .getByRole("button", { name: tab, exact: true })
            .click();
          await capture(`workspace-${tab.toLowerCase().replaceAll(" ", "-")}`);
        }
      } else if (route === "extensions") {
        await expect(page.locator(".extension-catalog .entity-row").first()).toBeVisible();
        await page.locator(".extension-catalog .entity-row").first().click();
        await expect(page.locator(".extension-detail")).toBeVisible();
        for (const tab of ["Overview", "Plan", "Lifecycle"]) {
          await page
            .getByRole("navigation", { name: "Provider details" })
            .getByRole("button", { name: tab, exact: true })
            .click();
          await capture(`provider-${tab.toLowerCase()}`);
        }
      }
    }
    for (const section of ["members", "terminals", "messages", "activity"]) {
      await page.goto(`${nanasa.baseUrl}/groups/${backend.group.id}/${section}`);
      await expect(page.getByRole("heading", { name: "Backend Team", exact: true })).toBeVisible();
      await capture(`team-${section}`);
      if (section === "messages") {
        await page
          .getByRole("textbox", { name: "Message body", exact: true })
          .fill("Production visual review message");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("region", { name: "Message history" })).toContainText(
          "Production visual review message",
        );
        await expect(page.getByRole("button", { name: "Sending...", exact: true })).toHaveCount(0);
        await expect(page.locator(".message-history-list > li").last()).toContainText(
          "terminal_injected",
        );
        await capture("message-delivered");
      }
      if (section === "terminals") {
        await page.getByRole("button", { name: "Focus terminal Engineer", exact: true }).click();
        await expect(
          page.locator(".terminal-pane-slot:not([hidden]) .terminal-lease-status"),
        ).toContainText(/Control mode|Observe mode/i);
        await expect(page.locator(".terminal-pane-slot:not([hidden]) .xterm-screen")).toBeVisible();
        await expect(page.locator(".terminal-pane-slot:not([hidden]) .xterm-screen")).toContainText(
          /SAFE_ECHO(?:_READY)?:/,
        );
        await expect(
          page.locator(".terminal-pane-slot:not([hidden]) .terminal-lease-status"),
        ).toContainText("connected");
        const headerBounds = await page
          .locator(".terminal-pane-slot:not([hidden]) .terminal-lease-banner")
          .boundingBox();
        const modeBounds = await page
          .locator(".terminal-pane-slot:not([hidden]) .terminal-lease-status strong")
          .boundingBox();
        const toolsBounds = await page
          .locator(".terminal-pane-slot:not([hidden]) .terminal-banner-actions")
          .boundingBox();
        expect(modeBounds!.y + modeBounds!.height).toBeLessThanOrEqual(
          headerBounds!.y + headerBounds!.height,
        );
        expect(toolsBounds!.y + toolsBounds!.height).toBeLessThanOrEqual(
          headerBounds!.y + headerBounds!.height,
        );
        expect(modeBounds!.x + modeBounds!.width).toBeLessThanOrEqual(width);
        await capture("terminal-focused");
      }
    }
    await page.goto(`${nanasa.baseUrl}/agents`);
    await expect(page.locator(".agent-directory")).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).include(".agent-directory").analyze();
    expect(
      accessibility.violations
        .filter((item) => ["serious", "critical"].includes(item.impact ?? ""))
        .map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })),
    ).toEqual([]);
  }
  writeFileSync(
    resolve(output, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nanasa production UI review</title><style>body{margin:24px;font:15px sans-serif;background:#f3f6f4;color:#1d2b24}h1{font-size:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}figure{margin:0}img{display:block;width:100%;height:300px;object-fit:contain;object-position:top;background:#dfe7e2}figcaption{padding:8px 0;font-size:12px;overflow-wrap:anywhere}a{color:#1c6852}</style><h1>Nanasa production UI review</h1><p>${captures.length} actual portal captures: desktop light/dark and mobile dark.</p><main>${captures.map((file) => `<figure><a href="${file}"><img loading="lazy" src="${file}" alt="${file.replaceAll("-", " ")}"></a><figcaption>${file}</figcaption></figure>`).join("")}</main></html>`,
  );
});
