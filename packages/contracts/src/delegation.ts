import { z } from "zod";
import { ForemanAutonomySchema } from "./config.js";
import { IdentifierSchema, TimestampSchema } from "./control.js";

const TextSchema = z.string().trim().min(1).max(16384);
const ReferenceSchema = z
  .object({ id: IdentifierSchema, expectedRevision: z.number().int().nonnegative() })
  .strict();

export const ProposeForemanGoalCommandSchema = z
  .object({
    requestId: IdentifierSchema,
    title: z.string().trim().min(1).max(160),
    objective: TextSchema,
    constraints: z.array(z.string().trim().min(1).max(2000)).max(32).default([]),
    sourceMessageId: IdentifierSchema.optional(),
    sourceConversationIds: z.array(IdentifierSchema).max(16).optional(),
  })
  .strict();
export type ProposeForemanGoalCommand = z.infer<typeof ProposeForemanGoalCommandSchema>;

export const ForemanGoalSchema = ProposeForemanGoalCommandSchema.extend({
  id: IdentifierSchema,
  foremanId: IdentifierSchema,
  state: z.enum([
    "proposed",
    "running",
    "paused",
    "blocked",
    "awaiting-acceptance",
    "completed",
    "cancelled",
  ]),
  revision: z.number().int().nonnegative(),
  grant: ForemanAutonomySchema,
  turnsUsed: z.number().int().nonnegative(),
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type ForemanGoal = z.infer<typeof ForemanGoalSchema>;

export const ControlForemanGoalCommandSchema = ReferenceSchema.extend({
  action: z.enum(["approve", "pause", "resume", "cancel", "accept"]),
}).strict();

export const DelegateForemanGoalCommandSchema = z
  .object({
    requestId: IdentifierSchema,
    goalId: IdentifierSchema,
    expectedRevision: z.number().int().nonnegative(),
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    expectedMembershipRevision: z.number().int().nonnegative(),
    expectedCheckoutRevision: z.number().int().nonnegative(),
    rationale: z.string().trim().min(1).max(2000),
    brief: TextSchema,
  })
  .strict();
export type DelegateForemanGoalCommand = z.infer<typeof DelegateForemanGoalCommandSchema>;

export const TeamDelegationSchema = DelegateForemanGoalCommandSchema.extend({
  id: IdentifierSchema,
  state: z.enum([
    "proposed",
    "queued",
    "offered",
    "accepted",
    "working",
    "blocked",
    "ready",
    "completed",
    "cancelled",
  ]),
  revision: z.number().int().nonnegative(),
  checkoutId: IdentifierSchema,
  actionId: IdentifierSchema.optional(),
  runId: IdentifierSchema.optional(),
  generation: z.number().int().positive().optional(),
  nextCheckAt: TimestampSchema,
  lastReportAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type TeamDelegation = z.infer<typeof TeamDelegationSchema>;

export const ReportDelegationCommandSchema = z
  .object({
    requestId: IdentifierSchema,
    delegationId: IdentifierSchema,
    kind: z.enum(["accepted", "progress", "blocked", "plan", "review", "ready"]),
    summary: TextSchema,
    evidence: z.array(z.string().trim().min(1).max(2000)).max(32).default([]),
    candidateHead: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .optional(),
    candidatePath: z.string().trim().min(1).max(1024).optional(),
    nextCheckSeconds: z.number().int().min(30).max(86400).default(900),
  })
  .strict();
export type ReportDelegationCommand = z.infer<typeof ReportDelegationCommandSchema>;
export const DelegationReportSchema = ReportDelegationCommandSchema.extend({
  candidateDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  id: IdentifierSchema,
  memberId: IdentifierSchema,
  runId: IdentifierSchema,
  generation: z.number().int().positive(),
  createdAt: TimestampSchema,
}).strict();
export type DelegationReport = z.infer<typeof DelegationReportSchema>;

export const RequestHumanDecisionCommandSchema = z
  .object({
    requestId: IdentifierSchema,
    goalId: IdentifierSchema,
    delegationId: IdentifierSchema.optional(),
    question: TextSchema,
    options: z.array(z.string().trim().min(1).max(1000)).max(12).default([]),
    recommendation: z.string().trim().min(1).max(2000).optional(),
    blocking: z.boolean().default(true),
  })
  .strict();
export type RequestHumanDecisionCommand = z.infer<typeof RequestHumanDecisionCommandSchema>;
export const HumanDecisionSchema = RequestHumanDecisionCommandSchema.extend({
  id: IdentifierSchema,
  kind: z.enum(["question", "delegation"]),
  state: z.enum(["pending", "resolved", "stale"]),
  revision: z.number().int().nonnegative(),
  goalRevision: z.number().int().nonnegative(),
  answer: TextSchema.optional(),
  decidedBy: IdentifierSchema.optional(),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.optional(),
}).strict();
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;
export const ResolveHumanDecisionCommandSchema = ReferenceSchema.extend({
  requestId: IdentifierSchema,
  answer: TextSchema,
}).strict();
export type ResolveHumanDecisionCommand = z.infer<typeof ResolveHumanDecisionCommandSchema>;

export const ForemanNotificationSchema = z
  .object({
    id: IdentifierSchema,
    sequence: z.number().int().positive(),
    goalId: IdentifierSchema.optional(),
    delegationId: IdentifierSchema.optional(),
    decisionId: IdentifierSchema.optional(),
    kind: z.enum(["goal", "decision", "report", "health", "control"]),
    summary: z.string().min(1).max(2000),
    createdAt: TimestampSchema,
  })
  .strict();
export type ForemanNotification = z.infer<typeof ForemanNotificationSchema>;
export const ForemanNotificationQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const ForemanNotificationPageSchema = z
  .object({
    notifications: z.array(ForemanNotificationSchema).max(100),
    nextAfter: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();

export const ForemanGoalWorkspaceSchema = z
  .object({
    goal: ForemanGoalSchema,
    delegations: z.array(TeamDelegationSchema),
    reports: z.array(DelegationReportSchema),
    decisions: z.array(HumanDecisionSchema),
  })
  .strict();
export type ForemanGoalWorkspace = z.infer<typeof ForemanGoalWorkspaceSchema>;
export const ForemanCheckInCommandSchema = z
  .object({
    delegationId: IdentifierSchema,
    requestId: IdentifierSchema,
    expectedRunId: IdentifierSchema,
    expectedGeneration: z.number().int().positive(),
    expectedStatusRevision: z.number().int().nonnegative(),
    text: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ForemanCheckInCommand = z.infer<typeof ForemanCheckInCommandSchema>;

export const ForemanConnectorScopeSchema = z.enum([
  "notifications",
  "conversation",
  "goals",
  "decisions",
  "control",
]);
export const CreateForemanConnectorCommandSchema = z
  .object({
    principalId: IdentifierSchema,
    name: z.string().trim().min(1).max(100),
    scopes: z.array(ForemanConnectorScopeSchema).min(1).max(5),
    expiresInHours: z.number().int().min(1).max(720).default(24),
  })
  .strict();
export const ForemanConnectorSchema = z
  .object({
    id: IdentifierSchema,
    principalId: IdentifierSchema,
    name: z.string(),
    scopes: z.array(ForemanConnectorScopeSchema),
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    revoked: z.boolean(),
  })
  .strict();
export type ForemanConnector = z.infer<typeof ForemanConnectorSchema>;
export const ForemanConnectorCredentialSchema = z
  .object({ connector: ForemanConnectorSchema, token: z.string().min(32) })
  .strict();
