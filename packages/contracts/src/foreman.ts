import { z } from "zod";
import { ForemanConfigSchema } from "./config.js";
import {
  ForemanActorSchema,
  ForemanRunSchema,
  IdentifierSchema,
  TimestampSchema,
} from "./control.js";

export const ForemanWorkspaceSchema = z
  .object({
    configuration: ForemanConfigSchema.optional(),
    actor: ForemanActorSchema.optional(),
    run: ForemanRunSchema.optional(),
    configRevision: z.string().min(1).optional(),
    problem: z.string().max(1000).optional(),
    inbox: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            messageId: IdentifierSchema.optional(),
            kind: z.enum(["human-message", "conversation-result", "notification"]),
            preview: z.string().max(500),
            conversationRequestId: IdentifierSchema.optional(),
            submittedRunId: IdentifierSchema.optional(),
            submittedGeneration: z.number().int().positive().optional(),
            createdAt: TimestampSchema,
            state: z.enum(["queued", "writing", "submitted", "answered", "ambiguous", "cancelled"]),
            updatedAt: TimestampSchema,
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type ForemanWorkspace = z.infer<typeof ForemanWorkspaceSchema>;

export const ResetForemanStateCommandSchema = z
  .object({
    scope: z.enum(["channel", "finished-goals", "all"]),
    confirmation: z.literal("RESET"),
  })
  .strict();
export type ResetForemanStateCommand = z.infer<typeof ResetForemanStateCommandSchema>;
export const ResetForemanStateResultSchema = z
  .object({
    scope: z.enum(["channel", "finished-goals", "all"]),
    goalsRemoved: z.number().int().nonnegative(),
    messagesRemoved: z.number().int().nonnegative(),
    conversationsRemoved: z.number().int().nonnegative(),
  })
  .strict();
export type ResetForemanStateResult = z.infer<typeof ResetForemanStateResultSchema>;

const CleanupGoalSelectionSchema = z
  .object({ id: IdentifierSchema, expectedRevision: z.number().int().nonnegative() })
  .strict();
const CleanupConfirmationSchema = z.object({
  requestId: IdentifierSchema,
  confirmation: z.literal(true),
});
export const CleanupForemanCommandSchema = z.discriminatedUnion("scope", [
  CleanupConfirmationSchema.extend({
    scope: z.literal("goal"),
    goal: CleanupGoalSelectionSchema,
    cancel: z.boolean().default(false),
  }).strict(),
  CleanupConfirmationSchema.extend({
    scope: z.literal("finished-goals"),
    goals: z.array(CleanupGoalSelectionSchema).min(1).max(1000),
  }).strict(),
  CleanupConfirmationSchema.extend({
    scope: z.literal("channel"),
    throughSequence: z.number().int().nonnegative(),
    conversationIds: z.array(IdentifierSchema).max(1000).optional(),
  }).strict(),
]);
export type CleanupForemanCommand = z.infer<typeof CleanupForemanCommandSchema>;
export const RequestForemanCleanupCommandSchema = z.discriminatedUnion("scope", [
  CleanupForemanCommandSchema.options[0].omit({ confirmation: true }),
  CleanupForemanCommandSchema.options[1].omit({ confirmation: true }),
  CleanupForemanCommandSchema.options[2].omit({ confirmation: true }),
]);
export type RequestForemanCleanupCommand = z.infer<typeof RequestForemanCleanupCommandSchema>;
export const ApproveForemanCleanupCommandSchema = z
  .object({
    id: IdentifierSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(true),
  })
  .strict();
export type ApproveForemanCleanupCommand = z.infer<typeof ApproveForemanCleanupCommandSchema>;
export const ForemanCleanupEffectsSchema = z
  .object({
    goalId: IdentifierSchema,
    actionIds: z.array(IdentifierSchema),
    runIds: z.array(IdentifierSchema),
  })
  .strict();
export const CleanupForemanResultSchema = z
  .object({
    scope: z.enum(["goal", "finished-goals", "channel"]),
    removedGoalIds: z.array(IdentifierSchema),
    messagesCleared: z.number().int().nonnegative(),
    clearedThrough: z.number().int().nonnegative().optional(),
    retained: z.literal(true),
    pendingEffects: z.array(ForemanCleanupEffectsSchema),
  })
  .strict();
export type CleanupForemanResult = z.infer<typeof CleanupForemanResultSchema>;
export const ForemanCleanupRequestSchema = z
  .object({
    id: IdentifierSchema,
    foremanId: IdentifierSchema,
    command: RequestForemanCleanupCommandSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["pending", "approved"]),
    createdAt: TimestampSchema,
    operatorId: IdentifierSchema.optional(),
    approvedAt: TimestampSchema.optional(),
    result: CleanupForemanResultSchema.optional(),
  })
  .strict();
export type ForemanCleanupRequest = z.infer<typeof ForemanCleanupRequestSchema>;

export const ConfigureForemanCommandSchema = z
  .object({
    configuration: ForemanConfigSchema,
    expectedConfigRevision: z.string().min(1).max(128),
  })
  .strict();
export type ConfigureForemanCommand = z.infer<typeof ConfigureForemanCommandSchema>;

export const StartForemanCommandSchema = z
  .object({
    expectedConfigRevision: z.string().min(1).max(128),
    cols: z.number().int().min(20).max(500).default(120),
    rows: z.number().int().min(5).max(200).default(36),
  })
  .strict();
export type StartForemanCommand = z.infer<typeof StartForemanCommandSchema>;

export const StopForemanCommandSchema = z
  .object({
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
  })
  .strict();
export type StopForemanCommand = z.infer<typeof StopForemanCommandSchema>;

export const ResolveForemanInputCommandSchema = z
  .object({
    inboxId: IdentifierSchema,
    expectedState: z.enum(["queued", "submitted", "ambiguous"]),
    resolution: z.enum(["cancel", "handled"]),
  })
  .strict();
export type ResolveForemanInputCommand = z.infer<typeof ResolveForemanInputCommandSchema>;

export const ForemanChannelQuerySchema = z
  .object({
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
    includeCleared: z.boolean().optional(),
    messageId: IdentifierSchema.optional(),
  })
  .strict();
export type ForemanChannelQuery = z.infer<typeof ForemanChannelQuerySchema>;

export const SendForemanMessageCommandSchema = z
  .object({
    requestId: IdentifierSchema,
    text: z
      .string()
      .trim()
      .min(1)
      .max(32768)
      .refine(
        (text) => new TextEncoder().encode(text).length <= 32768,
        "Message exceeds 32768 UTF-8 bytes",
      ),
    teamId: IdentifierSchema.optional(),
    replyTo: IdentifierSchema.optional(),
  })
  .strict();
export type SendForemanMessageCommand = z.infer<typeof SendForemanMessageCommandSchema>;

export const ForemanChannelSenderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator"), operatorId: IdentifierSchema }).strict(),
  z
    .object({
      kind: z.literal("foreman"),
      foremanId: IdentifierSchema,
      runId: IdentifierSchema,
      generation: z.number().int().positive(),
      authorityRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type ForemanChannelSender = z.infer<typeof ForemanChannelSenderSchema>;

export const ForemanChannelMessageSchema = z
  .object({
    id: IdentifierSchema,
    sequence: z.number().int().positive(),
    sender: ForemanChannelSenderSchema,
    text: z.string().min(1).max(32768),
    teamId: IdentifierSchema.optional(),
    replyTo: IdentifierSchema.optional(),
    createdAt: TimestampSchema,
    cleared: z.boolean().optional(),
  })
  .strict();
export type ForemanChannelMessage = z.infer<typeof ForemanChannelMessageSchema>;

export const ForemanChannelPageSchema = z
  .object({
    messages: z.array(ForemanChannelMessageSchema).max(100),
    nextAfter: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    clearedThrough: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ForemanChannelPage = z.infer<typeof ForemanChannelPageSchema>;

export const AskForemanMemberCommandSchema = z
  .object({
    requestId: IdentifierSchema,
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    text: z.string().trim().min(1).max(8000),
    replyTo: IdentifierSchema.optional(),
    sourceMessageId: IdentifierSchema.optional(),
    expiresInSeconds: z.number().int().min(30).max(86400).default(3600),
  })
  .strict();
export type AskForemanMemberCommand = z.infer<typeof AskForemanMemberCommandSchema>;
export const ForemanConversationRequestSchema = AskForemanMemberCommandSchema.extend({
  id: IdentifierSchema,
  conversationId: IdentifierSchema,
  foremanId: IdentifierSchema,
  memberProfileId: IdentifierSchema,
  authorityRevision: z.number().int().nonnegative(),
  state: z.enum(["queued", "submitted", "answered", "failed", "expired", "cancelled", "ambiguous"]),
  actionId: IdentifierSchema.optional(),
  runId: IdentifierSchema.optional(),
  generation: z.number().int().positive().optional(),
  response: z.string().trim().min(1).max(8000).optional(),
  responseRequestId: IdentifierSchema.optional(),
  answeredAt: TimestampSchema.optional(),
  problem: z.string().max(500).optional(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict();
export type ForemanConversationRequest = z.infer<typeof ForemanConversationRequestSchema>;
export const ReplyForemanConversationCommandSchema = z
  .object({
    id: IdentifierSchema,
    requestId: IdentifierSchema,
    text: z.string().trim().min(1).max(8000),
  })
  .strict();
export type ReplyForemanConversationCommand = z.infer<typeof ReplyForemanConversationCommandSchema>;
export const ForemanConversationQuerySchema = z
  .object({
    id: IdentifierSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
