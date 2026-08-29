import { describe, expect, it } from "vitest";
import { TerminalEffectPolicy } from "../src/terminal/terminal-effect-policy.js";

describe("TerminalEffectPolicy", () => {
  it("extracts a fragmented valid OSC 52 write only for a controller", () => {
    const policy = new TerminalEffectPolicy();
    expect(policy.filter("before\u001b]52;c;SGV", true).output).toBe("before");
    const result = policy.filter("sbG8g8J+MjQ==\u0007after", true);
    expect(result.output).toBe("after");
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({ kind: "clipboard-write", data: "Hello 🌍" });
  });

  it.each([
    "\u001b]52;c;?\u0007",
    "\u001b]52;p;SGVsbG8=\u0007",
    "\u001b]52;c;not-base64\u0007",
    `\u001b]52;c;${Buffer.from("a\0b").toString("base64")}\u0007`,
    `\u001b]52;c;${Buffer.from([0xff]).toString("base64")}\u0007`,
  ])("rejects OSC 52 reads, targets, malformed data, NUL, and invalid UTF-8", (sequence) => {
    expect(new TerminalEffectPolicy().filter(sequence, true).effects).toEqual([]);
  });

  it("never creates clipboard effects for observers", () => {
    const sequence = `\u001b]52;c;${Buffer.from("secret").toString("base64")}\u0007`;
    expect(new TerminalEffectPolicy().filter(sequence, false).effects).toEqual([]);
  });
});
