import { describe, expect, it } from "vitest";

import { normalizeMembershipOrder, orderedMembershipEntries } from "../src/membership-order.js";

const membership = (memberId: string, order?: number) => ({
  memberId,
  agentProfileId: "profile-one",
  alias: memberId,
  instructions: [],
  ...(order === undefined ? {} : { order }),
});

describe("membership order", () => {
  it("orders explicit positions before legacy source-order entries", () => {
    const entries = orderedMembershipEntries({
      membership_legacy: membership("legacy"),
      membership_second: membership("second", 5),
      membership_first: membership("first", 1),
    });

    expect(entries.map(([, configured]) => configured.memberId)).toEqual([
      "first",
      "second",
      "legacy",
    ]);
  });

  it("normalizes sparse and duplicate positions to dense stable values", () => {
    const normalized = normalizeMembershipOrder({
      membership_alpha: membership("alpha", 4),
      membership_beta: membership("beta", 4),
      membership_gamma: membership("gamma"),
    });

    expect(Object.values(normalized).map(({ memberId, order }) => [memberId, order])).toEqual([
      ["alpha", 0],
      ["beta", 1],
      ["gamma", 2],
    ]);
  });
});
