import { z } from "zod";
import { OpenWaitReplySchema } from "./actions.js";
import { ForemanAutonomySchema } from "./config.js";
import { IdentifierSchema, TimestampSchema } from "./control.js";

export const MissionStateSchema = z.enum([
  "planning",
  "running",
  "paused",
  "blocked",
  "verifying",
  "awaiting-acceptance",
  "completed",
  "cancelled",
  "revoked",
  "failed",
]);
export const MissionGrantSchema = ForemanAutonomySchema;
export type MissionGrant = z.infer<typeof MissionGrantSchema>;
export const MissionVerificationRecipeSchema = z
  .object({
    id: IdentifierSchema,
    command: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => !value.includes("\0"), "Command must not contain NUL"),
      )
      .min(1)
      .max(64),
    acceptanceIndexes: z.array(z.number().int().nonnegative()).min(1).max(32),
    timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  })
  .strict();
export type MissionVerificationRecipe = z.infer<typeof MissionVerificationRecipeSchema>;
export const CreateMissionCommandSchema = z
  .object({
    requestId: IdentifierSchema,
    title: z.string().trim().min(1).max(160),
    objective: z.string().trim().min(1).max(16384),
    acceptance: z.array(z.string().trim().min(1).max(2000)).min(1).max(32),
    grant: MissionGrantSchema,
    verification: z.array(MissionVerificationRecipeSchema).max(16).default([]),
  })
  .strict();
export type CreateMissionCommand = z.infer<typeof CreateMissionCommandSchema>;
export const MissionSchema = z
  .object({
    id: IdentifierSchema,
    foremanId: IdentifierSchema,
    operatorId: IdentifierSchema,
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(16384),
    acceptance: z.array(z.string().min(1).max(2000)).min(1).max(32),
    grant: MissionGrantSchema,
    verification: z.array(MissionVerificationRecipeSchema).max(16),
    grantRevision: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    state: MissionStateSchema,
    turnsUsed: z.number().int().nonnegative(),
    recoveryAttempts: z.number().int().nonnegative(),
    nextReviewAt: TimestampSchema,
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Mission = z.infer<typeof MissionSchema>;

export const MissionControlCommandSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    action: z.enum(["start", "pause", "resume", "cancel", "revoke", "accept"]),
  })
  .strict();
export type MissionControlCommand = z.infer<typeof MissionControlCommandSchema>;

export const MissionTaskStateSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "blocked",
  "verifying",
  "accepted",
  "failed",
  "cancelled",
]);
export const CreateMissionTaskCommandSchema = z
  .object({
    requestId: IdentifierSchema,
    expectedGrantRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(160),
    instructions: z.string().trim().min(1).max(16384),
    roleId: IdentifierSchema,
    templateId: IdentifierSchema,
    dependencies: z.array(IdentifierSchema).max(32).default([]),
    acceptanceIndexes: z.array(z.number().int().nonnegative()).min(1).max(32),
  })
  .strict();
export type CreateMissionTaskCommand = z.infer<typeof CreateMissionTaskCommandSchema>;
export const MissionTaskSchema = CreateMissionTaskCommandSchema.omit({
  requestId: true,
  expectedGrantRevision: true,
})
  .extend({
    id: IdentifierSchema,
    missionId: IdentifierSchema,
    actionId: IdentifierSchema.optional(),
    groupId: IdentifierSchema.optional(),
    memberId: IdentifierSchema.optional(),
    runId: IdentifierSchema.optional(),
    generation: z.number().int().positive().optional(),
    state: MissionTaskStateSchema,
    revision: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type MissionTask = z.infer<typeof MissionTaskSchema>;

export const MissionWorkspaceSchema = z.lazy(() =>
  z
    .object({
      mission: MissionSchema,
      tasks: z.array(MissionTaskSchema).max(256),
      teams: z.array(MissionTeamAllocationSchema).max(16).optional(),
      evidence: z.array(MissionEvidenceSchema).max(4096).optional(),
      approvals: z.array(MissionApprovalSchema).max(256).optional(),
    })
    .strict(),
);
export type MissionWorkspace = z.infer<typeof MissionWorkspaceSchema>;

export const ProvisionMissionTeamCommandSchema = z
  .object({
    requestId: IdentifierSchema,
    expectedGrantRevision: z.number().int().positive(),
    expectedConfigRevision: z.string().min(1).max(128),
    templateId: IdentifierSchema,
    sourceCheckoutId: IdentifierSchema,
    baseCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  })
  .strict();
export type ProvisionMissionTeamCommand = z.infer<typeof ProvisionMissionTeamCommandSchema>;
export const MissionTeamAllocationSchema = z
  .object({
    id: IdentifierSchema,
    missionId: IdentifierSchema,
    groupId: IdentifierSchema,
    templateId: IdentifierSchema,
    templateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCheckoutId: IdentifierSchema,
    baseCommit: z.string().min(40).max(64),
    branch: z.string().min(1),
    checkoutId: IdentifierSchema.optional(),
    worktreeId: IdentifierSchema.optional(),
    state: z.enum(["prepared", "creating", "ready", "blocked"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type MissionTeamAllocation = z.infer<typeof MissionTeamAllocationSchema>;

export const VerifyMissionTaskCommandSchema = z
  .object({
    missionId: IdentifierSchema,
    taskId: IdentifierSchema,
    expectedGrantRevision: z.number().int().positive(),
    candidateCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  })
  .strict();
export type VerifyMissionTaskCommand = z.infer<typeof VerifyMissionTaskCommandSchema>;
export const MissionEvidenceSchema = z
  .object({
    id: IdentifierSchema,
    missionId: IdentifierSchema,
    taskId: IdentifierSchema,
    candidateCommit: z.string().min(40).max(64),
    checkoutId: IdentifierSchema,
    recipeId: IdentifierSchema,
    recipeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["running", "passed", "failed", "ambiguous"]),
    outputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    exitCode: z.number().int().optional(),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
  })
  .strict();
export type MissionEvidence = z.infer<typeof MissionEvidenceSchema>;

export const ObserveMissionTaskCommandSchema = z
  .object({
    missionId: IdentifierSchema,
    taskId: IdentifierSchema,
    expectedGrantRevision: z.number().int().positive(),
    maxLines: z.number().int().min(1).max(5000).default(200),
  })
  .strict();
export type ObserveMissionTaskCommand = z.infer<typeof ObserveMissionTaskCommandSchema>;

export const InterveneMissionTaskCommandSchema = z
  .object({
    missionId: IdentifierSchema,
    taskId: IdentifierSchema,
    expectedGrantRevision: z.number().int().positive(),
    requestId: IdentifierSchema,
    observationId: IdentifierSchema,
    prompt: z.string().trim().min(1).max(4000),
  })
  .strict();
export type InterveneMissionTaskCommand = z.infer<typeof InterveneMissionTaskCommandSchema>;

export const ReplyMissionWaitCommandSchema = InterveneMissionTaskCommandSchema.omit({
  prompt: true,
})
  .extend({
    waitId: IdentifierSchema,
    reply: OpenWaitReplySchema,
  })
  .strict();
export type ReplyMissionWaitCommand = z.infer<typeof ReplyMissionWaitCommandSchema>;

export const MissionApprovalSchema = z
  .object({
    id: IdentifierSchema,
    missionId: IdentifierSchema,
    grantRevision: z.number().int().positive(),
    operation: z.enum(["provision", "task", "verification", "intervention"]),
    operationKey: z.string().min(1).max(512),
    summary: z.string().max(2000),
    state: z.enum(["pending", "approved", "denied", "stale"]),
    createdAt: TimestampSchema,
    decidedAt: TimestampSchema.optional(),
  })
  .strict();
export type MissionApproval = z.infer<typeof MissionApprovalSchema>;
export const DecideMissionApprovalCommandSchema = z
  .object({
    expectedGrantRevision: z.number().int().positive(),
    decision: z.enum(["approved", "denied"]),
  })
  .strict();
export type DecideMissionApprovalCommand = z.infer<typeof DecideMissionApprovalCommandSchema>;
