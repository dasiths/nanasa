import { describe, expect, it } from "vitest";
import { TerminalEffectPolicy } from "../src/terminal/terminal-effect-policy.js";
import {
  boundedBaselineFrame,
  initializeTerminalAttachment,
} from "../src/terminal/terminal-gateway.js";
import { TERMINAL_LIMITS } from "../src/terminal/terminal-transport-limits.js";

describe("terminal gateway smoke", () => {
  it("publishes bounded v1 limits and preserves non-effect terminal bytes", () => {
    expect(TERMINAL_LIMITS).toMatchObject({
      maxViewers: 4,
      maxObservers: 3,
      reconnectHistoryFrames: 256,
    });
    expect(
      new TerminalEffectPolicy().filter("Unicode 世界 🌍\u001b[?1049h\u001b[?1049l", true),
    ).toEqual({
      output: "Unicode 世界 🌍\u001b[?1049h\u001b[?1049l",
      effects: [],
    });
  });

  it("sends the baseline before attaching live terminal output", async () => {
    const events: string[] = [];
    let resolveRead: ((value: { text: string; truncated: boolean }) => void) | undefined;
    const read = new Promise<{ text: string; truncated: boolean }>((resolve) => {
      resolveRead = resolve;
    });
    const initialization = initializeTerminalAttachment({
      read: () => read,
      sendBaseline: ({ text }) => {
        events.push(`baseline:${text}`);
        return true;
      },
      sendReset: () => {
        events.push("reset");
        return true;
      },
      attach: () => events.push("attach"),
    });

    expect(events).toEqual([]);
    resolveRead?.({ text: "history", truncated: false });
    await initialization;

    expect(events).toEqual(["baseline:history", "attach"]);
  });

  it("sends a reset before attaching when terminal history is unavailable", async () => {
    const events: string[] = [];
    await initializeTerminalAttachment({
      read: () => Promise.reject(new Error("history unavailable")),
      sendBaseline: () => {
        events.push("baseline");
        return true;
      },
      sendReset: () => {
        events.push("reset");
        return true;
      },
      attach: () => events.push("attach"),
    });

    expect(events).toEqual(["reset", "attach"]);
  });

  it("bounds baseline frames after JSON serialization", () => {
    const oversized = `prefix-${"\u0000".repeat(TERMINAL_LIMITS.maxFrameBytes)}-suffix`;
    const frame = boundedBaselineFrame(7, { text: oversized, truncated: false });

    expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThanOrEqual(
      TERMINAL_LIMITS.maxFrameBytes,
    );
    expect(frame).toMatchObject({ sequence: 7, truncated: true });
    expect(frame.data.endsWith("-suffix")).toBe(true);
  });
});
