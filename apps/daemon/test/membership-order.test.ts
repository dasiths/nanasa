import { describe, expect, it } from "vitest";

import { normalizeAgentOrder, orderedAgentEntries } from "../src/membership-order.js";

const agent = (memberId: string, order?: number) => ({
  memberId,
  name: memberId,
  integrationId: "copilot",
  instructions: [],
  ...(order === undefined ? {} : { order }),
});

describe("agent order", () => {
  it("orders explicit positions before source-order entries", () => {
    const entries = orderedAgentEntries({
      agent_legacy: agent("legacy"),
      agent_second: agent("second", 5),
      agent_first: agent("first", 1),
    });

    expect(entries.map(([, configured]) => configured.memberId)).toEqual([
      "first",
      "second",
      "legacy",
    ]);
  });

  it("normalizes sparse and duplicate positions to dense stable values", () => {
    const normalized = normalizeAgentOrder({
      agent_alpha: agent("alpha", 4),
      agent_beta: agent("beta", 4),
      agent_gamma: agent("gamma"),
    });

    expect(Object.values(normalized).map(({ memberId, order }) => [memberId, order])).toEqual([
      ["alpha", 0],
      ["beta", 1],
      ["gamma", 2],
    ]);
  });
});
