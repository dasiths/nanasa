import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(128);
const TimestampSchema = z.string().datetime({ offset: true });

export const MAX_MESSAGE_TEXT_BYTES = 1_048_576;
export const MAX_MESSAGE_REQUEST_BYTES = 6_356_992;
export const DEFAULT_MESSAGE_PAGE_SIZE = 20;
export const MAX_MESSAGE_PAGE_SIZE = 100;
export const DEFAULT_MESSAGE_RETENTION_PER_GROUP = 1_000;

export const OVERSIZED_MESSAGE_GUIDANCE =
  "Save large content in a file inside the repository checkout shared by the recipients, then send its repository-relative path. Do not send an absolute path or a path outside the repository.";

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

export const GroupSchema = z.object({
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(100),
  membershipRevision: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type Group = z.infer<typeof GroupSchema>;

export const AgentKindSchema = z.enum(["copilot", "pi", "opencode", "claude-code"]);

export type AgentKind = z.infer<typeof AgentKindSchema>;

export const IntegrationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export type IntegrationId = z.infer<typeof IntegrationIdSchema>;

export const AgentTypeKeySchema = IntegrationIdSchema;

export const AdapterKindSchema = z.enum(["copilot-cli", "pi-rpc", "terminal"]);
export const RecoveryPolicySchema = z.enum(["resume-or-restart", "restart"]);
export const AgentCapabilitySchema = z.enum(["queue", "steer"]);

export type AdapterKind = z.infer<typeof AdapterKindSchema>;
export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const AgentConfigHomeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("integration") }).strict(),
  z.object({ scope: z.literal("agent") }).strict(),
  z
    .object({
      scope: z.literal("custom"),
      path: z.string().trim().min(1).max(4_096),
    })
    .strict(),
]);

export type AgentConfigHome = z.infer<typeof AgentConfigHomeSchema>;

const EnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(16_384),
);

const IntegrationConfigInputSchema = z
  .object({
    id: IntegrationIdSchema,
    name: z.string().trim().min(1).max(100),
    kind: AgentKindSchema,
    adapter: AdapterKindSchema.optional(),
    command: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    cwd: z.string().min(1).max(4_096).optional(),
    agentConfigHome: AgentConfigHomeSchema.default({ scope: "integration" }),
    environment: EnvironmentSchema.default({}),
    recovery: RecoveryPolicySchema.optional(),
    capabilities: z.array(AgentCapabilitySchema).min(1).max(2).optional(),
  })
  .strict()
  .superRefine((integration, context) => {
    if (
      integration.capabilities !== undefined &&
      new Set(integration.capabilities).size !== integration.capabilities.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Agent capabilities must be unique",
        path: ["capabilities"],
      });
    }
    if (
      integration.adapter === "terminal" &&
      integration.capabilities?.includes("steer") === true
    ) {
      context.addIssue({
        code: "custom",
        message: "Terminal adapters support queue delivery only",
        path: ["capabilities"],
      });
    }
    if (
      integration.adapter === "copilot-cli" &&
      integration.capabilities?.includes("steer") === true
    ) {
      context.addIssue({
        code: "custom",
        message: "Copilot CLI ACP supports queue delivery only",
        path: ["capabilities"],
      });
    }
    if (integration.adapter === "terminal" && integration.recovery !== "restart") {
      context.addIssue({
        code: "custom",
        message: "Terminal adapters must use restart recovery",
        path: ["recovery"],
      });
    }
  })
  .transform((config) => ({
    id: config.id,
    name: config.name,
    kind: config.kind,
    command: config.command,
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    agentConfigHome: config.agentConfigHome,
    environment: config.environment,
  }));

type CanonicalIntegrationConfig = z.output<typeof IntegrationConfigInputSchema>;

export type IntegrationConfig = CanonicalIntegrationConfig;

export const IntegrationConfigSchema = IntegrationConfigInputSchema;

export const RoleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export type RoleId = z.infer<typeof RoleIdSchema>;

export const InstructionPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.startsWith("/") &&
      !/^[A-Za-z]:\//.test(path) &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment !== "..") &&
      path.toLowerCase().endsWith(".md"),
    "Instruction path must be a repository-relative Markdown (.md) path without traversal",
  );

export type InstructionPath = z.infer<typeof InstructionPathSchema>;

export const CreateGroupCommandSchema = z.object({
  name: z.string().trim().min(1).max(100),
  instructions: z.array(InstructionPathSchema).max(32).optional(),
});

export type CreateGroupCommand = z.infer<typeof CreateGroupCommandSchema>;

export const UpdateGroupCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    instructions: z.array(InstructionPathSchema).max(32).optional(),
  })
  .strict()
  .refine((command) => command.name !== undefined || command.instructions !== undefined, {
    message: "Group update requires at least one field",
  });

export type UpdateGroupCommand = z.infer<typeof UpdateGroupCommandSchema>;

export const RolePermissionPolicySchema = z.enum(["inherit", "read-only"]);

export type RolePermissionPolicy = z.infer<typeof RolePermissionPolicySchema>;

export const RolePresentationIconSchema = z.enum([
  "briefcase-business",
  "clipboard-list",
  "code",
  "hammer",
  "scan-search",
  "shield-check",
  "waypoints",
  "wrench",
]);

export type RolePresentationIcon = z.infer<typeof RolePresentationIconSchema>;

export const RolePresentationColorSchema = z.enum([
  "amber",
  "blue",
  "cyan",
  "rose",
  "slate",
  "teal",
  "violet",
]);

export type RolePresentationColor = z.infer<typeof RolePresentationColorSchema>;

export const RolePresentationSchema = z
  .object({
    icon: RolePresentationIconSchema,
    color: RolePresentationColorSchema,
    shortName: z.string().trim().min(1).max(24).optional(),
  })
  .strict();

export type RolePresentation = z.infer<typeof RolePresentationSchema>;

export const UpdateRolePresentationCommandSchema = RolePresentationSchema;

export type UpdateRolePresentationCommand = z.infer<typeof UpdateRolePresentationCommandSchema>;

export const RoleDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500).optional(),
    instructions: z.array(InstructionPathSchema).max(32).default([]),
    permissionPolicy: RolePermissionPolicySchema.default("inherit"),
    presentation: RolePresentationSchema.optional(),
  })
  .strict();

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export const ConfiguredAgentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export type ConfiguredAgentId = z.infer<typeof ConfiguredAgentIdSchema>;

export const ConfiguredAgentSchema = z
  .object({
    memberId: IdentifierSchema,
    name: z.string().trim().min(1).max(100),
    integrationId: IntegrationIdSchema,
    roleId: RoleIdSchema.optional(),
    instructions: z.array(InstructionPathSchema).max(32).default([]),
    order: z.number().int().nonnegative().max(255).optional(),
  })
  .strict();

export type ConfiguredAgent = z.infer<typeof ConfiguredAgentSchema>;

export const CreateGroupAgentCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    integrationId: IntegrationIdSchema,
    roleId: RoleIdSchema.optional(),
    instructions: z.array(InstructionPathSchema).max(32).optional(),
  })
  .strict();

export type CreateGroupAgentCommand = z.infer<typeof CreateGroupAgentCommandSchema>;

export const UpdateGroupAgentCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    integrationId: IntegrationIdSchema.optional(),
    roleId: RoleIdSchema.nullable().optional(),
    instructions: z.array(InstructionPathSchema).max(32).optional(),
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

export const ConfiguredGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    instructions: z.array(InstructionPathSchema).max(32).default([]),
    agents: z.record(ConfiguredAgentIdSchema, ConfiguredAgentSchema).default({}),
  })
  .strict();

export type ConfiguredGroup = z.infer<typeof ConfiguredGroupSchema>;

export const MessageConfigSchema = z
  .object({
    retentionPerGroup: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(DEFAULT_MESSAGE_RETENTION_PER_GROUP),
  })
  .strict();

export type MessageConfig = z.infer<typeof MessageConfigSchema>;

export const NanasaConfigSchema = z
  .object({
    instructions: z.array(InstructionPathSchema).max(32).default([]),
    integrations: z.record(IntegrationIdSchema, IntegrationConfigSchema),
    roles: z.record(RoleIdSchema, RoleDefinitionSchema).default({}),
    groups: z.record(IdentifierSchema, ConfiguredGroupSchema).default({}),
    messages: MessageConfigSchema.default({
      retentionPerGroup: DEFAULT_MESSAGE_RETENTION_PER_GROUP,
    }),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [integrationId, integration] of Object.entries(config.integrations)) {
      if (integration.id !== integrationId) {
        context.addIssue({
          code: "custom",
          message: "Integration ID must match its configuration key",
          path: ["integrations", integrationId, "id"],
        });
      }
    }
    const agentIds = new Set<string>();
    for (const [groupId, group] of Object.entries(config.groups)) {
      const memberIds = new Set<string>();
      for (const [agentId, agent] of Object.entries(group.agents)) {
        if (config.integrations[agent.integrationId] === undefined) {
          context.addIssue({
            code: "custom",
            message: `Agent references unknown integration ${agent.integrationId}`,
            path: ["groups", groupId, "agents", agentId, "integrationId"],
          });
        }
        if (agent.roleId !== undefined && config.roles[agent.roleId] === undefined) {
          context.addIssue({
            code: "custom",
            message: `Agent references unknown role ${agent.roleId}`,
            path: ["groups", groupId, "agents", agentId, "roleId"],
          });
        }
        if (agentIds.has(agentId)) {
          context.addIssue({
            code: "custom",
            message: `Configuration contains duplicate agent ID ${agentId}`,
            path: ["groups", groupId, "agents", agentId],
          });
        }
        if (memberIds.has(agent.memberId)) {
          context.addIssue({
            code: "custom",
            message: `Group contains duplicate member ID ${agent.memberId}`,
            path: ["groups", groupId, "agents", agentId, "memberId"],
          });
        }
        agentIds.add(agentId);
        memberIds.add(agent.memberId);
      }
    }
  });

export type NanasaConfig = z.infer<typeof NanasaConfigSchema>;

export const ConfigDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).default([]),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

export const ConfigStatusSchema = z
  .object({
    state: z.enum(["ready", "error"]),
    repoRoot: z.string().min(1),
    configPath: z.string().min(1),
    revision: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    diagnostics: z.array(ConfigDiagnosticSchema),
  })
  .strict();

export type ConfigDiagnostic = z.infer<typeof ConfigDiagnosticSchema>;
export type ConfigStatus = z.infer<typeof ConfigStatusSchema>;

const CanonicalAgentProfileSchema = z.object({
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(100),
  agentType: AgentTypeKeySchema,
  kind: AgentKindSchema,
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  workingDirectory: z.string().min(1).optional(),
  environment: EnvironmentSchema.default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

type CanonicalAgentProfile = z.infer<typeof CanonicalAgentProfileSchema>;

export type AgentProfile = CanonicalAgentProfile;

export const AgentProfileSchema = CanonicalAgentProfileSchema;

const CanonicalInternalCreateAgentProfileCommandSchema = CanonicalAgentProfileSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
  .extend({
    adapter: AdapterKindSchema.optional(),
    capabilities: z.array(AgentCapabilitySchema).min(1).max(2).optional(),
  })
  .strict()
  .transform((profile) => ({
    name: profile.name,
    agentType: profile.agentType,
    kind: profile.kind,
    command: profile.command,
    args: profile.args,
    ...(profile.workingDirectory === undefined
      ? {}
      : { workingDirectory: profile.workingDirectory }),
    environment: profile.environment,
  }));

export type InternalCreateAgentProfileCommand = z.infer<
  typeof CanonicalInternalCreateAgentProfileCommandSchema
>;

export const InternalCreateAgentProfileCommandSchema =
  CanonicalInternalCreateAgentProfileCommandSchema;

export const MembershipStateSchema = z.enum(["active", "removed"]);

export const GroupMembershipSchema = z.object({
  id: IdentifierSchema,
  groupId: IdentifierSchema,
  memberId: IdentifierSchema,
  agentProfileId: IdentifierSchema,
  alias: z.string().trim().min(1).max(100),
  roleId: RoleIdSchema.optional(),
  state: MembershipStateSchema,
  joinedAt: TimestampSchema,
  removedAt: TimestampSchema.optional(),
});

export type GroupMembership = z.infer<typeof GroupMembershipSchema>;

export const RunStatusSchema = z.enum(["starting", "running", "stopping", "stopped", "failed"]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const DesiredRunStateSchema = z.enum(["running", "stopped"]);
export const RecoveryPhaseSchema = z.enum([
  "idle",
  "reconciling",
  "resuming",
  "restarting",
  "recovered",
  "failed",
]);

export type DesiredRunState = z.infer<typeof DesiredRunStateSchema>;
export type RecoveryPhase = z.infer<typeof RecoveryPhaseSchema>;

export const TerminalBindingSchema = z.object({
  serverName: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  windowId: z.string().regex(/^@[0-9]+$/),
  paneId: z.string().regex(/^%[0-9]+$/),
});

export type TerminalBinding = z.infer<typeof TerminalBindingSchema>;

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
    .object({
      code: z.string().trim().min(1),
      message: z.string().trim().min(1),
    })
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
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
  })
  .strict();

export type AdHocConsoleSession = z.infer<typeof AdHocConsoleSessionSchema>;

const CanonicalAgentRunSchema = z.object({
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
  recoveryReason: z.string().min(1).optional(),
  terminal: TerminalBindingSchema.optional(),
  startedAt: TimestampSchema,
  stoppedAt: TimestampSchema.optional(),
});

type CanonicalAgentRun = z.infer<typeof CanonicalAgentRunSchema>;

export type AgentRun = CanonicalAgentRun;

export const AgentRunSchema = CanonicalAgentRunSchema;

export const AgentStatusStateSchema = z.enum([
  "not_started",
  "starting",
  "working",
  "waiting",
  "idle",
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

export const StartAgentRunCommandSchema = z.object({
  cols: z.number().int().min(20).max(1000).default(120),
  rows: z.number().int().min(5).max(1000).default(40),
});

export type StartAgentRunCommand = z.infer<typeof StartAgentRunCommandSchema>;

export const StartGroupRunsCommandSchema = StartAgentRunCommandSchema;

export type StartGroupRunsCommand = z.infer<typeof StartGroupRunsCommandSchema>;

export const StartGroupRunOutcomeSchema = z
  .object({
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    status: z.enum(["started", "already-running", "failed"]),
    runId: IdentifierSchema.optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export type StartGroupRunOutcome = z.infer<typeof StartGroupRunOutcomeSchema>;

export const StartGroupRunsResultSchema = z
  .object({
    groupId: IdentifierSchema,
    outcomes: z.array(StartGroupRunOutcomeSchema),
  })
  .strict();

export type StartGroupRunsResult = z.infer<typeof StartGroupRunsResultSchema>;

export const StopAgentRunCommandSchema = z.object({
  force: z.boolean().default(false),
});

export type StopAgentRunCommand = z.infer<typeof StopAgentRunCommandSchema>;

export const InterruptAgentRunCommandSchema = z
  .object({
    operatorId: IdentifierSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type InterruptAgentRunCommand = z.infer<typeof InterruptAgentRunCommandSchema>;

export const MessageIntentSchema = z.enum(["inform", "request", "response", "control"]);

export type MessageIntent = z.infer<typeof MessageIntentSchema>;

const DirectAudienceSchema = z.object({
  kind: z.literal("dm"),
  memberId: IdentifierSchema,
});

const MulticastAudienceSchema = z.object({
  kind: z.literal("multicast"),
  memberIds: z.array(IdentifierSchema).min(2),
});

const GroupBroadcastAudienceSchema = z.object({
  kind: z.literal("group"),
  membershipRevision: z.number().int().nonnegative(),
});

export const AudienceSchema = z
  .discriminatedUnion("kind", [
    DirectAudienceSchema,
    MulticastAudienceSchema,
    GroupBroadcastAudienceSchema,
  ])
  .superRefine((audience, context) => {
    if (
      audience.kind === "multicast" &&
      new Set(audience.memberIds).size !== audience.memberIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Multicast recipients must be unique",
        path: ["memberIds"],
      });
    }
  });

export type Audience = z.infer<typeof AudienceSchema>;

export const DeliveryModeSchema = z.enum(["queue", "steer", "terminal"]);

export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

const DeliveryPolicyInputSchema = z
  .object({
    mode: DeliveryModeSchema.optional(),
    expiresAt: TimestampSchema.optional(),
  })
  .strict()
  .transform((delivery) =>
    delivery.expiresAt === undefined ? {} : { expiresAt: delivery.expiresAt },
  );

export type DeliveryPolicy = z.output<typeof DeliveryPolicyInputSchema>;

export const DeliveryPolicySchema = DeliveryPolicyInputSchema;

export const MessageSenderSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("operator"),
    operatorId: IdentifierSchema,
  }),
  z.object({
    kind: z.literal("agent"),
    memberId: IdentifierSchema,
    runId: IdentifierSchema,
  }),
]);

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const MessageBodySchema = z
  .object({
    contentType: z.enum(["text/plain", "text/markdown"]),
    text: z.string().min(1),
  })
  .strict()
  .superRefine((body, context) => {
    if (!isWellFormedUnicode(body.text)) {
      context.addIssue({
        code: "custom",
        message: "Message text must contain well-formed Unicode",
        path: ["text"],
      });
      return;
    }
    const bytes = new TextEncoder().encode(body.text).byteLength;
    if (bytes > MAX_MESSAGE_TEXT_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Message text exceeds the ${MAX_MESSAGE_TEXT_BYTES}-byte UTF-8 limit. ${OVERSIZED_MESSAGE_GUIDANCE}`,
        path: ["text"],
      });
    }
  });

export type MessageBody = z.infer<typeof MessageBodySchema>;

export const MessageSchema = z
  .object({
    id: IdentifierSchema,
    groupId: IdentifierSchema,
    groupSeq: z.number().int().positive(),
    conversationId: IdentifierSchema,
    intent: MessageIntentSchema,
    sender: MessageSenderSchema,
    audience: AudienceSchema,
    body: MessageBodySchema,
    delivery: DeliveryPolicySchema,
    replyTo: IdentifierSchema.optional(),
    rootId: IdentifierSchema.optional(),
    causationId: IdentifierSchema.optional(),
    hop: z.number().int().nonnegative().max(8).default(0),
    createdAt: TimestampSchema,
  })
  .superRefine((message, context) => {
    if (message.intent === "control" && message.sender.kind !== "operator") {
      context.addIssue({
        code: "custom",
        message: "Only operators can send control messages",
        path: ["intent"],
      });
    }
  });

export type Message = z.infer<typeof MessageSchema>;

export const SubmitMessageCommandSchema = z
  .object({
    conversationId: IdentifierSchema.optional(),
    intent: MessageIntentSchema,
    sender: MessageSenderSchema,
    audience: AudienceSchema,
    body: MessageBodySchema,
    delivery: DeliveryPolicySchema,
    replyTo: IdentifierSchema.optional(),
    rootId: IdentifierSchema.optional(),
    causationId: IdentifierSchema.optional(),
    hop: z.number().int().nonnegative().max(8).default(0),
  })
  .superRefine((message, context) => {
    if (message.intent === "control" && message.sender.kind !== "operator") {
      context.addIssue({
        code: "custom",
        message: "Only operators can send control messages",
        path: ["intent"],
      });
    }
  });

export type SubmitMessageCommand = z.infer<typeof SubmitMessageCommandSchema>;

export const DeliveryStatusSchema = z.enum([
  "queued",
  "received",
  "delivering",
  "consumed",
  "processed",
  "retrying",
  "dead-letter",
  "revoked",
  "rejected",
  "failed",
]);

export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

const CanonicalDeliveryOutcomeSchema = z.object({
  messageId: IdentifierSchema,
  recipientMemberId: IdentifierSchema,
  reason: z.string().min(1).optional(),
  status: DeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
});

type CanonicalDeliveryOutcome = z.infer<typeof CanonicalDeliveryOutcomeSchema>;

export type DeliveryOutcome = CanonicalDeliveryOutcome;

export const DeliveryOutcomeSchema = CanonicalDeliveryOutcomeSchema;

export const MessageSubmissionResultSchema = z.object({
  message: MessageSchema,
  deliveryOutcomes: z.array(DeliveryOutcomeSchema),
});

export type MessageSubmissionResult = z.infer<typeof MessageSubmissionResultSchema>;

export const GroupMessageStateSchema = z
  .object({
    groupId: IdentifierSchema,
    latestGroupSeq: z.number().int().nonnegative(),
    oldestRetainedGroupSeq: z.number().int().positive().optional(),
    retainedMessageCount: z.number().int().nonnegative(),
    activeDeliveryCount: z.number().int().nonnegative(),
    failedRecipientMemberIds: z.array(IdentifierSchema),
  })
  .strict();

export type GroupMessageState = z.infer<typeof GroupMessageStateSchema>;

export const MessagePageInfoSchema = z
  .object({
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
    nextBefore: z.number().int().positive().optional(),
    nextAfter: z.number().int().positive().optional(),
  })
  .strict();

export const MessagePageSchema = z
  .object({
    groupId: IdentifierSchema,
    messages: z.array(MessageSchema),
    deliveryOutcomes: z.array(DeliveryOutcomeSchema),
    state: GroupMessageStateSchema,
    pageInfo: MessagePageInfoSchema,
  })
  .strict();

export type MessagePage = z.infer<typeof MessagePageSchema>;

export const ClearMessageHistoryResultSchema = z
  .object({
    groupId: IdentifierSchema,
    deletedMessages: z.number().int().nonnegative(),
    deletedDeliveries: z.number().int().nonnegative(),
    state: GroupMessageStateSchema,
  })
  .strict();

export type ClearMessageHistoryResult = z.infer<typeof ClearMessageHistoryResultSchema>;

export const DomainEventSchema = z.object({
  sequence: z.number().int().positive(),
  id: IdentifierSchema,
  type: z.string().trim().min(1).max(100),
  aggregateType: z.string().trim().min(1).max(100),
  aggregateId: IdentifierSchema,
  occurredAt: TimestampSchema,
  payload: z.record(z.string(), z.unknown()),
});

export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const PortalSnapshotSchema = z.object({
  sequence: z.number().int().nonnegative(),
  generatedAt: TimestampSchema,
  groups: z.array(GroupSchema),
  agentProfiles: z.array(AgentProfileSchema),
  memberships: z.array(GroupMembershipSchema),
  runs: z.array(AgentRunSchema),
  agentStatuses: z.array(AgentStatusSummarySchema).optional(),
  messages: z.array(MessageSchema),
  deliveryOutcomes: z.array(DeliveryOutcomeSchema),
  messageGroups: z.array(GroupMessageStateSchema).optional(),
  config: NanasaConfigSchema.optional(),
  configStatus: ConfigStatusSchema.optional(),
});

export type PortalSnapshot = z.infer<typeof PortalSnapshotSchema>;
