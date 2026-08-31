import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanStalePortalPreferences,
  commitPortalPreferenceUpdate,
  defaultPortalPreferences,
  mergePortalPreferenceUpdate,
  type PortalPreferences,
  parsePortalPreferences,
} from "./use-portal-preferences.js";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("portal preferences v2", () => {
  it("parses version 2 fields and rejects old or malformed values", () => {
    expect(
      parsePortalPreferences(
        '{"version":2,"theme":"dark","terminalLayout":"grid","pinnedRunIdsByGroup":{"group":["run"]},"completionNotificationMemberIdsByGroup":{"group":["member","member",3],"invalid":"member"},"maximizedRunByGroup":{"group":"run"},"terminalSplitRatioByGroup":{"group":65,"invalid":90}}',
      ),
    ).toMatchObject({
      version: 2,
      theme: "dark",
      terminalLayout: "grid",
      pinnedRunIdsByGroup: { group: ["run"] },
      completionNotificationMemberIdsByGroup: { group: ["member"] },
      maximizedRunByGroup: { group: "run" },
      terminalSplitRatioByGroup: { group: 65 },
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
    expect(parsePortalPreferences('{"version":2,"theme":"dark"}')).toMatchObject({
      theme: "dark",
      completionNotificationMemberIdsByGroup: {},
    });
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
        pinnedRunIdsByGroup: { kept: ["run-kept", "run-old"], deleted: ["run-old"] },
        completionNotificationMemberIdsByGroup: {
          kept: ["member-kept", "member-old"],
          deleted: ["member-old"],
        },
        maximizedRunByGroup: { kept: "run-kept", deleted: "run-old" },
        terminalSplitRatioByGroup: { kept: 65, deleted: 40 },
      },
      new Map([["kept", new Set(["run-kept"])]]),
      new Map([["kept", new Set(["member-kept"])]]),
    );
    expect(cleaned).toMatchObject({
      theme: "dark",
      expandedGroupIds: ["kept"],
      lastSectionByGroup: { kept: "activity" },
      activeRunByGroup: { kept: "run-kept" },
      pinnedRunIdsByGroup: { kept: ["run-kept"] },
      completionNotificationMemberIdsByGroup: { kept: ["member-kept"] },
      maximizedRunByGroup: { kept: "run-kept" },
      terminalSplitRatioByGroup: { kept: 65 },
    });
    expect(cleaned).not.toHaveProperty("selectedGroupId");
  });

  it("merges concurrent cross-tab changes by field and group resource", () => {
    const current = defaultPortalPreferences;
    const locallyPinned = {
      ...current,
      pinnedRunIdsByGroup: { "group-one": ["run-one"] },
    };
    const storedFromAnotherTab = {
      ...current,
      maximizedRunByGroup: { "group-one": "run-two" },
      terminalSplitRatioByGroup: { "group-two": 65 },
      notifications: { ...current.notifications, sound: true },
    };
    expect(mergePortalPreferenceUpdate(current, locallyPinned, storedFromAnotherTab)).toMatchObject(
      {
        pinnedRunIdsByGroup: { "group-one": ["run-one"] },
        maximizedRunByGroup: { "group-one": "run-two" },
        terminalSplitRatioByGroup: { "group-two": 65 },
        notifications: { sound: true },
      },
    );

    const sameFieldDifferentGroup = mergePortalPreferenceUpdate(
      current,
      { ...current, terminalSplitRatioByGroup: { "group-one": 40 } },
      { ...current, terminalSplitRatioByGroup: { "group-two": 60 } },
    );
    expect(sameFieldDifferentGroup.terminalSplitRatioByGroup).toEqual({
      "group-one": 40,
      "group-two": 60,
    });

    const sameGroupPins = mergePortalPreferenceUpdate(
      { ...current, pinnedRunIdsByGroup: { group: ["run-one"] } },
      { ...current, pinnedRunIdsByGroup: { group: ["run-one", "run-three"] } },
      { ...current, pinnedRunIdsByGroup: { group: ["run-one", "run-two"] } },
    );
    expect(sameGroupPins.pinnedRunIdsByGroup.group).toEqual(["run-one", "run-two", "run-three"]);

    const sameGroupCompletionOptIns = mergePortalPreferenceUpdate(
      {
        ...current,
        completionNotificationMemberIdsByGroup: { group: ["member-one"] },
      },
      {
        ...current,
        completionNotificationMemberIdsByGroup: { group: ["member-one", "member-three"] },
      },
      {
        ...current,
        completionNotificationMemberIdsByGroup: { group: ["member-one", "member-two"] },
      },
    );
    expect(sameGroupCompletionOptIns.completionNotificationMemberIdsByGroup.group).toEqual([
      "member-one",
      "member-two",
      "member-three",
    ]);

    const cleanupDoesNotEraseNewer = mergePortalPreferenceUpdate(
      { ...current, maximizedRunByGroup: { group: "run-old" } },
      current,
      { ...current, maximizedRunByGroup: { group: "run-new" } },
    );
    expect(cleanupDoesNotEraseNewer.maximizedRunByGroup).toEqual({ group: "run-new" });
  });

  it("serializes true cross-agent updates through one browser lock", async () => {
    let queue = Promise.resolve();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => PortalPreferences) => {
          const result = queue.then(callback);
          queue = result.then(() => undefined);
          return result;
        },
      },
    });
    window.localStorage.setItem(
      "nanasa.portal.preferences.v2",
      JSON.stringify(defaultPortalPreferences),
    );
    await Promise.all([
      commitPortalPreferenceUpdate((current) => ({
        ...current,
        pinnedRunIdsByGroup: { ...current.pinnedRunIdsByGroup, group: ["run-one"] },
      })),
      commitPortalPreferenceUpdate((current) => ({
        ...current,
        maximizedRunByGroup: { ...current.maximizedRunByGroup, group: "run-two" },
      })),
      commitPortalPreferenceUpdate((current) => ({
        ...current,
        terminalSplitRatioByGroup: { ...current.terminalSplitRatioByGroup, group: 65 },
      })),
      commitPortalPreferenceUpdate((current) => ({
        ...current,
        completionNotificationMemberIdsByGroup: {
          ...current.completionNotificationMemberIdsByGroup,
          group: ["member-one"],
        },
      })),
    ]);
    expect(
      parsePortalPreferences(window.localStorage.getItem("nanasa.portal.preferences.v2")),
    ).toMatchObject({
      pinnedRunIdsByGroup: { group: ["run-one"] },
      maximizedRunByGroup: { group: "run-two" },
      terminalSplitRatioByGroup: { group: 65 },
      completionNotificationMemberIdsByGroup: { group: ["member-one"] },
    });
  });
});
