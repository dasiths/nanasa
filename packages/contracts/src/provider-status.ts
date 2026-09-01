import { z } from "zod";
import {
  AdapterIdSchema,
  ProviderIntegrationIdSchema,
  ProcessIncarnationDigestSchema,
  ProviderAuthorityFenceSchema,
  ProviderIdSchema,
  ReporterSourceIdSchema,
  SnapshotDigestSchema,
  StatusPolicyDigestSchema,
} from "./provider-runtime.js";

export const PROVIDER_STATUS_PROTOCOL_VERSION = 3 as const;
export const ProviderStatusSemanticStateSchema = z.enum([
  "starting",
  "idle",
  "working",
  "waiting",
  "blocked",
  "suspected-stuck",
  "stopped",
  "failed",
  "unknown",
]);
export const ProviderStatusProjectionSchema = z.enum([
  "starting",
  "running",
  "idle",
  "working",
  "waiting",
  "blocked",
  "suspected-stuck",
  "stopped",
  "failed",
  "unknown",
]);
export const ProviderStatusPhaseSchema = z.enum([
  "startup",
  "model",
  "tool",
  "retry",
  "compaction",
  "permission",
  "question",
  "plan-approval",
  "settled",
  "exited",
]);
export const ProviderStatusOutcomeSchema = z.enum(["unknown", "succeeded", "failed", "cancelled"]);
export const ProviderStatusConfidenceSchema = z.enum(["high", "medium", "low"]);
export const ProviderStatusClaimSourceSchema = z.enum([
  "process",
  "reporter",
  "status-api",
  "screen",
  "osc",
]);
export const ProviderStatusClaimTypeSchema = z.enum([
  "process-liveness",
  "semantic-state",
  "phase",
  "outcome",
  "exact-wait",
  "fatal-failure",
  "observer-health",
]);

export const ProviderStatusClaimSchema = z
  .object({
    id: z.string().min(1).max(128),
    fence: ProviderAuthorityFenceSchema,
    policyDigest: StatusPolicyDigestSchema,
    source: ProviderStatusClaimSourceSchema,
    sourceId: z.string().min(1).max(128),
    sourceSessionId: z.string().min(1).max(128).optional(),
    sourceManifestDigest: SnapshotDigestSchema.optional(),
    claimType: ProviderStatusClaimTypeSchema,
    semanticState: ProviderStatusSemanticStateSchema.optional(),
    phase: ProviderStatusPhaseSchema.optional(),
    outcome: ProviderStatusOutcomeSchema.optional(),
    processState: z.enum(["present", "dead", "missing", "indeterminate"]).optional(),
    waitRequestId: z.string().min(1).max(128).optional(),
    confidence: ProviderStatusConfidenceSchema,
    reasonCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    sourceSequence: z.number().int().nonnegative(),
    sourceOccurredAt: z.string().datetime({ offset: true }).optional(),
    receivedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((claim, context) => {
    const requiredField = {
      "process-liveness": "processState",
      "semantic-state": "semanticState",
      phase: "phase",
      outcome: "outcome",
      "exact-wait": "waitRequestId",
      "fatal-failure": "semanticState",
      "observer-health": undefined,
    } as const;
    const field = requiredField[claim.claimType];
    if (field !== undefined && claim[field] === undefined) {
      context.addIssue({
        code: "custom",
        message: `${claim.claimType} requires ${field}`,
        path: [field],
      });
    }
    if (claim.source === "screen" || claim.source === "osc") {
      if (claim.confidence === "high") {
        context.addIssue({
          code: "custom",
          message: "Screen and OSC claims cannot be high confidence",
          path: ["confidence"],
        });
      }
      if (["outcome", "exact-wait", "fatal-failure"].includes(claim.claimType)) {
        context.addIssue({
          code: "custom",
          message: "Screen and OSC cannot claim outcomes, waits, or fatal failures",
          path: ["claimType"],
        });
      }
    }
    if (claim.source === "process" && claim.claimType !== "process-liveness") {
      context.addIssue({
        code: "custom",
        message: "Process sources can claim liveness only",
        path: ["claimType"],
      });
    }
  });
export type ProviderStatusClaim = z.infer<typeof ProviderStatusClaimSchema>;

export const ProviderReporterEventKindSchema = z.enum([
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
export const ProviderReporterEventSchema = z
  .object({
    version: z.literal(PROVIDER_STATUS_PROTOCOL_VERSION),
    eventId: z.string().min(1).max(128),
    integrationId: ProviderIntegrationIdSchema,
    providerId: ProviderIdSchema,
    adapterId: AdapterIdSchema,
    snapshotDigest: SnapshotDigestSchema,
    processIncarnationDigest: ProcessIncarnationDigestSchema,
    reporterSessionId: z.string().min(1).max(128),
    reporterId: z.string().min(1).max(128),
    source: ReporterSourceIdSchema,
    reporterEpoch: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    generation: z.number().int().positive(),
    sourceSequence: z.number().int().positive(),
    event: ProviderReporterEventKindSchema,
    occurredAt: z.string().datetime({ offset: true }).optional(),
    rootSessionId: z.string().min(1).max(128).optional(),
    turnId: z.string().min(1).max(128).optional(),
    operationId: z.string().min(1).max(128).optional(),
    requestId: z.string().min(1).max(128).optional(),
    data: z
      .object({
        waitKind: z.enum(["permission", "question", "elicitation", "plan-approval"]).optional(),
        summary: z.string().min(1).max(512).optional(),
        transportId: z.string().min(1).max(128).optional(),
        errorClass: z.string().min(1).max(128).optional(),
        fatal: z.boolean().optional(),
        effectiveModel: z.string().min(1).max(256).optional(),
        nativeSessionHandle: z.string().min(1).max(128).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.event.startsWith("tool.") && event.operationId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Tool events require operationId",
        path: ["operationId"],
      });
    }
    if (event.event.startsWith("wait.") && event.requestId === undefined) {
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
        event.data.transportId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "wait.opened requires kind, summary, and transport",
        path: ["data"],
      });
    }
  });
export type ProviderReporterEvent = z.infer<typeof ProviderReporterEventSchema>;

export const ProviderReporterSessionSchema = z
  .object({
    id: z.string().min(1).max(128),
    fence: ProviderAuthorityFenceSchema,
    integrationId: ProviderIntegrationIdSchema,
    adapterId: AdapterIdSchema,
    reporterId: z.string().min(1).max(128),
    sourceId: ReporterSourceIdSchema,
    capabilityVersion: z
      .object({ major: z.literal(2), minor: z.number().int().nonnegative() })
      .strict(),
    reporterEpoch: z.string().min(1).max(128),
    rootNativeSessionId: z.string().min(1).max(128).optional(),
    exactEvents: z.array(ProviderReporterEventKindSchema).min(1).max(128),
    sourceSequence: z.number().int().nonnegative(),
    openedAt: z.string().datetime({ offset: true }),
    transportLeaseExpiresAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).optional(),
    closedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ProviderReporterTurnCycleSchema = z
  .object({
    id: z.string().min(1).max(128),
    fence: ProviderAuthorityFenceSchema,
    reporterSessionId: z.string().min(1).max(128),
    rootSessionId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128),
    state: z.enum(["open", "waiting", "settling", "closed", "abandoned"]),
    openToolCount: z.number().int().nonnegative().max(10_000),
    openWaitCount: z.number().int().nonnegative().max(10_000),
    completionRevision: z.number().int().nonnegative(),
    openedAt: z.string().datetime({ offset: true }),
    settledAt: z.string().datetime({ offset: true }).optional(),
    closedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type ProviderReporterTurnCycle = z.infer<typeof ProviderReporterTurnCycleSchema>;

export const EffectiveProviderStatusSchema = z
  .object({
    runId: z.string().min(1).max(128),
    generation: z.number().int().positive(),
    providerId: ProviderIdSchema,
    snapshotDigest: SnapshotDigestSchema,
    processIncarnationDigest: ProcessIncarnationDigestSchema.optional(),
    policyDigest: StatusPolicyDigestSchema,
    projection: ProviderStatusProjectionSchema,
    semanticState: ProviderStatusSemanticStateSchema,
    phase: ProviderStatusPhaseSchema,
    outcome: ProviderStatusOutcomeSchema,
    confidence: ProviderStatusConfidenceSchema,
    winningClaimId: z.string().min(1).max(128).optional(),
    activeClaimIds: z.array(z.string().min(1).max(128)).max(64),
    statusRevision: z.number().int().nonnegative(),
    completionRevision: z.number().int().nonnegative(),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((status, context) => {
    if (status.projection === "running" && status.semanticState !== "unknown") {
      context.addIssue({
        code: "custom",
        message: "Running is only a projection over unknown semantics",
        path: ["projection"],
      });
    }
  });
export type EffectiveProviderStatus = z.infer<typeof EffectiveProviderStatusSchema>;
