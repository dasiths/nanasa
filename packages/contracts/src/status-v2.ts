import { z } from "zod";
import { IdentifierSchema, RunStatusSchema, TimestampSchema } from "./control-v1.js";
import { AgentTypeKeySchema, IntegrationIdSchema } from "./provider-v1.js";
import { RoleIdSchema } from "./control-v1.js";

export const STATUS_PROTOCOL_VERSION = 2 as const;
export const AgentStatusStateSchema = z.enum([
  "not_started",
  "starting",
  "working",
  "waiting",
  "idle",
  "blocked",
  "done",
  "unknown",
  "suspected_stuck",
  "stopped",
  "crashed",
]);
export const AgentStatusPhaseSchema = z.enum([
  "startup",
  "model",
  "tool",
  "retry",
  "compaction",
  "permission",
  "question",
  "plan_approval",
  "settled",
  "exited",
]);
export const AgentStatusOutcomeSchema = z.enum(["unknown", "succeeded", "failed", "cancelled"]);
export const AgentStatusConfidenceSchema = z.enum(["high", "medium", "low"]);
export const AgentStatusAttentionSchema = z.enum([
  "none",
  "input_required",
  "decision_required",
  "reporter_stale",
  "progress_stale",
  "process_failed",
]);
export const AgentStatusSourceSchema = z.enum(["claude-code", "copilot", "pi", "opencode"]);
export const AgentStatusEventKindSchema = z.enum([
  "reporter.ready",
  "session.ready",
  "turn.started",
  "turn.settled",
  "tool.started",
  "tool.finished",
  "tool.failed",
  "wait.opened",
  "wait.closed",
  "compaction.started",
  "compaction.finished",
  "retry.observed",
  "failure.observed",
  "session.ended",
  "heartbeat",
]);
export const AgentWaitKindSchema = z.enum([
  "permission",
  "question",
  "elicitation",
  "plan_approval",
]);
export const AgentReplyChannelSchema = z.enum(["terminal", "hook", "rpc", "acp", "api"]);

export type AgentStatusState = z.infer<typeof AgentStatusStateSchema>;
export type AgentStatusPhase = z.infer<typeof AgentStatusPhaseSchema>;
export type AgentStatusOutcome = z.infer<typeof AgentStatusOutcomeSchema>;
export type AgentStatusConfidence = z.infer<typeof AgentStatusConfidenceSchema>;
export type AgentStatusAttention = z.infer<typeof AgentStatusAttentionSchema>;
export type AgentStatusSource = z.infer<typeof AgentStatusSourceSchema>;
export type AgentStatusEventKind = z.infer<typeof AgentStatusEventKindSchema>;
export type AgentWaitKind = z.infer<typeof AgentWaitKindSchema>;
export type AgentReplyChannel = z.infer<typeof AgentReplyChannelSchema>;

const AgentStatusEventDataSchema = z
  .object({
    tool: z.string().trim().min(1).max(128).optional(),
    waitKind: AgentWaitKindSchema.optional(),
    summary: z.string().trim().min(1).max(512).optional(),
    replyChannel: AgentReplyChannelSchema.optional(),
    errorClass: z.string().trim().min(1).max(128).optional(),
    retryAt: TimestampSchema.optional(),
    activeCount: z.number().int().nonnegative().max(10_000).optional(),
    fatal: z.boolean().optional(),
    nativeSession: z
      .object({
        kind: z.enum(["id", "path"]),
        value: z.string().trim().min(1).max(4_096),
      })
      .strict()
      .optional(),
    effectiveModel: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const AgentStatusEventInputSchema = z
  .object({
    version: z.literal(1),
    eventId: IdentifierSchema,
    source: AgentStatusSourceSchema,
    reporterVersion: z.string().trim().min(1).max(32),
    event: AgentStatusEventKindSchema,
    occurredAt: TimestampSchema.optional(),
    sessionId: IdentifierSchema.optional(),
    turnId: IdentifierSchema.optional(),
    operationId: IdentifierSchema.optional(),
    requestId: IdentifierSchema.optional(),
    data: AgentStatusEventDataSchema.default({}),
  })
  .strict()
  .superRefine((event, context) => {
    if (["tool.started", "tool.finished", "tool.failed"].includes(event.event)) {
      if (event.operationId === undefined) {
        context.addIssue({
          code: "custom",
          message: "Tool events require operationId",
          path: ["operationId"],
        });
      }
    }
    if (["wait.opened", "wait.closed"].includes(event.event) && event.requestId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Wait events require requestId",
        path: ["requestId"],
      });
    }
    if (
      event.event === "wait.opened" &&
      (event.data.waitKind === undefined ||
        event.data.summary === undefined ||
        event.data.replyChannel === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Opening a wait requires waitKind, summary, and replyChannel",
        path: ["data"],
      });
    }
  });
export type AgentStatusEventInput = z.infer<typeof AgentStatusEventInputSchema>;

export const AgentProgressReportCommandSchema = z
  .object({
    stage: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(1_000),
    nextStep: z.string().trim().min(1).max(1_000).optional(),
    blocker: z.string().trim().min(1).max(1_000).optional(),
    outcome: AgentStatusOutcomeSchema.exclude(["unknown", "cancelled"]).optional(),
  })
  .strict();
export type AgentProgressReportCommand = z.infer<typeof AgentProgressReportCommandSchema>;

export const AgentStatusWaitSchema = z
  .object({
    requestId: IdentifierSchema,
    kind: AgentWaitKindSchema,
    summary: z.string().trim().min(1).max(512),
    replyChannel: AgentReplyChannelSchema,
    openedAt: TimestampSchema,
  })
  .strict();
export type AgentStatusWait = z.infer<typeof AgentStatusWaitSchema>;

export const AgentStatusEvidenceSchema = z
  .object({
    source: z.enum(["scheduler", "process", "hook", "rpc", "acp", "sse", "status_api"]),
    kind: z.string().trim().min(1).max(100),
    observedAt: TimestampSchema,
    confidence: AgentStatusConfidenceSchema,
    summary: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type AgentStatusEvidence = z.infer<typeof AgentStatusEvidenceSchema>;

export const AgentStatusTransitionSchema = z
  .object({
    from: AgentStatusStateSchema,
    to: AgentStatusStateSchema,
    phase: AgentStatusPhaseSchema,
    attention: AgentStatusAttentionSchema,
    occurredAt: TimestampSchema,
  })
  .strict();
export type AgentStatusTransition = z.infer<typeof AgentStatusTransitionSchema>;

export const RuntimeObservationSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    state: z.enum(["present", "missing", "indeterminate"]),
    processIdentity: z.string().trim().min(1).max(512).optional(),
    observedAt: TimestampSchema,
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();

export const ReporterSessionSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    provider: IntegrationIdSchema,
    reporter: z.string().trim().min(1).max(64),
    reporterVersion: z.string().trim().min(1).max(32),
    epoch: z.number().int().positive(),
    sourceSequence: z.number().int().nonnegative(),
    nativeSessionId: z.string().trim().min(1).max(4_096).optional(),
    startedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export const AgentStatusSummarySchema = z
  .object({
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    alias: z.string().trim().min(1).max(100),
    agentType: AgentTypeKeySchema,
    roleId: RoleIdSchema.optional(),
    roleName: z.string().trim().min(1).max(100).optional(),
    runId: IdentifierSchema.optional(),
    generation: z.number().int().positive().optional(),
    runStatus: RunStatusSchema.optional(),
    state: AgentStatusStateSchema,
    phase: AgentStatusPhaseSchema,
    outcome: AgentStatusOutcomeSchema,
    confidence: AgentStatusConfidenceSchema,
    attention: AgentStatusAttentionSchema,
    observedAt: TimestampSchema,
    stateChangedAt: TimestampSchema,
    lastActivityAt: TimestampSchema.optional(),
    lastActivityKind: z.string().trim().min(1).max(100).optional(),
    lastProgressSummary: z.string().trim().min(1).max(1_000).optional(),
    progressStage: z.string().trim().min(1).max(100).optional(),
    nextStep: z.string().trim().min(1).max(1_000).optional(),
    blocker: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type AgentStatusSummary = z.infer<typeof AgentStatusSummarySchema>;

export const AgentStatusDetailSchema = AgentStatusSummarySchema.extend({
  semanticLeaseExpiresAt: TimestampSchema.optional(),
  transportLeaseExpiresAt: TimestampSchema.optional(),
  openWait: AgentStatusWaitSchema.optional(),
  processExitCode: z.number().int().optional(),
  processSignal: z.string().trim().min(1).max(64).optional(),
  cleanEndSeen: z.boolean(),
  evidence: z.array(AgentStatusEvidenceSchema).max(20),
  recentTransitions: z.array(AgentStatusTransitionSchema).max(20),
}).strict();
export type AgentStatusDetail = z.infer<typeof AgentStatusDetailSchema>;

export const StatusRevisionSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    reporterSessionId: IdentifierSchema.optional(),
    statusRevision: z.number().int().positive(),
    completionRevision: z.number().int().nonnegative(),
    status: AgentStatusDetailSchema,
    createdAt: TimestampSchema,
  })
  .strict();
