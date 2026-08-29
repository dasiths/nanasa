import { z } from "zod";

export const IdentifierSchema = z.string().trim().min(1).max(128);
export const TimestampSchema = z.string().datetime({ offset: true });
export const EnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(16_384),
);

export const RequestIdSchema = IdentifierSchema;
export const IdempotencyKeySchema = z.string().trim().min(1).max(256);
export const PrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator"), operatorId: IdentifierSchema }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      memberId: IdentifierSchema,
      runId: IdentifierSchema,
      generation: z.number().int().positive(),
    })
    .strict(),
]);
export const ErrorEnvelopeSchema = z
  .object({
    version: z.literal(1),
    requestId: RequestIdSchema,
    error: z
      .object({
        code: z.string().trim().min(1).max(100),
        message: z.string().trim().min(1).max(2_000),
        retryable: z.boolean(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
export const ControlMetadataSchema = z
  .object({
    apiVersion: z.literal(1),
    configVersion: z.literal(2),
    databaseSchemaVersion: z.number().int().positive(),
    instanceId: IdentifierSchema,
    daemonEpoch: z.number().int().nonnegative(),
    limits: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export type Principal = z.infer<typeof PrincipalSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type ControlMetadata = z.infer<typeof ControlMetadataSchema>;

export const RoleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type RoleId = z.infer<typeof RoleIdSchema>;

export const ConfiguredAgentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export type ConfiguredAgentId = z.infer<typeof ConfiguredAgentIdSchema>;

export const GroupSchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().trim().min(1).max(100),
    membershipRevision: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Group = z.infer<typeof GroupSchema>;

export const CreateGroupCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    instructions: z.array(z.string()).max(32).optional(),
  })
  .strict();
export type CreateGroupCommand = z.infer<typeof CreateGroupCommandSchema>;

export const UpdateGroupCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    instructions: z.array(z.string()).max(32).optional(),
  })
  .strict()
  .refine((command) => command.name !== undefined || command.instructions !== undefined, {
    message: "Group update requires at least one field",
  });
export type UpdateGroupCommand = z.infer<typeof UpdateGroupCommandSchema>;

export const DeleteGroupResultSchema = z
  .object({
    groupId: IdentifierSchema,
    deletedMemberships: z.number().int().nonnegative(),
    deletedRuns: z.number().int().nonnegative(),
    deletedMessages: z.number().int().nonnegative(),
    deletedDeliveries: z.number().int().nonnegative(),
  })
  .strict();
export type DeleteGroupResult = z.infer<typeof DeleteGroupResultSchema>;

export const MembershipStateSchema = z.enum(["active", "removed"]);
export const GroupMembershipSchema = z
  .object({
    id: IdentifierSchema,
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    agentProfileId: IdentifierSchema,
    alias: z.string().trim().min(1).max(100),
    roleId: RoleIdSchema.optional(),
    state: MembershipStateSchema,
    joinedAt: TimestampSchema,
    removedAt: TimestampSchema.optional(),
  })
  .strict();
export type GroupMembership = z.infer<typeof GroupMembershipSchema>;

export const RunStatusSchema = z.enum(["starting", "running", "stopping", "stopped", "failed"]);
export const DesiredRunStateSchema = z.enum(["running", "stopped"]);
export const RecoveryPhaseSchema = z.enum([
  "idle",
  "reconciling",
  "resuming",
  "restarting",
  "recovered",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type DesiredRunState = z.infer<typeof DesiredRunStateSchema>;
export type RecoveryPhase = z.infer<typeof RecoveryPhaseSchema>;

export const TerminalBindingSchema = z
  .object({
    serverName: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    windowId: z.string().regex(/^@[0-9]+$/),
    paneId: z.string().regex(/^%[0-9]+$/),
  })
  .strict();
export type TerminalBinding = z.infer<typeof TerminalBindingSchema>;

export const AgentRunSchema = z
  .object({
    id: IdentifierSchema,
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    agentProfileId: IdentifierSchema,
    generation: z.number().int().positive(),
    status: RunStatusSchema,
    desiredState: DesiredRunStateSchema.default("running"),
    recoveryPhase: RecoveryPhaseSchema.default("idle"),
    recoveryAttempts: z.number().int().nonnegative().default(0),
    recoveryNotBefore: TimestampSchema.optional(),
    recoveryReason: z.string().trim().min(1).max(1_000).optional(),
    terminal: TerminalBindingSchema.optional(),
    startedAt: TimestampSchema,
    stoppedAt: TimestampSchema.optional(),
  })
  .strict();
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const CreateGroupAgentCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    integrationId: z.string().trim().min(1).max(64),
    roleId: RoleIdSchema.optional(),
    instructions: z.array(z.string()).max(32).optional(),
  })
  .strict();
export type CreateGroupAgentCommand = z.infer<typeof CreateGroupAgentCommandSchema>;

export const UpdateGroupAgentCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    integrationId: z.string().trim().min(1).max(64).optional(),
    roleId: RoleIdSchema.nullable().optional(),
    instructions: z.array(z.string()).max(32).optional(),
  })
  .strict()
  .refine(
    (command) =>
      command.name !== undefined ||
      command.integrationId !== undefined ||
      command.roleId !== undefined ||
      command.instructions !== undefined,
    { message: "Agent update requires at least one field" },
  );
export type UpdateGroupAgentCommand = z.infer<typeof UpdateGroupAgentCommandSchema>;

export const RemoveGroupAgentResultSchema = z
  .object({
    groupId: IdentifierSchema,
    agentId: ConfiguredAgentIdSchema,
    deletedRuns: z.number().int().nonnegative(),
    revokedDeliveries: z.number().int().nonnegative(),
  })
  .strict();
export type RemoveGroupAgentResult = z.infer<typeof RemoveGroupAgentResultSchema>;

export const ReorderGroupAgentsCommandSchema = z
  .object({
    agentIds: z.array(ConfiguredAgentIdSchema).max(256),
    expectedAgentRevision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((command, context) => {
    const seen = new Set<string>();
    for (const [index, agentId] of command.agentIds.entries()) {
      if (seen.has(agentId)) {
        context.addIssue({
          code: "custom",
          message: "Agent order must not contain duplicate agent IDs",
          path: ["agentIds", index],
        });
      }
      seen.add(agentId);
    }
  });
export type ReorderGroupAgentsCommand = z.infer<typeof ReorderGroupAgentsCommandSchema>;

export const ReorderGroupAgentsResultSchema = z
  .object({
    groupId: IdentifierSchema,
    agentIds: z.array(ConfiguredAgentIdSchema).max(256),
    agentRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ReorderGroupAgentsResult = z.infer<typeof ReorderGroupAgentsResultSchema>;
