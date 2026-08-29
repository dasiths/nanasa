import { z } from "zod";
import { DeliveryOutcomeSchema, GroupMessageStateSchema, MessageSchema } from "./actions-v1.js";
import { ConfigStatusSchema, NanasaConfigSchema } from "./config-v2.js";
import {
  AgentRunSchema,
  GroupMembershipSchema,
  GroupSchema,
  IdentifierSchema,
  TimestampSchema,
} from "./control-v1.js";
import { AgentProfileSchema } from "./provider-v1.js";
import { AgentStatusSummarySchema } from "./status-v2.js";

export const EVENT_PROTOCOL_VERSION = 1 as const;
export const EventCursorSchema = z.number().int().nonnegative();
export const EventFilterSchema = z
  .object({
    types: z.array(z.string().trim().min(1).max(100)).max(64).optional(),
    aggregateTypes: z.array(z.string().trim().min(1).max(100)).max(32).optional(),
    aggregateIds: z.array(IdentifierSchema).max(256).optional(),
  })
  .strict();
export const DomainEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    id: IdentifierSchema,
    type: z.string().trim().min(1).max(100),
    aggregateType: z.string().trim().min(1).max(100),
    aggregateId: IdentifierSchema,
    occurredAt: TimestampSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const EventServerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("welcome"),
      version: z.literal(1),
      cursor: EventCursorSchema,
      instanceId: IdentifierSchema,
      daemonEpoch: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal("event"), event: DomainEventSchema }).strict(),
  z
    .object({
      type: z.literal("reset"),
      reason: z.enum(["cursor_expired", "filter_changed", "server_restart"]),
      cursor: EventCursorSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("heartbeat"), cursor: EventCursorSchema, sentAt: TimestampSchema })
    .strict(),
  z
    .object({ type: z.literal("slow_consumer"), retryAfterMs: z.number().int().positive() })
    .strict(),
  z
    .object({
      type: z.literal("restart"),
      daemonEpoch: z.number().int().nonnegative(),
      retryAfterMs: z.number().int().positive(),
    })
    .strict(),
]);

export const PortalSnapshotSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    generatedAt: TimestampSchema,
    groups: z.array(GroupSchema),
    agentProfiles: z.array(AgentProfileSchema),
    memberships: z.array(GroupMembershipSchema),
    runs: z.array(AgentRunSchema),
    agentStatuses: z.array(AgentStatusSummarySchema).optional(),
    messages: z.array(MessageSchema),
    deliveryOutcomes: z.array(DeliveryOutcomeSchema),
    messageGroups: z.array(GroupMessageStateSchema).optional(),
    config: NanasaConfigSchema.optional(),
    configStatus: ConfigStatusSchema.optional(),
  })
  .strict();
export type PortalSnapshot = z.infer<typeof PortalSnapshotSchema>;
