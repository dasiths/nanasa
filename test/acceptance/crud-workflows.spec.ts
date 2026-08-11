import { expect, test } from "./fixtures/package-fixture.js";

test("group and member rename and delete workflows require confirmation", async ({
  page,
  nanasa,
}) => {
  const { group, members } = await nanasa.seedGroup("CRUD team", [
    "Original agent",
    "Retained agent",
  ]);
  await nanasa.seedGroup("Fallback team", []);
  await page.goto(nanasa.baseUrl);
  await nanasa.startAll(group.id);
  const runningSnapshot = await nanasa.snapshot();
  const panesByMember = new Map(
    runningSnapshot.runs
      .filter((run) => run.groupId === group.id)
      .map((run) => [run.memberId, run.terminal?.paneId]),
  );
  const profileIds = new Set(members.map((member) => member.agentProfileId));
  for (const paneId of panesByMember.values()) {
    expect(paneId).toBeDefined();
    await nanasa.waitForPaneText(paneId!, "SAFE_ECHO_READY:");
  }

  let paneExpectedStopped: string | undefined;
  await page.route("**/api/snapshot", async (route) => {
    if (paneExpectedStopped !== undefined) {
      await nanasa.waitForPaneStopped(paneExpectedStopped);
      expect(nanasa.paneExists(paneExpectedStopped)).toBe(false);
      paneExpectedStopped = undefined;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "Actions for group CRUD team" }).click();
  await page.getByRole("menuitem", { name: "Rename group CRUD team" }).click();
  const groupName = page.getByRole("textbox", { name: "group name for CRUD team" });
  await groupName.fill("Renamed team");
  await groupName.press("Enter");
  await expect(page.getByRole("heading", { name: "Renamed team" })).toBeVisible();

  await page.getByRole("button", { name: "Actions for agent Original agent" }).click();
  await page.getByRole("menuitem", { name: "Rename agent Original agent" }).click();
  const agentAlias = page.getByRole("textbox", { name: "agent alias for Original agent" });
  await agentAlias.fill("Renamed agent");
  await agentAlias.press("Enter");
  await expect(page.getByRole("button", { name: "Actions for agent Renamed agent" })).toBeVisible();

  await page.getByRole("button", { name: "Actions for agent Renamed agent" }).click();
  await page.getByRole("menuitem", { name: "Remove agent Renamed agent" }).click();
  const memberDialog = page.getByRole("dialog", { name: "Remove Renamed agent?" });
  await expect(memberDialog).toContainText("membership will be removed");
  await memberDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Actions for agent Renamed agent" })).toBeVisible();
  await page.getByRole("button", { name: "Actions for agent Renamed agent" }).click();
  await page.getByRole("menuitem", { name: "Remove agent Renamed agent" }).click();
  const memberRunBeforeDelete = (await nanasa.snapshot()).runs
    .filter((run) => run.memberId === members[0]!.memberId && run.status === "running")
    .sort((left, right) => right.generation - left.generation)[0];
  expect(memberRunBeforeDelete?.terminal?.paneId).toBeDefined();
  paneExpectedStopped = memberRunBeforeDelete!.terminal!.paneId;
  await page
    .getByRole("dialog", { name: "Remove Renamed agent?" })
    .getByRole("button", { name: "Remove agent" })
    .click();
  await expect(page.getByRole("button", { name: "Actions for agent Renamed agent" })).toHaveCount(
    0,
  );
  expect(paneExpectedStopped).toBeUndefined();

  const afterMemberRemoval = await nanasa.snapshot();
  expect(
    afterMemberRemoval.memberships.some((member) => member.memberId === members[0]!.memberId),
  ).toBe(false);
  expect(afterMemberRemoval.runs.some((run) => run.memberId === members[0]!.memberId)).toBe(false);
  const remainingRun = afterMemberRemoval.runs
    .filter((run) => run.memberId === members[1]!.memberId && run.status === "running")
    .sort((left, right) => right.generation - left.generation)[0];
  expect(remainingRun?.terminal?.paneId).toBeDefined();
  expect(nanasa.paneExists(remainingRun!.terminal!.paneId)).toBe(true);
  expect(afterMemberRemoval.agentProfiles.map((profile) => profile.id)).toEqual(
    expect.arrayContaining([...profileIds]),
  );

  await page.getByRole("button", { name: "Actions for group Renamed team" }).click();
  await page.getByRole("menuitem", { name: "Delete group Renamed team" }).click();
  const groupDialog = page.getByRole("dialog", { name: "Delete Renamed team?" });
  await expect(groupDialog).toContainText("runs will stop before");
  await groupDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Renamed team" })).toBeVisible();
  await page.getByRole("button", { name: "Actions for group Renamed team" }).click();
  await page.getByRole("menuitem", { name: "Delete group Renamed team" }).click();
  const groupRunBeforeDelete = (await nanasa.snapshot()).runs
    .filter((run) => run.memberId === members[1]!.memberId && run.status === "running")
    .sort((left, right) => right.generation - left.generation)[0];
  expect(groupRunBeforeDelete?.terminal?.paneId).toBeDefined();
  paneExpectedStopped = groupRunBeforeDelete!.terminal!.paneId;
  await page
    .getByRole("dialog", { name: "Delete Renamed team?" })
    .getByRole("button", { name: "Delete group" })
    .click();
  await expect(page.getByRole("heading", { name: "Fallback team" })).toBeVisible();
  await expect(page.getByText("Renamed team", { exact: true })).toHaveCount(0);
  expect(paneExpectedStopped).toBeUndefined();

  const afterGroupDeletion = await nanasa.snapshot();
  expect(afterGroupDeletion.groups.some((candidate) => candidate.id === group.id)).toBe(false);
  expect(afterGroupDeletion.memberships.some((member) => member.groupId === group.id)).toBe(false);
  expect(afterGroupDeletion.runs.some((run) => run.groupId === group.id)).toBe(false);
  expect(afterGroupDeletion.agentProfiles.map((profile) => profile.id)).toEqual(
    expect.arrayContaining([...profileIds]),
  );

  const retainedEvents = await page.evaluate(
    ({ baseUrl, deletedGroupId }) =>
      new Promise<Array<{ type: string; aggregateId: string; payload: Record<string, unknown> }>>(
        (resolveEvents, rejectEvents) => {
          const events: Array<{
            type: string;
            aggregateId: string;
            payload: Record<string, unknown>;
          }> = [];
          const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/events?after=0`);
          const timeout = window.setTimeout(() => {
            socket.close();
            rejectEvents(new Error("Timed out replaying deletion events"));
          }, 5_000);
          socket.onmessage = (event) => {
            const domainEvent = JSON.parse(String(event.data)) as {
              type: string;
              aggregateId: string;
              payload: Record<string, unknown>;
            };
            events.push(domainEvent);
            if (
              domainEvent.type === "group.deleted" &&
              domainEvent.aggregateId === deletedGroupId
            ) {
              window.clearTimeout(timeout);
              socket.close();
              resolveEvents(events);
            }
          };
          socket.onerror = () => {
            window.clearTimeout(timeout);
            rejectEvents(new Error("Could not replay deletion events"));
          };
        },
      ),
    { baseUrl: nanasa.baseUrl, deletedGroupId: group.id },
  );
  expect(
    retainedEvents.some(
      (event) =>
        event.type === "membership.removed" &&
        (event.payload.membership as { memberId?: string } | undefined)?.memberId ===
          members[0]!.memberId,
    ),
  ).toBe(true);
  expect(
    retainedEvents.some(
      (event) => event.type === "group.deleted" && event.aggregateId === group.id,
    ),
  ).toBe(true);
});
