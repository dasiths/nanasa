import { describe, expect, it, vi } from "vitest";
import {
  copyTerminalSelection,
  readClipboardText,
  selectionModifier,
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
