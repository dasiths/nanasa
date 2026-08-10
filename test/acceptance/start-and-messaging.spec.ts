import { expect, test } from "./fixtures/package-fixture.js";

test("Start All opens safe terminals and routes DM, multicast, and group broadcast", async ({
  page,
  nanasa,
}) => {
  const { group, members } = await nanasa.seedGroup("Acceptance team", ["Alpha", "Beta", "Gamma"]);
  await page.goto(nanasa.baseUrl);

  await page
    .getByRole("button", { name: "Start all non-running agents in Acceptance team" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Start all complete" })).toContainText(
    "3 started",
  );
  await expect(page.getByRole("region", { name: /terminal$/ })).toHaveCount(1);
  await page.getByRole("button", { name: "Grid terminal layout" }).click();
  await expect(page.getByRole("region", { name: /terminal$/ })).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Messages" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent terminals" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Workspace input mode" })).toHaveCount(0);

  const snapshot = await nanasa.snapshot();
  const paneByMember = new Map(
    snapshot.runs
      .filter((run) => run.groupId === group.id)
      .map((run) => [run.memberId, run.terminal?.paneId]),
  );
  for (const member of members) {
    const paneId = paneByMember.get(member.memberId);
    expect(paneId).toBeDefined();
    await nanasa.waitForPaneText(paneId as string, "SAFE_ECHO_READY:");
  }

  const audience = page.getByLabel("Audience");
  const body = page.getByLabel("Message body");

  await audience.selectOption("dm");
  await page.getByLabel("Recipient").selectOption(members[0]?.memberId);
  await body.fill("acceptance-dm");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("region", { name: "Message history" })).toContainText("Alpha");
  await nanasa.waitForPaneText(paneByMember.get(members[0]!.memberId)!, "acceptance-dm");
  await expect(page.getByRole("region", { name: "Message history" })).toContainText("consumed");
  expect(nanasa.capturePane(paneByMember.get(members[1]!.memberId)!)).not.toContain(
    "acceptance-dm",
  );

  await audience.selectOption("multicast");
  await body.fill("acceptance-multicast");
  await page.getByRole("button", { name: "Send message" }).click();
  await nanasa.waitForPaneText(paneByMember.get(members[0]!.memberId)!, "acceptance-multicast");
  await nanasa.waitForPaneText(paneByMember.get(members[1]!.memberId)!, "acceptance-multicast");
  expect(nanasa.capturePane(paneByMember.get(members[2]!.memberId)!)).not.toContain(
    "acceptance-multicast",
  );

  await audience.selectOption("group");
  await body.fill("acceptance-broadcast");
  await page.getByRole("button", { name: "Send message" }).click();
  for (const member of members) {
    await nanasa.waitForPaneText(paneByMember.get(member.memberId)!, "acceptance-broadcast");
  }

  await page.reload();
  const history = page.getByRole("region", { name: "Message history" });
  await expect(history).toContainText("acceptance-dm");
  await expect(history).toContainText("acceptance-multicast");
  await expect(history).toContainText("acceptance-broadcast");
  await page.getByRole("button", { name: "Clear all message history" }).click();
  const dialog = page.getByRole("dialog", { name: "Clear all message history?" });
  await expect(dialog).toBeVisible();
  await expect(history).toContainText("acceptance-dm");
  await dialog.getByRole("button", { name: "Clear history" }).click();
  await expect(history).not.toContainText("acceptance-dm");
});
