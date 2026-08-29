import { z } from "zod";
import { IdentifierSchema, TerminalBindingSchema, TimestampSchema } from "./control-v1.js";

export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const TerminalRoleSchema = z.enum(["owner", "controller", "observer"]);
export const TerminalLeaseSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    viewerId: IdentifierSchema,
    role: TerminalRoleSchema,
    acquiredAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export const TerminalLimitsSchema = z
  .object({
    maxInputBytes: z.number().int().positive(),
    maxPasteBytes: z.number().int().positive(),
    maxOutputQueueBytes: z.number().int().positive(),
    maxViewers: z.number().int().positive(),
    maxReadLines: z.number().int().positive(),
    maxReadBytes: z.number().int().positive(),
  })
  .strict();

export const TerminalClientFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("input"),
      sequence: z.number().int().nonnegative(),
      data: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resize"),
      cols: z.number().int().min(20).max(1_000),
      rows: z.number().int().min(5).max(1_000),
    })
    .strict(),
  z.object({ type: z.literal("takeover"), expectedLeaseId: IdentifierSchema.optional() }).strict(),
  z.object({ type: z.literal("ack"), sequence: z.number().int().nonnegative() }).strict(),
]);
export const TerminalServerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("welcome"),
      version: z.literal(1),
      role: TerminalRoleSchema,
      lease: TerminalLeaseSchema.optional(),
      limits: TerminalLimitsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("output"),
      sequence: z.number().int().nonnegative(),
      data: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reset"),
      reason: z.enum(["history_lost", "binding_changed", "server_restart"]),
    })
    .strict(),
  z
    .object({ type: z.literal("slow_consumer"), retryAfterMs: z.number().int().positive() })
    .strict(),
  z
    .object({
      type: z.literal("effect"),
      effectId: IdentifierSchema,
      kind: z.enum(["clipboard-write", "notification"]),
      expiresAt: TimestampSchema,
    })
    .strict(),
]);

export const TerminalReadRequestSchema = z
  .object({
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    startLine: z.number().int().nonnegative().optional(),
    maxLines: z.number().int().min(1).max(5_000).default(200),
    maxBytes: z.number().int().min(1).max(1_048_576).default(65_536),
  })
  .strict();
export const TerminalReadResultSchema = z
  .object({
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    binding: TerminalBindingSchema,
    text: z.string(),
    firstLine: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
    byteCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    capturedAt: TimestampSchema,
  })
  .strict();

export const TerminalCheckpointPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    access: z.literal("owner-only"),
    sensitivity: z.enum(["repository-private", "encrypted"]),
  })
  .strict();
export const TerminalCheckpointSchema = z
  .object({
    id: IdentifierSchema,
    ownerPrincipalId: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    terminalBinding: TerminalBindingSchema,
    capturedAt: TimestampSchema,
    lineCount: z.number().int().nonnegative(),
    byteCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    sensitivity: z.enum(["repository-private", "encrypted"]),
    storageReference: z.string().trim().min(1).max(4_096),
    expiresAt: TimestampSchema,
    deletedAt: TimestampSchema.optional(),
    deletionAuditId: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if ((checkpoint.deletedAt === undefined) !== (checkpoint.deletionAuditId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Checkpoint deletion time and audit ID must be recorded together",
        path: ["deletedAt"],
      });
    }
  });
export type TerminalCheckpoint = z.infer<typeof TerminalCheckpointSchema>;

export const TerminalEndpointStateSchema = z.enum([
  "starting",
  "ready",
  "backoff",
  "unavailable",
  "stopped",
]);
export type TerminalEndpointState = z.infer<typeof TerminalEndpointStateSchema>;
const TerminalEndpointMetadata = {
  retryAfterMs: z.number().int().positive().optional(),
  error: z
    .object({ code: z.string().trim().min(1), message: z.string().trim().min(1) })
    .strict()
    .optional(),
};
const TerminalEndpointUnavailableSchema = z
  .object({
    runId: IdentifierSchema,
    provider: z.literal("ttyd"),
    state: TerminalEndpointStateSchema.exclude(["ready"]),
    url: z.never().optional(),
    ...TerminalEndpointMetadata,
  })
  .strict();
const TerminalEndpointReadySchema = z
  .object({
    runId: IdentifierSchema,
    provider: z.literal("ttyd"),
    state: z.literal("ready"),
    url: z.string().regex(/^\/terminals\/[0-9a-f]{32}\/$/),
    ...TerminalEndpointMetadata,
  })
  .strict();
export const TerminalEndpointStatusSchema = z.discriminatedUnion("state", [
  TerminalEndpointUnavailableSchema,
  TerminalEndpointReadySchema,
]);
export type TerminalEndpointStatus = z.infer<typeof TerminalEndpointStatusSchema>;
export const AdHocConsoleSessionSchema = z
  .object({ id: IdentifierSchema, runId: IdentifierSchema })
  .strict();
export type AdHocConsoleSession = z.infer<typeof AdHocConsoleSessionSchema>;
