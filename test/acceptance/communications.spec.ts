import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { NanasaStore } from "../../apps/daemon/src/store.js";
import {
  ForemanConversationRequestSchema,
  type ForemanWorkspace,
} from "../../packages/contracts/dist/index.js";
import { PackageAcceptanceService } from "./fixtures/package-fixture.js";

test("repository channel groups agent communication and keeps threaded replies scoped", async ({
  page,
  browserName,
}, testInfo) => {
  const nanasa = await PackageAcceptanceService.create(browserName, { foreman: true });
  try {
    const backend = await nanasa.request<{ id: string }>("/api/v1/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Backend Team" }),
    });
    const frontend = await nanasa.request<{ id: string }>("/api/v1/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Frontend Team" }),
    });
    const members: Array<{ groupId: string; memberId: string; name: string }> = [];
    for (const [groupId, names] of [
      [backend.id, ["Project Manager", "Engineer 1", "Engineer 2"]],
      [frontend.id, ["Frontend Engineer", "Frontend Reviewer"]],
    ] as const) {
      for (const name of names) {
        const member = await nanasa.request<{ memberId: string }>(
          `/api/v1/groups/${groupId}/agents`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, integrationId: "copilot" }),
          },
        );
        members.push({ groupId, memberId: member.memberId, name });
      }
    }
    const store = new NanasaStore(join(nanasa.configRoot, ".nanasa", "state", "nanasa.sqlite"));
    let rootId = "";
    try {
      const run = store.getActiveForemanRun("repository-foreman")!;
      const principal = {
        kind: "foreman" as const,
        foremanId: run.foremanId,
        runId: run.id,
        generation: run.generation,
        authorityRevision: 0,
      };
      const human = { kind: "operator" as const, operatorId: "human" };
      const stamp = (offset: number) => new Date(Date.now() - (45 - offset) * 60000).toISOString();
      store.atomic(() => {
        const root = store.sendForemanMessage(human, {
          requestId: "release-readiness",
          text: "Can we ship the API contract update?\n\nCheck **Backend validation** and **Frontend compatibility** before we make the call.",
        });
        rootId = root.id;
        store.database
          .prepare("UPDATE foreman_messages SET created_at = ? WHERE id = ?")
          .run(stamp(0), root.id);
        const update = store.sendForemanMessage(principal, {
          requestId: "release-summary",
          replyTo: root.id,
          text: "Both checks are back. **Backend validation passed** and the Frontend client is compatible.\n\n- 42 contract tests passed\n- No breaking field changes\n- Reviewer sign-off remains the final step",
        });
        store.database
          .prepare("UPDATE foreman_messages SET created_at = ? WHERE id = ?")
          .run(stamp(6), update.id);
        for (const [index, member] of [members[1]!, members[3]!].entries()) {
          const membership = store
            .listActiveMemberships(member.groupId)
            .find((entry) => entry.memberId === member.memberId)!;
          const request = ForemanConversationRequestSchema.parse({
            id: `release-question-${index}`,
            requestId: `release-member-${index}`,
            foremanId: run.foremanId,
            conversationId: `release-conversation-${index}`,
            groupId: member.groupId,
            memberId: member.memberId,
            memberProfileId: membership.agentProfileId,
            authorityRevision: 0,
            sourceMessageId: root.id,
            text:
              index === 0
                ? "Confirm the contract test results and any release blockers."
                : "Check whether the updated response stays compatible with the portal client.",
            state: "answered",
            response:
              index === 0
                ? "**Validation passed.** All 42 contract tests are green. The `retryAfterSeconds` field remains optional. No Backend blockers."
                : "The portal is compatible. I checked loading, empty, and error states.\n\n```ts\nconst retryDelay = result.retryAfterSeconds ?? 5;\n```\n\nNo client changes are required for this release.",
            createdAt: stamp(1 + index),
            answeredAt: stamp(4 + index),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          });
          store.database
            .prepare("INSERT INTO foreman_conversations VALUES (?, ?, ?, ?, ?)")
            .run(
              request.id,
              run.foremanId,
              request.requestId,
              `digest-${index}`,
              JSON.stringify(request),
            );
        }
        const next = store.sendForemanMessage(human, {
          requestId: "retry-policy",
          text: "Check the retry policy for intermittent provider failures. Keep the current limits; report the trade-offs before changing anything.",
          teamId: backend.id,
        });
        store.database
          .prepare("UPDATE foreman_messages SET created_at = ? WHERE id = ?")
          .run(stamp(12), next.id);
        store.sendForemanMessage(principal, {
          requestId: "retry-ack",
          replyTo: next.id,
          teamId: backend.id,
          text: "I have requested an assessment from both Backend engineers. One question is delivered; the other is queued until its current turn finishes.",
        });
        for (const [index, member] of [members[1]!, members[2]!].entries()) {
          const membership = store
            .listActiveMemberships(member.groupId)
            .find((entry) => entry.memberId === member.memberId)!;
          const request = ForemanConversationRequestSchema.parse({
            id: `retry-question-${index}`,
            requestId: `retry-member-${index}`,
            foremanId: run.foremanId,
            conversationId: `retry-conversation-${index}`,
            groupId: member.groupId,
            memberId: member.memberId,
            memberProfileId: membership.agentProfileId,
            authorityRevision: 0,
            sourceMessageId: next.id,
            text: "Assess the existing retry limits and recommend whether they should change. Do not modify the implementation yet.",
            state: index === 0 ? "submitted" : "queued",
            createdAt: stamp(13 + index),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          });
          store.database
            .prepare("INSERT INTO foreman_conversations VALUES (?, ?, ?, ?, ?)")
            .run(
              request.id,
              run.foremanId,
              request.requestId,
              `retry-digest-${index}`,
              JSON.stringify(request),
            );
        }
        const teamRoot = store.submitMessage(frontend.id, {
          intent: "request",
          sender: human,
          audience: {
            kind: "group",
            membershipRevision: store.getGroup(frontend.id).membershipRevision,
          },
          body: {
            contentType: "text/markdown",
            text: "Please check the new empty state at narrow widths. The **action button** should stay visible without horizontal scrolling.",
          },
          delivery: {},
        });
        const sender = members[4]!;
        const senderRun = store.createRunForMembership(frontend.id, sender.memberId).run;
        store.submitMessage(frontend.id, {
          intent: "response",
          sender: { kind: "agent", memberId: sender.memberId, runId: senderRun.id },
          audience: { kind: "dm", memberId: members[3]!.memberId },
          conversationId: teamRoot.message.conversationId,
          replyTo: teamRoot.message.id,
          body: {
            contentType: "text/markdown",
            text: "The 390px layout is clear. One remaining issue: the error label wraps onto the action row. I have sent the exact viewport and reproduction to Frontend Engineer.",
          },
          delivery: {},
        });
      });
    } finally {
      store.close();
    }
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
    await page.goto(`${nanasa.baseUrl}/foreman${new URL(nanasa.portalUrl).hash}`);
    await expect(page.getByRole("log", { name: "Repository communication" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Open thread: Please check the new empty state/ }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("channel-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: /^Open thread: Can we ship/ }).click();
    const thread = page.getByRole("complementary", { name: "Conversation thread" });
    await expect(thread.getByText("Reply received", { exact: true })).toHaveCount(2);
    await expect(thread.locator("pre")).toContainText("retryAfterSeconds");
    await page.screenshot({ path: testInfo.outputPath("thread-desktop.png"), fullPage: true });
    await thread
      .getByRole("textbox", { name: "Reply in thread" })
      .fill("Keep the review gate before shipping.");
    await thread.getByRole("button", { name: "Send reply" }).click();
    await expect
      .poll(
        async () =>
          (
            await nanasa.request<{ messages: Array<{ text: string; replyTo?: string }> }>(
              "/api/v1/foreman/channel",
            )
          ).messages.find((message) => message.text === "Keep the review gate before shipping.")
            ?.replyTo,
      )
      .toBe(rootId);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(thread).toBeVisible();
    await expect(page.getByRole("log", { name: "Repository communication" })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath("thread-mobile.png"), fullPage: true });
    await thread.locator("pre").scrollIntoViewIfNeeded();
    const wrap = thread.getByRole("button", { name: "Wrap code", exact: true });
    await expect(wrap).toHaveAttribute("aria-pressed", "true");
    expect(
      await thread.locator("pre").evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await wrap.click();
    await expect(wrap).toHaveAttribute("aria-pressed", "false");
    await wrap.click();
    await page.screenshot({ path: testInfo.outputPath("thread-code-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Close thread", exact: true }).click();
    await expect(page.getByRole("log", { name: "Repository communication" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search conversations" }).fill("empty state");
    await expect(page.getByRole("button", { name: /^Open thread:/ })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("channel-mobile.png"), fullPage: true });
    await page.getByRole("searchbox", { name: "Search conversations" }).fill("");
    await page
      .getByRole("combobox", { name: "Message recipient" })
      .selectOption(
        JSON.stringify({ kind: "member", groupId: backend.id, memberId: members[1]!.memberId }),
      );
    await page
      .getByRole("textbox", { name: "Message agents" })
      .fill("Please send the final test summary.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await nanasa.request<{
              messages: Array<{ body: { text: string }; audience: unknown }>;
            }>(`/api/v1/groups/${backend.id}/messages`)
          ).messages.find((message) => message.body.text === "Please send the final test summary.")
            ?.audience,
      )
      .toEqual({ kind: "dm", memberId: members[1]!.memberId });
    expect((await nanasa.request<ForemanWorkspace>("/api/v1/foreman")).configuration?.enabled).toBe(
      true,
    );
    await page.evaluate(() => {
      const key = "nanasa.portal.preferences.v2";
      const preferences = { ...JSON.parse(localStorage.getItem(key) ?? "{}"), theme: "dark" };
      localStorage.setItem(key, JSON.stringify(preferences));
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: JSON.stringify(preferences) }),
      );
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("log", { name: "Repository communication" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("channel-dark-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: testInfo.outputPath("channel-dark-desktop.png"),
      fullPage: true,
    });
  } finally {
    await nanasa.close();
  }
});
