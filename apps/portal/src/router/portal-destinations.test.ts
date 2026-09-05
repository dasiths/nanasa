import { describe, expect, it } from "vitest";
import {
  globalDestinationDefinitions,
  globalDestinations,
  groupDestinations,
} from "./portal-destinations.js";
import { parsePortalRoute } from "./portal-router.js";

describe("portal destination registry", () => {
  it("defines every accepted global route exactly once", () => {
    expect(new Set(globalDestinations).size).toBe(globalDestinations.length);
    expect(globalDestinationDefinitions.map(({ id }) => id)).toEqual(globalDestinations);
    for (const destination of globalDestinationDefinitions) {
      expect(parsePortalRoute(`/${destination.id}`)).toEqual({
        kind: "global",
        destination: destination.id,
      });
      expect(destination.commandLabel).not.toBe("");
      expect(destination.commandDescription).not.toBe("");
    }
  });

  it("keeps stable group routes while exposing distinct labels", () => {
    expect(groupDestinations.map(({ id }) => id)).toEqual(["terminals", "messages", "activity"]);
    expect(groupDestinations.map(({ label }) => label)).toEqual([
      "Terminals",
      "Messages",
      "Attention",
    ]);
    expect(groupDestinations.find(({ id }) => id === "activity")).toMatchObject({
      commandLabel: "Open group attention",
      commandDescription: "Review responses, health, completions, delivery, and durable progress",
    });
    expect(parsePortalRoute("/groups/group-one/activity")).toEqual({
      kind: "group",
      groupId: "group-one",
      section: "activity",
    });
  });

  it("does not assign duplicate keyboard shortcuts", () => {
    const shortcuts = globalDestinationDefinitions.flatMap((destination) =>
      "shortcut" in destination ? [destination.shortcut] : [],
    );
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("keeps checkouts primary and providers in utilities", () => {
    expect(globalDestinationDefinitions.find(({ id }) => id === "checkouts")?.group).toBe(
      "operations",
    );
    expect(globalDestinationDefinitions.find(({ id }) => id === "extensions")?.group).toBe(
      "utilities",
    );
  });
});
