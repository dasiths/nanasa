import { z } from "zod";
import { IdentifierSchema, TerminalBindingSchema, TimestampSchema } from "./control-v1.js";

export const TERMINAL_PROTOCOL = "nanasa-terminal.v1" as const;
export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const TerminalRoleSchema = z.enum(["controller", "observer"]);
export type TerminalRole = z.infer<typeof TerminalRoleSchema>;
export const TerminalLeaseSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    viewerId: IdentifierSchema,
    role: z.literal("controller"),
    runGeneration: z.number().int().positive(),
    streamGeneration: z.number().int().positive(),
    acquiredAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();
export type TerminalLease = z.infer<typeof TerminalLeaseSchema>;

export const TerminalLimitsSchema = z
  .object({
    maxFrameBytes: z.number().int().positive(),
    maxInputBytes: z.number().int().positive(),
    maxPasteBytes: z.number().int().positive(),
    maxOutputQueueBytes: z.number().int().positive(),
    maxViewers: z.number().int().positive(),
    maxObservers: z.number().int().nonnegative(),
    maxReadLines: z.number().int().positive(),
    maxReadBytes: z.number().int().positive(),
    heartbeatMs: z.number().int().positive(),
    leaseMs: z.number().int().positive(),
    reconnectHistoryFrames: z.number().int().nonnegative(),
  })
  .strict();
export type TerminalLimits = z.infer<typeof TerminalLimitsSchema>;

export const TerminalClientFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      version: z.literal(1),
      runId: IdentifierSchema,
      runGeneration: z.number().int().positive(),
      viewerId: IdentifierSchema,
      requestedRole: TerminalRoleSchema,
      takeover: z.boolean().default(false),
      cols: z.number().int().min(20).max(1_000),
      rows: z.number().int().min(5).max(1_000),
    })
    .strict(),
  z.object({ type: z.literal("heartbeat"), leaseId: IdentifierSchema.optional() }).strict(),
  z
    .object({
      type: z.literal("input"),
      leaseId: IdentifierSchema,
      sequence: z.number().int().nonnegative(),
      data: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("paste"), leaseId: IdentifierSchema, data: z.string() }).strict(),
  z.object({ type: z.literal("focus"), leaseId: IdentifierSchema, focused: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("resize"),
      leaseId: IdentifierSchema,
      cols: z.number().int().min(20).max(1_000),
      rows: z.number().int().min(5).max(1_000),
    })
    .strict(),
  z.object({ type: z.literal("takeover"), expectedLeaseId: IdentifierSchema.optional() }).strict(),
  z.object({ type: z.literal("release"), leaseId: IdentifierSchema }).strict(),
  z.object({ type: z.literal("ack"), sequence: z.number().int().nonnegative() }).strict(),
]);
export type TerminalClientFrame = z.infer<typeof TerminalClientFrameSchema>;

const TerminalCapabilitiesSchema = z
  .object({
    input: z.boolean(),
    paste: z.boolean(),
    focus: z.boolean(),
    resize: z.boolean(),
    effects: z.boolean(),
    read: z.literal(true),
    checkpoints: z.boolean(),
  })
  .strict();
export const TerminalServerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("welcome"),
      version: z.literal(1),
      daemonEpoch: z.number().int().positive(),
      streamId: IdentifierSchema,
      streamGeneration: z.number().int().positive(),
      runId: IdentifierSchema,
      runGeneration: z.number().int().positive(),
      binding: TerminalBindingSchema,
      role: TerminalRoleSchema,
      lease: TerminalLeaseSchema.optional(),
      limits: TerminalLimitsSchema,
      capabilities: TerminalCapabilitiesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("baseline"),
      sequence: z.number().int().nonnegative(),
      data: z.string(),
      truncated: z.boolean(),
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
      type: z.literal("lease"),
      role: TerminalRoleSchema,
      lease: TerminalLeaseSchema.optional(),
      reason: z.enum(["acquired", "taken-over", "released", "expired"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("reset"),
      reason: z.enum(["history_lost", "binding_changed", "server_restart", "slow_consumer"]),
    })
    .strict(),
  z
    .object({ type: z.literal("slow_consumer"), retryAfterMs: z.number().int().positive() })
    .strict(),
  z
    .object({
      type: z.literal("effect"),
      effectId: IdentifierSchema,
      kind: z.literal("clipboard-write"),
      byteCount: z.number().int().positive().max(196_608),
      preview: z.string().max(160),
      data: z.string(),
      expiresAt: TimestampSchema,
    })
    .strict(),
]);
export type TerminalServerFrame = z.infer<typeof TerminalServerFrameSchema>;

export const TerminalReadSourceSchema = z.enum(["visible", "history", "alternate"]);

export const TerminalReadRequestSchema = z
  .object({
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    source: TerminalReadSourceSchema.default("history"),
    maxLines: z.number().int().min(1).max(5_000).default(200),
    maxBytes: z.number().int().min(1).max(1_048_576).default(65_536),
  })
  .strict();
export const TerminalReadResultSchema = z
  .object({
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    binding: TerminalBindingSchema,
    source: TerminalReadSourceSchema,
    text: z.string(),
    lineCount: z.number().int().nonnegative(),
    byteCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    alternateScreen: z.boolean(),
    capturedAt: TimestampSchema,
  })
  .strict();
export type TerminalReadRequest = z.infer<typeof TerminalReadRequestSchema>;
export type TerminalReadResult = z.infer<typeof TerminalReadResultSchema>;

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
export const TerminalCheckpointCaptureSchema = z
  .object({
    generation: z.number().int().positive(),
    source: TerminalReadSourceSchema.default("history"),
  })
  .strict();
export type TerminalCheckpointCapture = z.input<typeof TerminalCheckpointCaptureSchema>;
export const TerminalCheckpointContentSchema = z
  .object({ checkpoint: TerminalCheckpointSchema, text: z.string() })
  .strict();

export const ArtifactPreviewSchema = z
  .object({
    path: z.string().trim().min(1).max(4_096),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "text/plain"]),
    byteCount: z.number().int().nonnegative(),
    url: z.string(),
  })
  .strict();

export const TerminalEndpointStateSchema = z.enum(["starting", "ready", "unavailable", "stopped"]);
export type TerminalEndpointState = z.infer<typeof TerminalEndpointStateSchema>;
const TerminalEndpointMetadata = {
  error: z
    .object({ code: z.string().trim().min(1), message: z.string().trim().min(1) })
    .strict()
    .optional(),
};
const TerminalEndpointUnavailableSchema = z
  .object({
    runId: IdentifierSchema,
    provider: z.literal("nanasa-terminal.v1"),
    state: TerminalEndpointStateSchema.exclude(["ready"]),
    ...TerminalEndpointMetadata,
  })
  .strict();
const TerminalEndpointReadySchema = z
  .object({
    runId: IdentifierSchema,
    provider: z.literal("nanasa-terminal.v1"),
    state: z.literal("ready"),
    streamUrl: z.string().regex(/^\/api\/v1\/terminal-stream\/[A-Za-z0-9_.~-]+$/),
    protocol: z.literal("nanasa-terminal.v1"),
    limits: TerminalLimitsSchema,
    controllerViewerId: IdentifierSchema.optional(),
    observers: z.number().int().nonnegative(),
    ...TerminalEndpointMetadata,
  })
  .strict();
export const TerminalEndpointStatusSchema = z.discriminatedUnion("state", [
  TerminalEndpointUnavailableSchema,
  TerminalEndpointReadySchema,
]);
export type TerminalEndpointStatus = z.infer<typeof TerminalEndpointStatusSchema>;
export const AdHocConsoleSessionSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
  })
  .strict();
export type AdHocConsoleSession = z.infer<typeof AdHocConsoleSessionSchema>;
