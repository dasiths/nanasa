import { describe, expect, it } from "vitest";
import {
  cleanStalePortalPreferences,
  defaultPortalPreferences,
  parsePortalPreferences,
} from "./use-portal-preferences.js";

describe("portal preferences v2", () => {
  it("parses version 2 fields and rejects old or malformed values", () => {
    expect(
      parsePortalPreferences('{"version":2,"theme":"dark","terminalLayout":"grid"}'),
    ).toMatchObject({
      version: 2,
      theme: "dark",
      terminalLayout: "grid",
      notifications: { inApp: true, desktop: false, sound: false },
    });
    expect(parsePortalPreferences('{"theme":"neon","motion":"unsafe"}')).toMatchObject({
      theme: "system",
      motion: "system",
    });
    expect(parsePortalPreferences("not json")).toEqual(defaultPortalPreferences);
    expect(parsePortalPreferences('{"version":1,"theme":"dark"}')).toEqual(
      defaultPortalPreferences,
    );
  });

  it("removes deleted group and run identifiers without changing presentation", () => {
    const cleaned = cleanStalePortalPreferences(
      {
        ...defaultPortalPreferences,
        theme: "dark",
        selectedGroupId: "deleted",
        expandedGroupIds: ["kept", "deleted"],
        lastSectionByGroup: { kept: "activity", deleted: "messages" },
        activeRunByGroup: { kept: "run-kept", deleted: "run-old" },
      },
      new Map([["kept", new Set(["run-kept"])]]),
    );
    expect(cleaned).toMatchObject({
      theme: "dark",
      expandedGroupIds: ["kept"],
      lastSectionByGroup: { kept: "activity" },
      activeRunByGroup: { kept: "run-kept" },
    });
    expect(cleaned).not.toHaveProperty("selectedGroupId");
  });
});
