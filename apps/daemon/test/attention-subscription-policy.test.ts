import { AttentionSubscriptionOverrideSchema, NanasaConfigSchema } from "@nanasa/contracts";
import { describe, expect, it } from "vitest";
import { resolveMemberAttentionSubscriptions } from "../src/attention-subscription-policy.js";

describe("Attention subscription policy", () => {
  it("resolves repository, agent, and operator precedence with provenance", () => {
    const config = NanasaConfigSchema.parse({
      version: 2,
      integrations: {
        copilot: {
          id: "copilot",
          name: "Copilot",
          kind: "copilot",
          command: ["copilot"],
          commandSource: "builtin",
        },
      },
      attention: {
        defaults: {
          "response-required": true,
          "agent-health": true,
          completion: false,
          "delivery-failure": true,
          "action-state": false,
          "provider-update-failed": true,
          "provider-update-succeeded": false,
          "unread-message": false,
        },
      },
      groups: {
        team: {
          name: "Team",
          agents: {
            manager: {
              memberId: "manager",
              name: "Manager",
              integrationId: "copilot",
              attention: { completion: true },
            },
          },
        },
      },
    });
    const override = AttentionSubscriptionOverrideSchema.parse({
      operatorId: "operator-one",
      groupId: "team",
      memberId: "manager",
      eventType: "completion",
      enabled: false,
      updatedAt: "2026-09-03T12:00:00.000Z",
    });

    expect(
      resolveMemberAttentionSubscriptions(config, { groupId: "team", memberId: "manager" }, [
        override,
      ]).subscriptions,
    ).toEqual(
      expect.arrayContaining([
        { eventType: "response-required", enabled: true, source: "repository-default" },
        { eventType: "completion", enabled: false, source: "operator-override" },
      ]),
    );
    expect(
      resolveMemberAttentionSubscriptions(config, { groupId: "team", memberId: "manager" }, [])
        .subscriptions,
    ).toEqual(
      expect.arrayContaining([{ eventType: "completion", enabled: true, source: "agent-config" }]),
    );
  });
});
