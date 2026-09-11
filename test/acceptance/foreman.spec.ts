import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ForemanWorkspace } from "@nanasa/contracts";
import { expect, test } from "@playwright/test";
import { PackageAcceptanceService } from "./fixtures/package-fixture.js";

test("Foreman channel, native terminal, mission control, and restart use the packaged daemon", async ({
  page,
  browserName,
}, testInfo) => {
  const nanasa = await PackageAcceptanceService.create(browserName, { foreman: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page
      .getByRole("textbox", { name: "Message Foreman", exact: true })
      .fill("Plan bounded work");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Fixture reply: Plan bounded work", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    expect((await nanasa.snapshot()).memberships).toHaveLength(0);
    const before = await nanasa.request<ForemanWorkspace>("/api/v1/foreman");
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await expect(page.getByText("Control mode", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Terminal input", exact: true }).fill("native-input");
    await page.getByRole("textbox", { name: "Terminal input", exact: true }).press("Enter");
    await expect
      .poll(() => nanasa.capturePane(before.run!.terminal!.paneId))
      .toContain("SAFE_FOREMAN:native-input");
    await page.screenshot({ path: testInfo.outputPath("foreman-terminal-desktop.png") });
    await page.getByRole("tab", { name: "Channel", exact: true }).click();
    await nanasa.restartDaemon();
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await page.reload();
    await expect(page.getByText("Fixture reply: Plan bounded work", { exact: true })).toBeVisible();
    expect((await nanasa.request<ForemanWorkspace>("/api/v1/foreman")).run?.id).toBe(
      before.run?.id,
    );
    await page.getByRole("tab", { name: "Missions", exact: true }).click();
    await page.getByRole("button", { name: "New mission", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Acceptance mission");
    await page
      .getByRole("textbox", { name: "Objective", exact: true })
      .fill("Exercise durable review and operator control");
    await page
      .getByRole("textbox", { name: "Acceptance criteria", exact: true })
      .fill("Approved checks pass");
    await page.getByRole("button", { name: "Create mission", exact: true }).click();
    await page.getByRole("button", { name: "Start mission", exact: true }).click();
    await expect(page.getByText("1/200", { exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "Pause mission", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume mission", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const tops = await page
      .getByRole("tablist", { name: "Foreman views" })
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath("foreman-mission-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Revoke mission", exact: true }).click();
    await expect(page.getByText("revoked", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect
      .poll(
        async () => (await nanasa.request<ForemanWorkspace>("/api/v1/foreman")).run?.desiredState,
      )
      .toBe("stopped");
  } catch (error) {
    const database = new DatabaseSync(
      join(nanasa.configRoot, ".nanasa", "state", "nanasa.sqlite"),
      { readOnly: true },
    );
    try {
      const readiness = database
        .prepare(
          "SELECT json_extract(reducer_state_json, '$.state') AS state, json_extract(reducer_state_json, '$.processState') AS process, json_extract(reducer_state_json, '$.interactiveReady') AS ready, json_extract(reducer_state_json, '$.authorityKind') AS authority FROM status_revisions",
        )
        .all();
      const rejections = database
        .prepare("SELECT code, COUNT(*) AS count FROM reporter_rejections GROUP BY code")
        .all();
      await testInfo.attach("foreman-readiness", {
        body: JSON.stringify({ readiness, rejections }),
        contentType: "text/plain",
      });
    } finally {
      database.close();
    }
    await testInfo.attach("foreman-terminal", {
      body: nanasa.captureAllPanes(),
      contentType: "text/plain",
    });
    const state = await nanasa.request<ForemanWorkspace>("/api/v1/foreman");
    await testInfo.attach("foreman-input-state", {
      body: JSON.stringify({
        runStatus: state.run?.status,
        problem: state.problem,
        inbox: state.inbox,
      }),
      contentType: "application/json",
    });
    throw error;
  } finally {
    await nanasa.close();
  }
});
