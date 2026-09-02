import { describe, expect, it } from "vitest";
import { ProviderOscTracker } from "../src/terminal/provider-osc-tracker.js";

const bytes = (value: string): Uint8Array => Buffer.from(value, "utf8");

describe("bounded provider OSC tracking", () => {
  it("tracks split title and progress with BEL and ST terminators", () => {
    const tracker = new ProviderOscTracker();
    expect(tracker.observe(bytes("\u001b]2;Agent"))).toBe(false);
    expect(tracker.observe(bytes(" working\u0007"))).toBe(true);
    expect(tracker.snapshot()).toMatchObject({ title: "Agent working", revision: 1 });
    expect(tracker.observe(bytes("\u001b]9;42%\u001b\\"))).toBe(true);
    expect(tracker.snapshot()).toEqual({ title: "Agent working", progress: "42%", revision: 2 });
  });

  it("ignores OSC 52, strips controls, clears empty titles, and bounds retained values", () => {
    const tracker = new ProviderOscTracker();
    tracker.observe(bytes("\u001b]52;c;secret-clipboard\u0007"));
    expect(tracker.snapshot()).toEqual({ revision: 0 });
    tracker.observe(bytes(`\u001b]0;${"x".repeat(300)}\nunsafe\u0007`));
    expect(tracker.snapshot().title).toHaveLength(256);
    expect(tracker.snapshot().title).not.toContain("\n");
    tracker.observe(bytes("\u001b]0;\u0007"));
    expect(tracker.snapshot().title).toBe("");
  });

  it("drops oversized messages, recovers, and clears partial state on process replacement", () => {
    const tracker = new ProviderOscTracker();
    tracker.observe(bytes(`\u001b]2;${"x".repeat(4_097)}\u0007`));
    expect(tracker.snapshot()).toEqual({ revision: 0 });
    tracker.observe(bytes("\u001b]2;recovered\u0007"));
    expect(tracker.snapshot().title).toBe("recovered");
    tracker.observe(bytes("\u001b]9;partial"));
    tracker.resetForProcess();
    tracker.observe(bytes("-old\u0007"));
    expect(tracker.snapshot()).toEqual({ revision: 2 });
  });
});
