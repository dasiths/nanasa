import { execFileSync } from "node:child_process";
import { expect, test } from "./fixtures/package-fixture.js";

test("CI starts credential-free terminals and preserves them across restart", async ({
  page,
  nanasa,
}) => {
  const { group } = await nanasa.seedGroup("CI terminal smoke", ["Alpha", "Beta"]);
  await nanasa.startAll(group.id);

  const before = await nanasa.snapshot();
  const runs = before.runs.filter((run) => run.groupId === group.id && run.status === "running");
  expect(runs).toHaveLength(2);

  for (const run of runs) {
    expect(run.terminal?.paneId).toBeDefined();
    await nanasa.waitForTerminalReady(run.id);
    await nanasa.waitForPaneText(run.terminal!.paneId, "SAFE_ECHO_READY:");
  }

  const target = runs[0]!;
  execFileSync("tmux", [
    "-L",
    nanasa.tmuxServer,
    "-f",
    "/dev/null",
    "send-keys",
    "-t",
    target.terminal!.paneId,
    "-l",
    "ci-terminal-input",
  ]);
  execFileSync("tmux", [
    "-L",
    nanasa.tmuxServer,
    "-f",
    "/dev/null",
    "send-keys",
    "-t",
    target.terminal!.paneId,
    "Enter",
  ]);
  await nanasa.waitForPaneText(target.terminal!.paneId, "SAFE_ECHO:ci-terminal-input");

  const tools = await nanasa.agentMcpRequest(target.terminal!.paneId, "tools/list", {});
  expect(tools.result?.tools?.map((tool) => tool.name)).toContain("nanasa.list_members");

  const response = await page.goto(nanasa.portalUrl);
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle(/Nanasa/);
  await expect(page.locator("#root")).not.toBeEmpty();

  await nanasa.restartDaemon();
  const after = await nanasa.snapshot();
  for (const run of runs) {
    expect(after.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      status: "running",
      terminal: { paneId: run.terminal!.paneId },
    });
  }
});
