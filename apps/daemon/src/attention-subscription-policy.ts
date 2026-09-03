import {
  ATTENTION_EVENT_TYPES,
  type AttentionEventType,
  type AttentionSubscriptionOverride,
  AttentionSubscriptionsSnapshotSchema,
  type MemberAttentionSubscriptions,
  type NanasaConfig,
} from "@nanasa/contracts";

interface AttentionMemberIdentity {
  groupId: string;
  memberId: string;
}

function configuredAgent(config: NanasaConfig, groupId: string, memberId: string) {
  return Object.values(config.groups[groupId]?.agents ?? {}).find(
    (agent) => agent.memberId === memberId,
  );
}

export function resolveMemberAttentionSubscriptions(
  config: NanasaConfig,
  member: AttentionMemberIdentity,
  overrides: readonly AttentionSubscriptionOverride[],
): MemberAttentionSubscriptions {
  const agent = configuredAgent(config, member.groupId, member.memberId);
  const overrideByEvent = new Map(
    overrides
      .filter(
        (override) => override.groupId === member.groupId && override.memberId === member.memberId,
      )
      .map((override) => [override.eventType, override] as const),
  );
  const updatedAt = overrides
    .filter(
      (override) => override.groupId === member.groupId && override.memberId === member.memberId,
    )
    .map((override) => override.updatedAt)
    .sort()
    .at(-1);
  return {
    groupId: member.groupId,
    memberId: member.memberId,
    subscriptions: ATTENTION_EVENT_TYPES.map((eventType) => {
      const override = overrideByEvent.get(eventType);
      if (override !== undefined) {
        return { eventType, enabled: override.enabled, source: "operator-override" as const };
      }
      const agentValue = agent?.attention[eventType];
      if (agentValue !== undefined) {
        return { eventType, enabled: agentValue, source: "agent-config" as const };
      }
      return {
        eventType,
        enabled: config.attention.defaults[eventType],
        source: "repository-default" as const,
      };
    }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

export function resolveAttentionSubscriptionsSnapshot(
  config: NanasaConfig,
  members: readonly AttentionMemberIdentity[],
  overrides: readonly AttentionSubscriptionOverride[],
) {
  return AttentionSubscriptionsSnapshotSchema.parse({
    defaults: config.attention.defaults,
    members: members.map((member) =>
      resolveMemberAttentionSubscriptions(config, member, overrides),
    ),
  });
}

export function policyEnables(
  policy: MemberAttentionSubscriptions,
  eventType: AttentionEventType,
): boolean {
  return (
    policy.subscriptions.find((subscription) => subscription.eventType === eventType)?.enabled ??
    false
  );
}
