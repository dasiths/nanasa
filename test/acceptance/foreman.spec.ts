import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ForemanWorkspace } from "@nanasa/contracts";
import { expect, test } from "@playwright/test";
import { PackageAcceptanceService } from "./fixtures/package-fixture.js";

test("Foreman goals accept high-level outcomes and retain human control across restart", async ({
  page,
  browserName,
}, testInfo) => {
  const nanasa = await PackageAcceptanceService.create(browserName, { foreman: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Concurrent goals", exact: true }).fill("2");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await nanasa.request<ForemanWorkspace>("/api/v1/foreman")).configuration?.autonomy
            .maxActiveGoals,
      )
      .toBe(2);
    await page.getByRole("tab", { name: "Goals", exact: true }).click();
    await page.getByRole("button", { name: "New goal", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("SDK draft-10 conformance");
    await page
      .getByRole("textbox", { name: "Goal", exact: true })
      .fill(
        "Research the specification, plan the migration, implement it, and independently review SDK, samples and documentation.",
      );
    await page
      .getByRole("textbox", { name: "Constraints", exact: true })
      .fill("Do not publish packages or access production credentials.");
    await expect(
      page.getByRole("textbox", { name: "Acceptance criteria", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Propose goal", exact: true }).click();
    await page.getByRole("button", { name: "Approve goal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to goals", exact: true }).click();
    await page.getByRole("button", { name: "New goal", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Frontend delivery");
    await page
      .getByRole("textbox", { name: "Goal", exact: true })
      .fill("Update the frontend independently of SDK work.");
    await page.getByRole("button", { name: "Propose goal", exact: true }).click();
    await page.getByRole("button", { name: "Approve goal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to goals", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "SDK draft-10 conformance running" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Frontend delivery running" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("foreman-concurrent-goals-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "SDK draft-10 conformance running" }).click();
    await page.screenshot({
      path: testInfo.outputPath("foreman-goal-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await nanasa.restartDaemon();
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await page.reload();
    await page.getByRole("tab", { name: "Goals", exact: true }).click();
    await expect(page.getByRole("button", { name: "Frontend delivery running" })).toBeVisible();
    await page.getByRole("button", { name: "SDK draft-10 conformance paused" }).click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath("foreman-goal-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancel goal", exact: true }).click();
    await expect(page.getByText("cancelled", { exact: true })).toBeVisible();
  } finally {
    await nanasa.close();
  }
});

test("Foreman channel, native terminal, goal settings, and restart use the packaged daemon", async ({
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
    await expect(page.getByRole("tab", { name: "Missions", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("group", { name: "Goal Limits" })).toBeVisible();
    await expect(page.getByText("Approved team templates", { exact: true })).toHaveCount(0);
    await page.getByRole("spinbutton", { name: "Goal hours", exact: true }).fill("8");
    await page.getByRole("spinbutton", { name: "Concurrent goals", exact: true }).fill("2");
    await page.getByRole("spinbutton", { name: "Teams per goal", exact: true }).fill("4");
    await page
      .getByRole("spinbutton", { name: "Concurrent actions per goal", exact: true })
      .fill("6");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await nanasa.request<ForemanWorkspace>("/api/v1/foreman")).configuration?.autonomy
            .maxGoalHours,
      )
      .toBe(8);
    expect(
      (await nanasa.request<ForemanWorkspace>("/api/v1/foreman")).configuration?.autonomy,
    ).toMatchObject({ maxActiveGoals: 2, maxTeamsPerGoal: 4, maxConcurrentActions: 6 });
    await page.screenshot({
      path: testInfo.outputPath("foreman-goal-settings-desktop.png"),
      fullPage: true,
    });
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
      path: testInfo.outputPath("foreman-goal-settings-mobile.png"),
      fullPage: true,
    });
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
