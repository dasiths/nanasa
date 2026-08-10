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
  await expect(page.getByRole("button", { name: "Messages", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Messages overlay" })).toHaveCount(0);
  await page.getByRole("button", { name: "Grid terminal layout" }).click();
  await expect(page.getByRole("region", { name: /terminal$/ })).toHaveCount(3);
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(page.getByRole("region", { name: "Messages overlay" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Messages", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent terminals" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Workspace input mode" })).toHaveCount(0);

  const snapshot = await nanasa.snapshot();
  const paneByMember = new Map(
    snapshot.runs
      .filter((run) => run.groupId === group.id)
      .map((run) => [run.memberId, run.terminal?.paneId]),
  );
  for (const member of members) {
    expect(member.memberId).toMatch(/^echo\.[a-z0-9]+(?:-[a-z0-9]+)+$/);
    const paneId = paneByMember.get(member.memberId);
    expect(paneId).toBeDefined();
    await nanasa.waitForPaneText(paneId as string, "SAFE_ECHO_READY:");
  }

  const alphaFrame = page.frameLocator(
    `iframe[title="Alpha (${members[0]!.memberId}) ttyd terminal"]`,
  );
  const alphaInput = alphaFrame.locator(".xterm-helper-textarea");
  await alphaInput.focus();
  await page.keyboard.press("PageUp");
  await page.keyboard.press("PageDown");
  await nanasa.waitForPaneText(paneByMember.get(members[0]!.memberId)!, "SAFE_KEY:PageUp");
  await nanasa.waitForPaneText(paneByMember.get(members[0]!.memberId)!, "SAFE_KEY:PageDown");
  const alphaScreen = await alphaFrame.locator(".xterm-screen").boundingBox();
  expect(alphaScreen).not.toBeNull();
  await page.mouse.move(
    alphaScreen!.x + alphaScreen!.width / 2,
    alphaScreen!.y + alphaScreen!.height / 2,
  );
  await page.mouse.wheel(0, -120);
  await page.mouse.wheel(0, 120);
  await nanasa.waitForPaneText(paneByMember.get(members[0]!.memberId)!, "SAFE_MOUSE:WheelUp");
  await nanasa.waitForPaneText(paneByMember.get(members[0]!.memberId)!, "SAFE_MOUSE:WheelDown");

  const openComposer = async () => {
    await page.getByLabel("Compose message").click();
    return page.getByRole("dialog", { name: "New message" });
  };

  let composer = await openComposer();
  let audience = composer.getByLabel("Audience");
  let body = composer.getByLabel("Message body");
  await expect(composer).toContainText("Ask an agent to perform work or provide an answer.");
  await audience.selectOption("dm");
  await composer.getByLabel("Recipient").selectOption(members[0]?.memberId);
  await body.fill("acceptance-dm");
  await composer.getByRole("button", { name: "Send message" }).click();
  const history = page.getByRole("region", { name: "Message history" });
  await expect(history).toContainText("From: Human");
  await history.getByRole("button", { name: /Sent to 1/ }).click();
  await expect(history).toContainText("Alpha");
  await nanasa.waitForPaneText(paneByMember.get(members[0]!.memberId)!, "acceptance-dm");
  await expect(history).toContainText("consumed");
  expect(nanasa.capturePane(paneByMember.get(members[1]!.memberId)!)).not.toContain(
    "acceptance-dm",
  );

  const tools = await nanasa.agentMcpRequest(
    paneByMember.get(members[0]!.memberId)!,
    "tools/list",
    {},
  );
  expect(tools.result?.tools?.map((tool) => tool.name)).toEqual([
    "nanasa.list_members",
    "nanasa.send_dm",
    "nanasa.send_multicast",
    "nanasa.broadcast_group",
  ]);
  const listedMembers = await nanasa.agentMcpRequest(
    paneByMember.get(members[0]!.memberId)!,
    "tools/call",
    { name: "nanasa.list_members", arguments: {} },
    "nanasa.list_members",
  );
  expect(listedMembers.result?.structuredContent).toMatchObject({
    groupId: group.id,
    members: expect.arrayContaining([
      {
        memberId: members[0]!.memberId,
        alias: "Alpha",
        agentType: "echo",
        runStatus: "running",
        isCaller: true,
      },
    ]),
  });
  await nanasa.agentMcpRequest(
    paneByMember.get(members[0]!.memberId)!,
    "tools/call",
    {
      name: "nanasa.send_dm",
      arguments: {
        recipientMemberId: members[1]!.memberId,
        text: "acceptance-agent-to-agent",
        intent: "inform",
        contentType: "text/markdown",
      },
    },
    "nanasa.send_dm",
  );
  await nanasa.waitForPaneText(
    paneByMember.get(members[1]!.memberId)!,
    "acceptance-agent-to-agent",
  );
  await nanasa.waitForPaneText(
    paneByMember.get(members[1]!.memberId)!,
    `[From: Alpha | Member: ${members[0]!.memberId} | Intent: inform]`,
  );
  const agentMessage = page.getByText("acceptance-agent-to-agent").locator("..");
  await expect(agentMessage).toContainText("From: Alpha");
  await expect(agentMessage.getByRole("button", { name: /Sent to 1/ })).toContainText("consumed");

  await nanasa.agentMcpRequest(
    paneByMember.get(members[0]!.memberId)!,
    "tools/call",
    {
      name: "nanasa.broadcast_group",
      arguments: { text: "acceptance-agent-broadcast", intent: "inform" },
    },
    "nanasa.broadcast_group",
  );
  await nanasa.waitForPaneText(
    paneByMember.get(members[1]!.memberId)!,
    "acceptance-agent-broadcast",
  );
  await nanasa.waitForPaneText(
    paneByMember.get(members[2]!.memberId)!,
    "acceptance-agent-broadcast",
  );
  expect(nanasa.capturePane(paneByMember.get(members[0]!.memberId)!)).not.toContain(
    "acceptance-agent-broadcast",
  );

  composer = await openComposer();
  audience = composer.getByLabel("Audience");
  body = composer.getByLabel("Message body");
  await audience.selectOption("multicast");
  await body.fill("acceptance-multicast");
  await composer.getByRole("button", { name: "Send message" }).click();
  await nanasa.waitForPaneText(paneByMember.get(members[0]!.memberId)!, "acceptance-multicast");
  await nanasa.waitForPaneText(paneByMember.get(members[1]!.memberId)!, "acceptance-multicast");
  expect(nanasa.capturePane(paneByMember.get(members[2]!.memberId)!)).not.toContain(
    "acceptance-multicast",
  );

  composer = await openComposer();
  audience = composer.getByLabel("Audience");
  body = composer.getByLabel("Message body");
  await audience.selectOption("group");
  await body.fill("acceptance-broadcast");
  await composer.getByRole("button", { name: "Send message" }).click();
  for (const member of members) {
    await nanasa.waitForPaneText(paneByMember.get(member.memberId)!, "acceptance-broadcast");
  }

  await page.reload();
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
