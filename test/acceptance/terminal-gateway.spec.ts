import { expect, test } from "./fixtures/package-fixture.js";

test("two browser tabs enforce one controller and one bounded observer", async ({
  context,
  page,
  nanasa,
}) => {
  const { group } = await nanasa.seedGroup("Gateway team", ["Terminal"]);
  await nanasa.startAll(group.id);
  await page.goto(nanasa.portalUrl);
  await expect(page.getByText("Controller", { exact: true })).toBeVisible();

  const observerPage = await context.newPage();
  await observerPage.goto(nanasa.baseUrl);
  await expect(observerPage.getByText("Observer", { exact: true })).toBeVisible();
  await expect(observerPage.getByRole("button", { name: "Paste" })).toBeDisabled();
  await expect(observerPage.getByRole("button", { name: "Take control" })).toBeVisible();

  await observerPage.getByRole("button", { name: "Take control" }).click();
  await expect(observerPage.getByText("Controller", { exact: true })).toBeVisible();
  await expect(observerPage.getByRole("button", { name: "Paste" })).toBeEnabled();
  await expect(page.getByText(/reconnecting|closed/i)).toBeVisible();
});

test("owned terminal handles Unicode, resize, alternate screen, transcript, and reconnect", async ({
  page,
  nanasa,
}) => {
  const { group, agents } = await nanasa.seedGroup("Terminal parity", ["Parity"]);
  await nanasa.startAll(group.id);
  const run = (await nanasa.snapshot()).runs.find(
    (candidate) => candidate.memberId === agents[0]!.memberId,
  )!;
  const paneId = run.terminal!.paneId;
  await page.goto(nanasa.portalUrl);
  const terminal = page.getByLabel(`Parity (${agents[0]!.memberId}) terminal console`);
  await expect(terminal.getByText("Controller", { exact: true })).toBeVisible();
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.insertText("IME 世界 🌍");
  await page.keyboard.press("Enter");
  await nanasa.waitForPaneText(paneId, "SAFE_ECHO:IME 世界 🌍");

  const beforeSize = nanasa.paneSize(paneId);
  await page.setViewportSize({ width: 900, height: 640 });
  await expect.poll(() => nanasa.paneSize(paneId)).not.toBe(beforeSize);

  await input.focus();
  await page.keyboard.insertText("__ALT__");
  await page.keyboard.press("Enter");
  await nanasa.waitForPaneText(paneId, "ALTERNATE_SCREEN_EXITED");

  await terminal.getByRole("button", { name: "Transcript" }).click();
  const transcript = page.getByRole("dialog", { name: "Terminal transcript" });
  await expect(transcript).toContainText("SAFE_ECHO:IME 世界 🌍");
  await transcript.getByRole("button", { name: "Close" }).click();

  await page.reload();
  await expect(page.getByText("Controller", { exact: true })).toBeVisible();
  await expect(page.getByLabel(`Parity (${agents[0]!.memberId}) terminal console`)).toBeVisible();
});
