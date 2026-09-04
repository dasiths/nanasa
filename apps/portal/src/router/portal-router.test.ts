import { describe, expect, it } from "vitest";
import { groupRoute, parsePortalRoute } from "./portal-router.js";

describe("portal router", () => {
  it("parses group and global deep links", () => {
    expect(parsePortalRoute("/groups/group-one/messages")).toEqual({
      kind: "group",
      groupId: "group-one",
      section: "messages",
    });
    expect(parsePortalRoute("/groups/group-one/terminals/run-one")).toEqual({
      kind: "group",
      groupId: "group-one",
      section: "terminals",
      runId: "run-one",
    });
    expect(parsePortalRoute("/diagnostics")).toEqual({
      kind: "global",
      destination: "diagnostics",
    });
  });

  it("rejects malformed routes and encodes stable IDs", () => {
    expect(parsePortalRoute("/groups/group-one/messages/run-one").kind).toBe("invalid");
    expect(parsePortalRoute("/groups/group-one/settings").kind).toBe("invalid");
    expect(parsePortalRoute("/unknown").kind).toBe("invalid");
    expect(groupRoute("group one", "terminals", "run/one")).toBe(
      "/groups/group%20one/terminals/run%2Fone",
    );
  });
});
