import { z } from "zod";
import {
  OperationIdSchema,
  ProviderAuthorityFenceSchema,
  ReporterSourceIdSchema,
  SnapshotDigestSchema,
} from "./provider-runtime-v2.js";

export const AgentActionStateV2Schema = z.enum([
  "created",
  "deferred",
  "submitting",
  "submitted",
  "accepted",
  "started",
  "blocked",
  "completed",
  "settled-unverified",
  "failed",
  "stalled",
  "timed-out",
  "cancelled",
  "expired",
  "superseded",
  "rejected",
]);
export const ProviderTransportIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/);
export const ActionAuthorityTargetV2Schema = ProviderAuthorityFenceSchema.extend({
  daemonEpoch: z.number().int().positive(),
  reporterSessionId: z.string().min(1).max(128).optional(),
  reporterId: z.string().min(1).max(128).optional(),
  reporterSourceId: ReporterSourceIdSchema.optional(),
  reporterEpoch: z.string().min(1).max(128).optional(),
  nativeSessionId: z.string().min(1).max(128).optional(),
  baselineStatusRevision: z.number().int().nonnegative(),
  baselineCompletionRevision: z.number().int().nonnegative(),
  operationId: OperationIdSchema,
  transportId: ProviderTransportIdSchema,
}).strict();

export const AgentActionV2Schema = z
  .object({
    version: z.literal(2),
    id: z.string().min(1).max(128),
    kind: z.enum(["prompt", "wait-reply", "interrupt", "cancel"]),
    principalId: z.string().min(1).max(128),
    groupId: z.string().min(1).max(128),
    memberId: z.string().min(1).max(128),
    target: ActionAuthorityTargetV2Schema,
    idempotencyKey: z.string().min(1).max(256),
    requestDigest: SnapshotDigestSchema,
    input: z
      .object({
        prompt: z.string().min(1).max(1_048_576).optional(),
        waitId: z.string().min(1).max(128).optional(),
        reason: z.string().min(1).max(500).optional(),
      })
      .strict(),
    state: AgentActionStateV2Schema,
    queueDeadlineAt: z.string().datetime({ offset: true }),
    acceptanceDeadlineAt: z.string().datetime({ offset: true }).optional(),
    completionDeadlineAt: z.string().datetime({ offset: true }).optional(),
    providerTurnId: z.string().min(1).max(128).optional(),
    providerRequestId: z.string().min(1).max(128).optional(),
    resultDigest: SnapshotDigestSchema.optional(),
    safeErrorCode: z.string().min(1).max(100).optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.kind === "prompt" && action.input.prompt === undefined) {
      context.addIssue({
        code: "custom",
        message: "Prompt actions require prompt input",
        path: ["input", "prompt"],
      });
    }
    if (action.kind === "wait-reply" && action.input.waitId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Wait replies require an exact wait ID",
        path: ["input", "waitId"],
      });
    }
  });

export const AgentActionAttemptV2Schema = z
  .object({
    id: z.string().min(1).max(128),
    actionId: z.string().min(1).max(128),
    attempt: z.number().int().positive(),
    target: ActionAuthorityTargetV2Schema,
    state: z.enum([
      "submitting",
      "submitted",
      "failed",
      "stalled",
      "cancelled",
      "superseded",
      "rejected",
    ]),
    leaseOwner: z.string().min(1).max(128),
    leaseExpiresAt: z.string().datetime({ offset: true }),
    inputDigest: SnapshotDigestSchema,
    terminalBindingDigest: SnapshotDigestSchema.optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    submittedAt: z.string().datetime({ offset: true }).optional(),
    safeFailureCode: z.string().min(1).max(100).optional(),
  })
  .strict();

export const AgentActionAcknowledgementV2Schema = z
  .object({
    id: z.string().min(1).max(128),
    actionId: z.string().min(1).max(128),
    attemptId: z.string().min(1).max(128),
    target: ActionAuthorityTargetV2Schema,
    kind: z.enum([
      "accepted",
      "started",
      "blocked",
      "completed",
      "settled-unverified",
      "failed",
      "cancelled",
    ]),
    sourceSequence: z.number().int().positive(),
    completionRevision: z.number().int().nonnegative(),
    providerTurnId: z.string().min(1).max(128).optional(),
    providerRequestId: z.string().min(1).max(128).optional(),
    dataDigest: SnapshotDigestSchema,
    acknowledgedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const OpenWaitV2Schema = z
  .object({
    id: z.string().min(1).max(128),
    actionId: z.string().min(1).max(128).optional(),
    groupId: z.string().min(1).max(128),
    memberId: z.string().min(1).max(128),
    target: ActionAuthorityTargetV2Schema,
    providerRequestId: z.string().min(1).max(128),
    kind: z.enum(["permission", "question", "elicitation", "plan-approval"]),
    summary: z.string().min(1).max(512),
    replyOperationId: OperationIdSchema,
    transportId: ProviderTransportIdSchema,
    openedStatusRevision: z.number().int().nonnegative(),
    state: z.enum(["open", "replying", "answered", "superseded"]),
    openedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    answeredAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((wait, context) => {
    if (
      wait.replyOperationId !== wait.target.operationId ||
      wait.transportId !== wait.target.transportId
    ) {
      context.addIssue({
        code: "custom",
        message: "Wait reply operation must match the authority target",
        path: ["replyOperationId"],
      });
    }
  });

export const ReplyOpenWaitV2CommandSchema = z
  .object({
    waitId: z.string().min(1).max(128),
    expectedRunId: z.string().min(1).max(128),
    expectedGeneration: z.number().int().positive(),
    expectedSnapshotDigest: SnapshotDigestSchema,
    expectedProcessIncarnationDigest: SnapshotDigestSchema,
    expectedReporterEpoch: z.string().min(1).max(128),
    expectedStatusRevision: z.number().int().nonnegative(),
    reply: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("answer"), text: z.string().min(1).max(8_192) }).strict(),
      z.object({ kind: z.literal("allow-once") }).strict(),
      z.object({ kind: z.literal("deny") }).strict(),
      z.object({ kind: z.literal("approve-plan") }).strict(),
      z.object({ kind: z.literal("reject-plan") }).strict(),
      z.object({ kind: z.literal("select"), option: z.string().min(1).max(256) }).strict(),
    ]),
  })
  .strict();
