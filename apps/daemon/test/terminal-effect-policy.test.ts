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

  it("consumes Copilot's primary write and emits one clipboard effect for c", () => {
    const encoded = Buffer.from("copied text").toString("base64");
    const result = new TerminalEffectPolicy().filter(
      `before\u001b]52;p!;${encoded};\u0007between\u001b]52;c;${encoded}\u0007after`,
      true,
    );

    expect(result.output).toBe("beforebetweenafter");
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({ data: "copied text", preview: "" });
  });

  it("preserves supported OSC and CSI while consuming unsupported string controls", () => {
    const policy = new TerminalEffectPolicy();
    const result = policy.filter(
      "before\u001b[31mred\u001b[0m\u001b]2;title\u0007" +
        "\u001bPprivate\u001b\\\u001b_ignored\u001b\\\u001b^ignored\u001b\\\u001bXignored\u001b\\after",
      true,
    );

    expect(result).toEqual({
      output: "before\u001b[31mred\u001b[0m\u001b]2;title\u0007after",
      effects: [],
    });
  });

  it("handles every split of an OSC 52 write without leaking control bytes", () => {
    const sequence = `before\u001b]52;c;${Buffer.from("split text").toString("base64")}\u001b\\after`;
    for (let split = 0; split <= sequence.length; split += 1) {
      const policy = new TerminalEffectPolicy();
      const first = policy.filter(sequence.slice(0, split), true);
      const second = policy.filter(sequence.slice(split), true);
      expect(first.output + second.output).toBe("beforeafter");
      expect([...first.effects, ...second.effects]).toHaveLength(1);
    }
  });

  it("discards oversized OSC 52 writes without leaking them into output", () => {
    const encoded = Buffer.alloc(192 * 1024 + 1, 0x61).toString("base64");
    const result = new TerminalEffectPolicy().filter(
      `before\u001b]52;c;${encoded}\u0007after`,
      true,
    );

    expect(result).toEqual({ output: "beforeafter", effects: [] });
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
    expect(new TerminalEffectPolicy().filter(sequence, false)).toEqual({ output: "", effects: [] });
  });
});
