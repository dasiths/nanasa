import { describe, expect, it } from "vitest";
import { daemonStartupErrorPayload } from "../src/index.js";

describe("daemon startup errors", () => {
  it("removes stack output while preserving an actionable message", () => {
    expect(
      daemonStartupErrorPayload(new Error("Provider package generation is immutable")),
    ).toEqual({
      message: "Provider package generation is immutable",
      details: {},
      code: "daemon_start_failed",
    });
  });
});
