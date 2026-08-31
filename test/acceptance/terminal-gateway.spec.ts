import { expect, test } from "./fixtures/package-fixture.js";

test("two browser tabs enforce one controller and one bounded observer", async ({
  context,
  page,
  nanasa,
}) => {
  const { group } = await nanasa.seedGroup("Gateway team", ["Terminal"]);
  await nanasa.startAll(group.id);
  await page.goto(nanasa.portalUrl);
  await expect(page.getByText("Control mode", { exact: true })).toBeVisible();

  const observerPage = await context.newPage();
  await observerPage.goto(nanasa.baseUrl);
  await expect(observerPage.getByText("Observe mode", { exact: true })).toBeVisible();
  await expect(observerPage.getByRole("button", { name: "Paste" })).toBeDisabled();
  const takeControl = observerPage.getByRole("button", { name: "Take control" });
  await expect(takeControl.locator("svg")).toBeVisible();
  await expect(takeControl).not.toContainText("Take control");

  await observerPage.getByRole("button", { name: "Take control" }).click();
  await expect(observerPage.getByText("Control mode", { exact: true })).toBeVisible();
  await expect(observerPage.getByRole("button", { name: "Paste" })).toBeEnabled();
  await expect(page.getByText(/reconnecting|closed/i)).toBeVisible();
  await expect(page.getByText("Observe mode", { exact: true })).toBeVisible();

  await observerPage.getByRole("button", { name: "Observe" }).click();
  await expect(observerPage.getByText("Observe mode", { exact: true })).toBeVisible();
  await expect(observerPage.getByRole("button", { name: "Paste" })).toBeDisabled();
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByText("Control mode", { exact: true })).toBeVisible();
  const observe = page.getByRole("button", { name: "Observe" });
  await expect(observe.locator("svg")).toBeVisible();
  await expect(observe).not.toContainText("Observe");
});

test("owned terminal handles Unicode, resize, alternate screen, transcript, and reconnect", async ({
  browserName,
  context,
  page,
  nanasa,
}) => {
  const { group, agents } = await nanasa.seedGroup("Terminal parity", ["Parity"]);
  await nanasa.startAll(group.id);
  const run = (await nanasa.snapshot()).runs.find(
    (candidate) => candidate.memberId === agents[0]!.memberId,
  )!;
  const paneId = run.terminal!.paneId;
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(nanasa.portalUrl).origin,
    });
  }
  await page.goto(nanasa.portalUrl);
  const terminal = page.getByLabel(`Parity (${agents[0]!.memberId}) terminal console`);
  await expect(terminal.getByText("Control mode", { exact: true })).toBeVisible();
  const modeBar = terminal.locator(".terminal-lease-banner");
  await expect(terminal.locator(".terminal-statusbar")).toHaveCount(1);
  await expect(modeBar.getByText("Parity", { exact: true })).toBeVisible();
  const nameCopy = modeBar.getByRole("button", {
    name: `Copy agent name ${agents[0]!.memberId}`,
  });
  await expect(nameCopy).toHaveText(agents[0]!.memberId);
  await expect(modeBar.getByText("connected", { exact: true })).toBeVisible();
  const actionStrip = modeBar.locator(".terminal-banner-actions");
  await expect(actionStrip.getByRole("button", { name: /Copy member ID/ })).toHaveCount(0);
  await expect(actionStrip.getByRole("button", { name: "Pin Parity terminal" })).toBeVisible();
  await expect(actionStrip.getByRole("button", { name: "Maximize Parity terminal" })).toBeVisible();
  const terminalActions = modeBar.getByRole("toolbar", { name: "Terminal actions" });
  for (const name of ["Copy", "Paste", "Search", "Transcript", "More terminal actions"]) {
    const button = terminalActions.getByRole("button", { name });
    await expect(button.locator("svg")).toBeVisible();
    await expect(button).not.toContainText(name);
  }
  await expect(actionStrip.getByRole("button").last()).toHaveAccessibleName(
    "More terminal actions",
  );
  await expect(
    terminalActions.getByRole("button", { name: "Terminal selection help" }),
  ).toHaveCount(0);
  const selectionHelp = terminalActions.getByLabel("Terminal selection help");
  await expect(selectionHelp).toHaveAttribute("tabindex", "0");
  await selectionHelp.hover();
  await expect(modeBar.getByRole("tooltip")).toHaveText(
    "Hold Shift and drag to select and copy text, or press Ctrl+C with a selection.",
  );
  await expect(modeBar.getByRole("tooltip")).toBeVisible();
  await expect(terminal.locator(".terminal-selection-hint")).toHaveCount(0);
  const [modeBarBounds, terminalActionsBounds] = await Promise.all([
    modeBar.boundingBox(),
    actionStrip.boundingBox(),
  ]);
  expect(modeBarBounds).not.toBeNull();
  expect(terminalActionsBounds).not.toBeNull();
  expect(terminalActionsBounds!.x).toBeGreaterThan(modeBarBounds!.x + modeBarBounds!.width / 2);
  expect(terminalActionsBounds!.x + terminalActionsBounds!.width).toBeLessThanOrEqual(
    modeBarBounds!.x + modeBarBounds!.width,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => modeBar.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await expect(actionStrip.getByRole("button", { name: "Pin Parity terminal" })).toBeVisible();
  await expect(actionStrip.getByRole("button", { name: "Maximize Parity terminal" })).toBeVisible();
  const expectRenderer = async (console: typeof terminal) => {
    const host = console.locator(".xterm-host");
    await expect(host).toHaveAttribute(
      "data-terminal-renderer",
      browserName === "chromium" ? "webgl" : /^(dom|webgl)$/,
    );
    if ((await host.getAttribute("data-terminal-renderer")) === "webgl") {
      await expect(console.locator("canvas:not(.xterm-link-layer)").first()).toBeVisible();
    } else {
      await expect(console.locator(".xterm-rows")).toBeVisible();
    }
  };
  await expectRenderer(terminal);
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.insertText("IME 世界 🌍");
  await page.keyboard.press("Enter");
  await nanasa.waitForPaneText(paneId, "SAFE_ECHO:IME 世界 🌍");
  await terminal.getByRole("button", { name: "Search" }).click();
  await terminal.getByRole("textbox", { name: "Search terminal" }).fill("SAFE_ECHO:IME 世界 🌍");
  await terminal.getByRole("button", { name: "Find next" }).click();
  await expect(terminal.locator(".terminal-feedback")).toHaveText("Terminal match found.");

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

  await input.focus();
  await page.keyboard.insertText("__OSC52_TMUX__");
  await page.keyboard.press("Enter");
  const clipboardPrompt = terminal.getByRole("alertdialog", {
    name: "Terminal clipboard request",
  });
  await expect(clipboardPrompt).toBeVisible();
  await expect(clipboardPrompt).not.toContainText("clipboard 世界 🌍");
  if (browserName === "chromium") {
    await clipboardPrompt.getByRole("button", { name: "Copy" }).click();
    await expect(terminal.locator(".terminal-feedback")).toHaveText(
      "Terminal clipboard request copied.",
    );
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("clipboard 世界 🌍");
  } else {
    await clipboardPrompt.getByRole("button", { name: "Deny" }).click();
    await expect(clipboardPrompt).toHaveCount(0);
  }

  await page.reload();
  await expect(page.getByText("Control mode", { exact: true })).toBeVisible();
  const reconnected = page.getByLabel(`Parity (${agents[0]!.memberId}) terminal console`);
  await expect(reconnected).toBeVisible();
  await expectRenderer(reconnected);
  await reconnected.getByRole("button", { name: "Search" }).click();
  await reconnected
    .getByRole("textbox", { name: "Search terminal" })
    .fill("ALTERNATE_SCREEN_EXITED");
  await reconnected.getByRole("button", { name: "Find next" }).click();
  await expect(reconnected.locator(".terminal-feedback")).toHaveText("Terminal match found.");
});
