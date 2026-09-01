import { describe, expect, it } from "vitest";
import {
  ProviderDirtySequence,
  type ProviderScreenSignal,
  ProviderScreenStabilizer,
} from "../src/providers/provider-observation-stabilizer.js";

const working: ProviderScreenSignal = {
  state: "working",
  visibleIdle: false,
  visibleWorking: true,
  visibleBlocker: false,
};
const plainIdle: ProviderScreenSignal = {
  state: "idle",
  visibleIdle: false,
  visibleWorking: false,
  visibleBlocker: false,
};

describe("provider observation stabilization", () => {
  it("applies startup grace and three spaced Idle confirmations", () => {
    const stabilizer = new ProviderScreenStabilizer();
    stabilizer.resetForProcess(0);
    expect(stabilizer.observe(plainIdle, 2_999)).toMatchObject({
      publish: false,
      reason: "startup-grace",
    });
    expect(stabilizer.observe(working, 1_000)).toMatchObject({ publish: true, reason: "changed" });
    expect(stabilizer.observe(plainIdle, 3_000)).toMatchObject({
      publish: false,
      reason: "idle-confirmation",
    });
    expect(stabilizer.observe(plainIdle, 3_050).publish).toBe(false);
    expect(stabilizer.observe(plainIdle, 3_100).publish).toBe(false);
    expect(stabilizer.observe(plainIdle, 3_200)).toMatchObject({
      publish: true,
      reason: "idle-confirmed",
      signal: { state: "idle" },
    });
  });

  it("caps pending Idle and cancels it when work resumes", () => {
    const stabilizer = new ProviderScreenStabilizer();
    stabilizer.resetForProcess(0);
    stabilizer.observe(working, 1_000);
    stabilizer.observe(plainIdle, 3_000);
    expect(stabilizer.observe(working, 3_100)).toMatchObject({
      publish: false,
      reason: "unchanged",
    });
    stabilizer.observe(plainIdle, 3_200);
    expect(stabilizer.observe(plainIdle, 3_900)).toMatchObject({
      publish: true,
      reason: "idle-cap",
    });
  });

  it("rejects captures when dirty sequence or identity fence changes", () => {
    const dirty = new ProviderDirtySequence();
    dirty.markDirty("pane-one");
    const capture = dirty.beginCapture("pane-one", "fence-one");
    expect(dirty.accepts(capture, "fence-one")).toBe(true);
    dirty.markDirty("pane-one");
    expect(dirty.accepts(capture, "fence-one")).toBe(false);
    const next = dirty.beginCapture("pane-one", "fence-one");
    expect(dirty.accepts(next, "fence-two")).toBe(false);
    dirty.clear("pane-one");
    expect(dirty.accepts(next, "fence-one")).toBe(false);
  });
});
