import { expect, test } from "./fixtures/package-fixture.js";

test("graceful daemon restart reconnects the portal and preserves tmux panes", async ({
  page,
  nanasa,
}) => {
  const { group, agents: members } = await nanasa.seedGroup("Recovery team", [
    "Survivor one",
    "Survivor two",
  ]);
  await nanasa.startAll(group.id);
  await page.goto(nanasa.baseUrl);
  await expect(page.getByTitle("Domain event connection")).toContainText("connected");

  const before = await nanasa.snapshot();
  const identityBefore = new Map<
    string,
    { runId: string; generation: number; endpointPath: string; paneId: string }
  >();
  for (const run of before.runs.filter((candidate) => candidate.groupId === group.id)) {
    expect(run.terminal?.paneId).toBeDefined();
    const endpoint = await nanasa.waitForTerminalReady(run.id);
    identityBefore.set(run.memberId, {
      runId: run.id,
      generation: run.generation,
      endpointPath: endpoint.url,
      paneId: run.terminal!.paneId,
    });
    await nanasa.waitForPaneText(run.terminal!.paneId, "SAFE_ECHO_READY:");
  }

  await nanasa.stopDaemon();
  await expect(page.getByTitle("Domain event connection")).toContainText(
    /reconnecting|disconnected/,
  );
  await nanasa.startDaemon();
  await expect(page.getByTitle("Domain event connection")).toContainText("connected", {
    timeout: 20_000,
  });
  await expect
    .poll(
      async () => (await nanasa.snapshot()).runs.filter((run) => run.status === "running").length,
    )
    .toBe(2);

  const after = await nanasa.snapshot();
  for (const member of members) {
    const recovered = after.runs.find(
      (run) =>
        run.groupId === group.id && run.memberId === member.memberId && run.status === "running",
    );
    const original = identityBefore.get(member.memberId);
    expect(original).toBeDefined();
    const endpoint = await nanasa.waitForTerminalReady(recovered!.id);
    expect(recovered).toMatchObject({
      id: original!.runId,
      generation: original!.generation,
      terminal: { paneId: original!.paneId },
    });
    expect(endpoint.url).toBe(original!.endpointPath);
    expect(nanasa.capturePane(recovered!.terminal!.paneId)).toContain("SAFE_ECHO_READY:");
  }
  await expect(page.getByRole("tab", { name: /Survivor/ })).toHaveCount(2);
  await page.getByRole("button", { name: "Grid terminal layout" }).click();
  await expect(page.getByRole("region", { name: /terminal$/ })).toHaveCount(2);

  for (const member of members) {
    const marker = `post-restart-${member.memberId}`;
    const terminalInput = page
      .frameLocator(`iframe[title="${member.alias} (${member.memberId}) ttyd terminal"]`)
      .locator(".xterm-helper-textarea");
    await terminalInput.focus();
    await page.keyboard.type(marker);
    await page.keyboard.press("Enter");
    await nanasa.waitForPaneText(
      identityBefore.get(member.memberId)!.paneId,
      `SAFE_ECHO:${marker}`,
    );
  }
});
