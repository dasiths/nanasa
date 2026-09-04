import { describe, expect, it, vi } from "vitest";
import {
  copyTerminalSelection,
  installCopyOnSelect,
  readClipboardText,
  selectionModifier,
  writeClipboardText,
} from "./terminal-clipboard.js";

describe("terminal clipboard policy", () => {
  it("uses platform-specific selection overrides", () => {
    expect(selectionModifier("MacIntel")).toBe("Option");
    expect(selectionModifier("Linux x86_64")).toBe("Shift");
    expect(selectionModifier("Win32")).toBe("Shift");
  });

  it("copies exact Unicode selections from a trusted click path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const terminal = { getSelection: () => "世界 🌍", hasSelection: () => true };
    await expect(copyTerminalSelection(terminal as never)).resolves.toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith("世界 🌍");
  });

  it("falls back after clipboard permission denial and removes temporary DOM", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    await expect(writeClipboardText("fallback text")).resolves.toEqual({ ok: true });
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull();
  });

  it("returns non-sensitive guidance and cleans up when both copy methods fail", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    const outcome = await writeClipboardText("do not include this value");
    expect(outcome).toEqual({
      ok: false,
      message: "Use your browser or operating system Copy command.",
    });
    expect(JSON.stringify(outcome)).not.toContain("do not include this value");
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull();
  });

  it("copies a mouse selection after xterm completes the selection", async () => {
    const element = document.createElement("div");
    const xtermScreen = document.createElement("div");
    element.append(xtermScreen);
    document.body.append(element);
    let selected = false;
    const copy = vi.fn();
    const remove = installCopyOnSelect(element, { hasSelection: () => selected } as never, copy);
    xtermScreen.addEventListener("mousedown", (event) => event.stopPropagation());

    xtermScreen.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    selected = true;
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await Promise.resolve();
    expect(copy).toHaveBeenCalledOnce();

    remove();
    xtermScreen.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await Promise.resolve();
    expect(copy).toHaveBeenCalledOnce();
    element.remove();
  });

  it("returns useful paste fallback text after permission denial", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await expect(readClipboardText()).resolves.toEqual({
      ok: false,
      message: "Use your browser or operating system Paste command.",
    });
  });
});
