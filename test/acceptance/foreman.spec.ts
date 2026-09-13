import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ForemanConversationRequest, ForemanWorkspace } from "@nanasa/contracts";
import { expect, test } from "@playwright/test";
import { PackageAcceptanceService } from "./fixtures/package-fixture.js";

test("portal approval mode starts new goals automatically but preserves human pause", async ({
  page,
  browserName,
}, testInfo) => {
  const nanasa = await PackageAcceptanceService.create(browserName, { foreman: true });
  try {
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await page.getByRole("tab", { name: "Goals", exact: true }).click();
    await page.getByRole("button", { name: "New goal", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Human-reviewed objective");
    await page
      .getByRole("textbox", { name: "Goal", exact: true })
      .fill("Validate human approval mode");
    await page.getByRole("button", { name: "Propose goal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve goal", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Start", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Coordination approvals", exact: true })
      .selectOption("autonomous");
    await page.getByRole("spinbutton", { name: "Concurrent goals", exact: true }).fill("2");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await nanasa.request<ForemanWorkspace>("/api/v1/foreman")).configuration?.autonomy
            .approvalMode,
      )
      .toBe("autonomous");
    await page.getByRole("tab", { name: "Goals", exact: true }).click();
    await page.getByRole("button", { name: "New goal", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Autonomous objective");
    await page
      .getByRole("textbox", { name: "Goal", exact: true })
      .fill("Validate preauthorized coordination");
    await page.getByRole("button", { name: "Propose goal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    const goals =
      await nanasa.request<
        Array<{ title: string; state: string; grant: { approvalMode: string } }>
      >("/api/v1/foreman/goals");
    expect(goals.find((goal) => goal.title === "Human-reviewed objective")).toMatchObject({
      state: "proposed",
      grant: { approvalMode: "human" },
    });
    expect(goals.find((goal) => goal.title === "Autonomous objective")).toMatchObject({
      state: "paused",
      grant: { approvalMode: "autonomous" },
    });
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Coordination approvals", exact: true })
      .selectOption("human");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await nanasa.request<ForemanWorkspace>("/api/v1/foreman")).configuration?.autonomy
            .approvalMode,
      )
      .toBe("human");
    await page.getByRole("tab", { name: "Goals", exact: true }).click();
    await page.getByRole("button", { name: /Autonomous objective/ }).click();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "exceeds repository policy" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel goal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath("autonomous-coordination-settings.png"),
      fullPage: true,
    });
  } finally {
    await nanasa.close();
  }
});

test("Foreman cleanup requires confirmation and clears only selected coordination data", async ({
  page,
  browserName,
}, testInfo) => {
  const nanasa = await PackageAcceptanceService.create(browserName, { foreman: true });
  try {
    const secretPath = join(nanasa.configRoot, ".nanasa", "runtime", "operator-secret");
    const secret = readFileSync(secretPath);
    await nanasa.request("/api/v1/foreman/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "cleanup-message", text: "Cleanup fixture message" }),
    });
    await nanasa.request("/api/v1/foreman/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "cleanup-goal",
        title: "Disposable test goal",
        objective: "Exercise reset controls",
        constraints: [],
      }),
    });
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page.getByRole("textbox", { name: "Type RESET to confirm", exact: true }).fill("RESET");
    await expect(
      page.getByRole("button", { name: "Clear selected history", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Start", exact: true }).waitFor();
    await page
      .getByRole("combobox", { name: "History to clear", exact: true })
      .selectOption("channel");
    await page.getByRole("textbox", { name: "Type RESET to confirm", exact: true }).fill("RESET");
    await page.getByRole("button", { name: "Clear selected history", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Goals still reference channel history" }),
    ).toBeVisible();
    await page.getByRole("combobox", { name: "History to clear", exact: true }).selectOption("all");
    await page.getByRole("textbox", { name: "Type RESET to confirm", exact: true }).fill("RESET");
    await page.getByRole("button", { name: "Clear selected history", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Removed 1 goals" })).toBeVisible();
    expect(await nanasa.request("/api/v1/foreman/goals")).toEqual([]);
    expect(
      (await nanasa.request<{ messages: unknown[] }>("/api/v1/foreman/channel")).messages,
    ).toEqual([]);
    expect(readFileSync(secretPath)).toEqual(secret);
    expect(existsSync(join(nanasa.configRoot, "packages", "api", "README.md"))).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("foreman-reset-settings.png"),
      fullPage: true,
    });
    await page.getByRole("tab", { name: "Channel", exact: true }).click();
    await expect(page.getByText("Cleanup fixture message", { exact: true })).toHaveCount(0);
  } finally {
    await nanasa.close();
  }
});

test("Foreman blocked input explains its source and resolution on desktop and mobile", async ({
  page,
  browserName,
}, testInfo) => {
  const nanasa = await PackageAcceptanceService.create(browserName);
  try {
    const message = await nanasa.request<{ id: string }>("/api/v1/foreman/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "blocked-human-input",
        text: "Check the published API contract; do not start implementation.",
      }),
    });
    const database = new DatabaseSync(join(nanasa.configRoot, ".nanasa", "state", "nanasa.sqlite"));
    try {
      database
        .prepare(
          "UPDATE foreman_inbox SET state = 'submitted', target_json = ?, updated_at = ? WHERE message_id = ?",
        )
        .run(
          JSON.stringify({ runId: "previous-foreman-run", generation: 6 }),
          new Date(Date.now() - 120000).toISOString(),
          message.id,
        );
    } finally {
      database.close();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    const notice = page
      .getByRole("alert")
      .filter({ has: page.getByRole("heading", { name: "Foreman updates are paused" }) });
    await expect(notice.getByText("Your channel message", { exact: true })).toBeVisible();
    await expect(notice.getByText("Foreman run 6 (previous run)", { exact: true })).toBeVisible();
    await notice.getByText("View blocked input", { exact: true }).click();
    await expect(
      notice.getByText("Check the published API contract; do not start implementation.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(notice.getByText(message.id, { exact: true })).toBeVisible();
    for (const [name, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect(
        notice.getByRole("button", { name: "Dismiss without resend", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`foreman-blocked-input-${name}.png`),
        fullPage: true,
      });
    }
    await notice.getByRole("button", { name: "Dismiss without resend", exact: true }).click();
    await expect(notice).toHaveCount(0);
    const workspace = await nanasa.request<ForemanWorkspace>("/api/v1/foreman");
    expect(workspace.inbox.find((item) => item.messageId === message.id)?.state).toBe("cancelled");
    expect(await nanasa.request("/api/v1/foreman/conversations")).toEqual([]);
  } finally {
    await nanasa.close();
  }
});

test("Foreman auto-starts and asks two teams for durable replies without any goal", async ({
  page,
  browserName,
}, testInfo) => {
  const nanasa = await PackageAcceptanceService.create(browserName, { foreman: true });
  try {
    expect((await nanasa.request<ForemanWorkspace>("/api/v1/foreman")).run?.status).toBe("running");
    const members: string[] = [];
    for (const name of ["Backend", "Frontend"]) {
      const group = await nanasa.request<{ id: string }>("/api/v1/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const member = await nanasa.request<{ memberId: string }>(
        `/api/v1/groups/${group.id}/agents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `${name} lead`, integrationId: "copilot" }),
        },
      );
      members.push(member.memberId);
      await nanasa.startAll(group.id);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await page
      .getByRole("textbox", { name: "Message Foreman", exact: true })
      .fill("Ask both teams what they are doing");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page
      .getByRole("button", { name: "Open thread: Ask both teams what they are doing", exact: true })
      .click();
    for (const memberId of members)
      await expect(
        page
          .getByRole("complementary", { name: "Conversation thread" })
          .getByText(`Team response: Member ${memberId}: no assigned work; ready for discussion.`, {
            exact: true,
          }),
      ).toBeVisible({ timeout: 30000 });
    const requests = await nanasa.request<ForemanConversationRequest[]>(
      "/api/v1/foreman/conversations",
    );
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.state === "answered")).toBe(true);
    expect(await nanasa.request("/api/v1/foreman/goals")).toEqual([]);
    for (const button of await page.getByRole("button", { name: "Dismiss", exact: true }).all()) {
      if (await button.isVisible()) await button.click();
    }
    await page.getByRole("heading", { name: "Foreman", level: 2 }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("foreman-ad-hoc-desktop.png"),
      fullPage: true,
    });
    await nanasa.restartDaemon();
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await page.reload();
    await page
      .getByRole("button", { name: "Open thread: Ask both teams what they are doing", exact: true })
      .click();
    await expect(
      page
        .getByRole("complementary", { name: "Conversation thread" })
        .getByText(`Team response: Member ${members[0]}: no assigned work; ready for discussion.`, {
          exact: true,
        }),
    ).toBeVisible();
    expect(await nanasa.request("/api/v1/foreman/conversations")).toEqual(requests);
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Terminal input", exact: true })
      .fill("Ask the teams from this terminal");
    await page.getByRole("textbox", { name: "Terminal input", exact: true }).press("Enter");
    await page.getByRole("tab", { name: "Channel", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await nanasa.request<ForemanConversationRequest[]>("/api/v1/foreman/conversations")
          ).filter((request) => request.state === "answered").length,
        { timeout: 30000 },
      )
      .toBe(4);
    const nativeRequests = (
      await nanasa.request<ForemanConversationRequest[]>("/api/v1/foreman/conversations")
    ).filter((request) => !requests.some((prior) => prior.id === request.id));
    expect(nativeRequests.every((request) => request.sourceMessageId === undefined)).toBe(true);
    expect(await nanasa.request("/api/v1/foreman/goals")).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const button of await page.getByRole("button", { name: "Dismiss", exact: true }).all()) {
      if (await button.isVisible()) await button.click();
    }
    await page.getByRole("heading", { name: "Foreman", level: 2 }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath("foreman-ad-hoc-mobile.png"),
      fullPage: true,
    });
  } finally {
    await nanasa.close();
  }
});

test("Foreman goals accept high-level outcomes and retain human control across restart", async ({
  page,
  browserName,
}, testInfo) => {
  const nanasa = await PackageAcceptanceService.create(browserName, { foreman: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
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
