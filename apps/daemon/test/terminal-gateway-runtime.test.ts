import { describe, expect, it } from "vitest";
import { TerminalEffectPolicy } from "../src/terminal/terminal-effect-policy.js";
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
});
