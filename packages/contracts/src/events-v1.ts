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
import { CheckoutSchema, RepositorySchema, WorktreeSchema } from "./git-v1.js";

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
      type: z.literal("subscription.started"),
      version: z.literal(1),
      cursor: EventCursorSchema,
      highWater: EventCursorSchema,
      earliestAvailable: EventCursorSchema,
      instanceId: IdentifierSchema,
      daemonEpoch: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal("domain.event"), event: DomainEventSchema }).strict(),
  z
    .object({
      type: z.literal("subscription.reset-required"),
      reason: z.enum(["cursor_expired", "cursor_ahead", "instance_changed"]),
      cursor: EventCursorSchema,
      snapshotUrl: z.literal("/api/v1/snapshot"),
    })
    .strict(),
  z
    .object({
      type: z.literal("subscription.heartbeat"),
      cursor: EventCursorSchema,
      sentAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("subscription.slow-consumer"),
      cursor: EventCursorSchema,
      retryAfterMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("subscription.planned-restart"),
      daemonEpoch: z.number().int().positive(),
      retryAfterMs: z.number().int().positive(),
    })
    .strict(),
]);
export type EventServerFrame = z.infer<typeof EventServerFrameSchema>;

export const PortalSnapshotSchema = z
  .object({
    instanceId: IdentifierSchema,
    daemonEpoch: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    generatedAt: TimestampSchema,
    orderRevision: z.number().int().nonnegative().default(0),
    groups: z.array(GroupSchema),
    agentProfiles: z.array(AgentProfileSchema),
    memberships: z.array(GroupMembershipSchema),
    runs: z.array(AgentRunSchema),
    repositories: z.array(RepositorySchema).default([]),
    checkouts: z.array(CheckoutSchema).default([]),
    worktrees: z.array(WorktreeSchema).default([]),
    agentStatuses: z.array(AgentStatusSummarySchema).optional(),
    messages: z.array(MessageSchema),
    deliveryOutcomes: z.array(DeliveryOutcomeSchema),
    messageGroups: z.array(GroupMessageStateSchema).optional(),
    config: NanasaConfigSchema.optional(),
    configStatus: ConfigStatusSchema.optional(),
  })
  .strict();
export type PortalSnapshot = z.infer<typeof PortalSnapshotSchema>;
