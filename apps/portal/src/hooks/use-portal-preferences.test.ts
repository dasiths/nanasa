import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanStalePortalPreferences,
  commitPortalPreferenceUpdate,
  defaultPortalPreferences,
  mergePortalPreferenceUpdate,
  PORTAL_PREFERENCES_KEY,
  type PortalPreferences,
  parsePortalPreferences,
  usePortalPreferences,
} from "./use-portal-preferences.js";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("portal preferences v2", () => {
  it("parses version 2 fields and rejects old or malformed values", () => {
    expect(
      parsePortalPreferences(
        '{"version":2,"theme":"dark","terminalLayout":"grid","pinnedRunIdsByGroup":{"group":["run"]},"completionNotificationMemberIdsByGroup":{"group":["member","member",3],"invalid":"member"},"maximizedRunByGroup":{"group":"run"},"terminalSplitRatioByGroup":{"group":65},"terminalColumnsByGroup":{"group":3,"automatic":"auto","invalid":4}}',
      ),
    ).toMatchObject({
      version: 2,
      theme: "dark",
      pinnedRunIdsByGroup: { group: ["run"] },
      terminalColumnsByGroup: { group: 3, automatic: "auto" },
      dismissedProviderUpdateIds: [],
      notifications: { desktop: false, sound: false },
    });
    expect(
      parsePortalPreferences(
        '{"version":2,"completionNotificationMemberIdsByGroup":{"group":["member"]},"notifications":{"inApp":false}}',
      ),
    ).not.toHaveProperty("completionNotificationMemberIdsByGroup");
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
      dismissedProviderUpdateIds: [],
    });
  });

  it("parses a bounded set of dismissed provider updates", () => {
    const identifiers = Array.from({ length: 105 }, (_, index) => `update-${index}`);
    expect(
      parsePortalPreferences(
        JSON.stringify({
          ...defaultPortalPreferences,
          dismissedProviderUpdateIds: [...identifiers, "update-104", 3],
        }),
      ).dismissedProviderUpdateIds,
    ).toEqual(identifiers.slice(-100));
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
        terminalColumnsByGroup: { kept: 3, deleted: 1 },
      },
      new Map([["kept", new Set(["run-kept"])]]),
    );
    expect(cleaned).toMatchObject({
      theme: "dark",
      expandedGroupIds: ["kept"],
      lastSectionByGroup: { kept: "activity" },
      activeRunByGroup: { kept: "run-kept" },
      pinnedRunIdsByGroup: { kept: ["run-kept"] },
      terminalColumnsByGroup: { kept: 3 },
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
      activeRunByGroup: { "group-one": "run-two" },
      terminalColumnsByGroup: { "group-two": 3 as const },
      notifications: { ...current.notifications, sound: true },
    };
    expect(mergePortalPreferenceUpdate(current, locallyPinned, storedFromAnotherTab)).toMatchObject(
      {
        pinnedRunIdsByGroup: { "group-one": ["run-one"] },
        activeRunByGroup: { "group-one": "run-two" },
        terminalColumnsByGroup: { "group-two": 3 },
        notifications: { sound: true },
      },
    );

    const sameFieldDifferentGroup = mergePortalPreferenceUpdate(
      current,
      { ...current, terminalColumnsByGroup: { "group-one": 1 } },
      { ...current, terminalColumnsByGroup: { "group-two": 2 } },
    );
    expect(sameFieldDifferentGroup.terminalColumnsByGroup).toEqual({
      "group-one": 1,
      "group-two": 2,
    });

    const sameGroupPins = mergePortalPreferenceUpdate(
      { ...current, pinnedRunIdsByGroup: { group: ["run-one"] } },
      { ...current, pinnedRunIdsByGroup: { group: ["run-one", "run-three"] } },
      { ...current, pinnedRunIdsByGroup: { group: ["run-one", "run-two"] } },
    );
    expect(sameGroupPins.pinnedRunIdsByGroup.group).toEqual(["run-one", "run-two", "run-three"]);

    const cleanupDoesNotEraseNewer = mergePortalPreferenceUpdate(
      { ...current, activeRunByGroup: { group: "run-old" } },
      current,
      { ...current, activeRunByGroup: { group: "run-new" } },
    );
    expect(cleanupDoesNotEraseNewer.activeRunByGroup).toEqual({ group: "run-new" });
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
        activeRunByGroup: { ...current.activeRunByGroup, group: "run-two" },
      })),
      commitPortalPreferenceUpdate((current) => ({
        ...current,
        terminalColumnsByGroup: { ...current.terminalColumnsByGroup, group: 3 },
      })),
    ]);
    expect(
      parsePortalPreferences(window.localStorage.getItem("nanasa.portal.preferences.v2")),
    ).toMatchObject({
      pinnedRunIdsByGroup: { group: ["run-one"] },
      activeRunByGroup: { group: "run-two" },
      terminalColumnsByGroup: { group: 3 },
    });
  });

  it("synchronizes browser notification preferences written by another tab", async () => {
    window.localStorage.setItem(PORTAL_PREFERENCES_KEY, JSON.stringify(defaultPortalPreferences));
    const { result } = renderHook(() => usePortalPreferences());
    const fromOtherTab = {
      ...defaultPortalPreferences,
      notifications: { ...defaultPortalPreferences.notifications, desktop: true },
    };

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: PORTAL_PREFERENCES_KEY,
          oldValue: JSON.stringify(defaultPortalPreferences),
          newValue: JSON.stringify(fromOtherTab),
          storageArea: window.localStorage,
        }),
      );
    });

    await waitFor(() => expect(result.current.preferences.notifications.desktop).toBe(true));
  });
});
