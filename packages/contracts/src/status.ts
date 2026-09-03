import { z } from "zod";
import { IdentifierSchema, RoleIdSchema, RunStatusSchema, TimestampSchema } from "./control.js";
import { AgentTypeKeySchema, IntegrationIdSchema } from "./provider.js";
import { AdapterIdSchema } from "./provider-runtime.js";
import { ProviderUpdateTransitionSchema } from "./provider-update-state.js";

export const STATUS_PROTOCOL_VERSION = 2 as const;
export const REPORTER_LEASE_MS = 45_000 as const;
export const AgentStatusStateSchema = z.enum([
  "starting",
  "idle",
  "working",
  "waiting",
  "blocked",
  "suspected_stuck",
  "stopped",
  "failed",
  "unknown",
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
  "turn.waiting",
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
export const ReporterReadinessCoverageSchema = z.enum(["full", "partial", "session_only"]);
export const StatusAuthorityKindSchema = z.enum(["process", "reporter", "screen", "none"]);
export const ProcessStateSchema = z.enum(["present", "dead", "missing", "indeterminate"]);
export const ScreenClassificationSchema = z.enum([
  "blocked",
  "working_hint",
  "idle_hint",
  "unknown",
  "skip",
]);

export type AgentStatusState = z.infer<typeof AgentStatusStateSchema>;
export type AgentStatusPhase = z.infer<typeof AgentStatusPhaseSchema>;
export type AgentStatusOutcome = z.infer<typeof AgentStatusOutcomeSchema>;
export type AgentStatusConfidence = z.infer<typeof AgentStatusConfidenceSchema>;
export type AgentStatusAttention = z.infer<typeof AgentStatusAttentionSchema>;
export type AgentStatusSource = z.infer<typeof AgentStatusSourceSchema>;
export type AgentStatusEventKind = z.infer<typeof AgentStatusEventKindSchema>;
export type AgentWaitKind = z.infer<typeof AgentWaitKindSchema>;
export type AgentReplyChannel = z.infer<typeof AgentReplyChannelSchema>;
export type ReporterReadinessCoverage = z.infer<typeof ReporterReadinessCoverageSchema>;
export type StatusAuthorityKind = z.infer<typeof StatusAuthorityKindSchema>;
export type ProcessState = z.infer<typeof ProcessStateSchema>;

const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

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
    version: z.literal(2),
    eventId: IdentifierSchema,
    providerId: IntegrationIdSchema,
    adapterId: AdapterIdSchema,
    reporterId: IdentifierSchema,
    source: AgentStatusSourceSchema,
    protocolVersion: z.literal(STATUS_PROTOCOL_VERSION),
    reporterVersion: z.string().trim().min(1).max(32),
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    reporterEpoch: IdentifierSchema,
    sourceSequence: z.number().int().positive(),
    nativeSessionId: z.string().trim().min(1).max(4_096).optional(),
    event: AgentStatusEventKindSchema,
    occurredAt: TimestampSchema.optional(),
    actionId: IdentifierSchema.optional(),
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
    source: z.enum(["scheduler", "process", "reporter", "screen", "status_api"]),
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
    state: ProcessStateSchema,
    observedAt: TimestampSchema,
    trigger: z.enum(["poll", "tmux_hook", "write_guard"]),
    process: z
      .object({
        foregroundPgid: z.number().int().positive(),
        leaderPid: z.number().int().positive(),
        pidStartIdentity: z.string().trim().min(1).max(128),
        executableFingerprint: FingerprintSchema,
        argvFingerprint: FingerprintSchema,
        processFingerprint: FingerprintSchema,
        expectedProviderMatch: z.enum(["match", "mismatch", "unknown"]),
        wrapperChain: z.array(z.string().trim().min(1).max(128)).max(64),
      })
      .strict()
      .optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().trim().min(1).max(64).optional(),
    evidenceCode: z.string().trim().min(1).max(128),
  })
  .strict();
export type RuntimeStatusObservation = z.infer<typeof RuntimeObservationSchema>;
export type ProcessIdentityObservation = NonNullable<RuntimeStatusObservation["process"]>;

export const ReporterSessionSchema = z
  .object({
    id: IdentifierSchema,
    providerId: IntegrationIdSchema,
    adapterId: AdapterIdSchema,
    reporterId: IdentifierSchema,
    source: AgentStatusSourceSchema,
    protocolVersion: z.literal(STATUS_PROTOCOL_VERSION),
    reporterVersion: z.string().trim().min(1).max(32),
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    reporterEpoch: IdentifierSchema,
    sourceSequence: z.number().int().nonnegative(),
    nativeSessionId: z.string().trim().min(1).max(4_096).optional(),
    readinessCoverage: ReporterReadinessCoverageSchema,
    processFingerprint: FingerprintSchema.optional(),
    openedAt: TimestampSchema,
    leaseExpiresAt: TimestampSchema,
    revokedAt: TimestampSchema.optional(),
    closedAt: TimestampSchema.optional(),
  })
  .strict();
export type ReporterSession = z.infer<typeof ReporterSessionSchema>;

export const ScreenObservationSchema = z
  .object({
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    paneId: z.string().trim().min(1).max(64),
    observedAt: TimestampSchema,
    captureHash: FingerprintSchema,
    rows: z.number().int().nonnegative().max(80),
    bytes: z.number().int().nonnegative().max(65_536),
    truncated: z.boolean(),
    alternateScreen: z.boolean(),
    manifestId: IdentifierSchema,
    manifestVersion: z.string().trim().min(1).max(32),
    manifestDigest: FingerprintSchema,
    ruleId: IdentifierSchema.optional(),
    classification: ScreenClassificationSchema,
    confidence: z.enum(["medium", "low"]),
    visibleBlocker: z.boolean(),
  })
  .strict();
export type ScreenObservation = z.infer<typeof ScreenObservationSchema>;

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
    providerUpdate: ProviderUpdateTransitionSchema.optional(),
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
    statusRevision: z.number().int().nonnegative(),
    completionRevision: z.number().int().nonnegative(),
    operatorAcknowledgedCompletionRevision: z.number().int().nonnegative(),
    completionPending: z.boolean(),
    interactiveReady: z.boolean(),
    staleAuthority: z.boolean(),
    authorityKind: StatusAuthorityKindSchema,
    authorityId: IdentifierSchema.optional(),
    evidenceConfidence: AgentStatusConfidenceSchema,
    processState: ProcessStateSchema,
    processFingerprint: FingerprintSchema.optional(),
    reporterEpoch: IdentifierSchema.optional(),
    reporterLeaseExpiresAt: TimestampSchema.optional(),
    readinessCoverage: ReporterReadinessCoverageSchema.optional(),
    lastScreenObservation: ScreenObservationSchema.optional(),
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

export const CompletionAcknowledgementSchema = z
  .object({
    operatorId: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    completionRevision: z.number().int().nonnegative(),
    acknowledgedAt: TimestampSchema,
  })
  .strict();
export type CompletionAcknowledgement = z.infer<typeof CompletionAcknowledgementSchema>;
