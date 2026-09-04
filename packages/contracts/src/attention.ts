import { z } from "zod";
import { IdentifierSchema, TimestampSchema } from "./control.js";

export const AttentionEventTypeSchema = z.enum([
  "response-required",
  "agent-health",
  "completion",
  "delivery-failure",
  "action-state",
  "provider-update-failed",
  "provider-update-succeeded",
  "unread-message",
]);
export type AttentionEventType = z.infer<typeof AttentionEventTypeSchema>;

export const ATTENTION_EVENT_TYPES = AttentionEventTypeSchema.options;

export const DEFAULT_ATTENTION_SUBSCRIPTIONS = {
  "response-required": true,
  "agent-health": true,
  completion: true,
  "delivery-failure": true,
  "action-state": false,
  "provider-update-failed": true,
  "provider-update-succeeded": false,
  "unread-message": false,
} as const satisfies Record<AttentionEventType, boolean>;

export const AttentionSubscriptionPolicySchema = z
  .object({
    "response-required": z.boolean(),
    "agent-health": z.boolean(),
    completion: z.boolean(),
    "delivery-failure": z.boolean(),
    "action-state": z.boolean(),
    "provider-update-failed": z.boolean(),
    "provider-update-succeeded": z.boolean(),
    "unread-message": z.boolean(),
  })
  .strict();
export type AttentionSubscriptionPolicy = z.infer<typeof AttentionSubscriptionPolicySchema>;

export const AttentionSubscriptionConfigSchema = z
  .object({ defaults: AttentionSubscriptionPolicySchema.default(DEFAULT_ATTENTION_SUBSCRIPTIONS) })
  .strict();
export type AttentionSubscriptionConfig = z.infer<typeof AttentionSubscriptionConfigSchema>;

export const AgentAttentionSubscriptionConfigSchema = AttentionSubscriptionPolicySchema.partial();
export type AgentAttentionSubscriptionConfig = z.infer<
  typeof AgentAttentionSubscriptionConfigSchema
>;

export const AttentionSubscriptionSourceSchema = z.enum([
  "repository-default",
  "agent-config",
  "operator-override",
]);
export type AttentionSubscriptionSource = z.infer<typeof AttentionSubscriptionSourceSchema>;

export const EffectiveAttentionSubscriptionSchema = z
  .object({
    eventType: AttentionEventTypeSchema,
    enabled: z.boolean(),
    source: AttentionSubscriptionSourceSchema,
  })
  .strict();
export type EffectiveAttentionSubscription = z.infer<typeof EffectiveAttentionSubscriptionSchema>;

export const MemberAttentionSubscriptionsSchema = z
  .object({
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    subscriptions: z
      .array(EffectiveAttentionSubscriptionSchema)
      .length(ATTENTION_EVENT_TYPES.length),
    updatedAt: TimestampSchema.optional(),
  })
  .strict();
export type MemberAttentionSubscriptions = z.infer<typeof MemberAttentionSubscriptionsSchema>;

export const AttentionSubscriptionsSnapshotSchema = z
  .object({
    defaults: AttentionSubscriptionPolicySchema,
    members: z.array(MemberAttentionSubscriptionsSchema),
  })
  .strict();
export type AttentionSubscriptionsSnapshot = z.infer<typeof AttentionSubscriptionsSnapshotSchema>;

export const SetAttentionSubscriptionCommandSchema = z.object({ enabled: z.boolean() }).strict();
export type SetAttentionSubscriptionCommand = z.infer<typeof SetAttentionSubscriptionCommandSchema>;

export const AttentionSubscriptionOverrideSchema = z
  .object({
    operatorId: IdentifierSchema,
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    eventType: AttentionEventTypeSchema,
    enabled: z.boolean(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type AttentionSubscriptionOverride = z.infer<typeof AttentionSubscriptionOverrideSchema>;
