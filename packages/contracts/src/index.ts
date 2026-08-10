import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(128);
const TimestampSchema = z.string().datetime({ offset: true });

export const CreateGroupCommandSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export type CreateGroupCommand = z.infer<typeof CreateGroupCommandSchema>;

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

export const AgentTypeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const AdapterKindSchema = z.enum(["copilot-cli", "pi-rpc", "terminal"]);
export const RecoveryPolicySchema = z.enum(["resume-or-restart", "restart"]);
export const AgentCapabilitySchema = z.enum(["queue", "steer"]);

export type AdapterKind = z.infer<typeof AdapterKindSchema>;
export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

const EnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(16_384),
);

export const AgentTypeConfigSchema = z
  .object({
    key: AgentTypeKeySchema,
    name: z.string().trim().min(1).max(100),
    kind: AgentKindSchema,
    adapter: AdapterKindSchema,
    command: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    cwd: z.string().min(1).max(4_096).optional(),
    environment: EnvironmentSchema.default({}),
    recovery: RecoveryPolicySchema,
    capabilities: z.array(AgentCapabilitySchema).min(1).max(2),
  })
  .strict()
  .superRefine((agentType, context) => {
    if (new Set(agentType.capabilities).size !== agentType.capabilities.length) {
      context.addIssue({
        code: "custom",
        message: "Agent capabilities must be unique",
        path: ["capabilities"],
      });
    }
    if (agentType.adapter === "terminal" && agentType.capabilities.includes("steer")) {
      context.addIssue({
        code: "custom",
        message: "Terminal adapters support queue delivery only",
        path: ["capabilities"],
      });
    }
    if (agentType.adapter === "copilot-cli" && agentType.capabilities.includes("steer")) {
      context.addIssue({
        code: "custom",
        message: "Copilot CLI ACP supports queue delivery only",
        path: ["capabilities"],
      });
    }
    if (agentType.adapter === "terminal" && agentType.recovery !== "restart") {
      context.addIssue({
        code: "custom",
        message: "Terminal adapters must use restart recovery",
        path: ["recovery"],
      });
    }
  });

export type AgentTypeConfig = z.infer<typeof AgentTypeConfigSchema>;

export const NanasaConfigSchema = z
  .object({
    version: z.literal(1),
    agentTypes: z.record(AgentTypeKeySchema, AgentTypeConfigSchema),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [key, agentType] of Object.entries(config.agentTypes)) {
      if (agentType.key !== key) {
        context.addIssue({
          code: "custom",
          message: "Agent type key must match its configuration key",
          path: ["agentTypes", key, "key"],
        });
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

export const AgentProfileSchema = z.object({
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(100),
  agentType: AgentTypeKeySchema,
  kind: AgentKindSchema,
  adapter: AdapterKindSchema,
  capabilities: z.array(AgentCapabilitySchema).min(1).max(2),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  workingDirectory: z.string().min(1).optional(),
  environment: EnvironmentSchema.default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const CreateAgentProfileCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    agentType: AgentTypeKeySchema,
  })
  .strict();

export type CreateAgentProfileCommand = z.infer<typeof CreateAgentProfileCommandSchema>;

export const InternalCreateAgentProfileCommandSchema = AgentProfileSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).strict();

export type InternalCreateAgentProfileCommand = z.infer<
  typeof InternalCreateAgentProfileCommandSchema
>;

export const MembershipStateSchema = z.enum(["active", "removed"]);

export const GroupMembershipSchema = z.object({
  id: IdentifierSchema,
  groupId: IdentifierSchema,
  memberId: IdentifierSchema,
  agentProfileId: IdentifierSchema,
  alias: z.string().trim().min(1).max(100),
  state: MembershipStateSchema,
  joinedAt: TimestampSchema,
  removedAt: TimestampSchema.optional(),
});

export type GroupMembership = z.infer<typeof GroupMembershipSchema>;

export const AddGroupMembershipCommandSchema = z.object({
  memberId: IdentifierSchema.optional(),
  agentProfileId: IdentifierSchema,
  alias: z.string().trim().min(1).max(100),
});

export type AddGroupMembershipCommand = z.infer<typeof AddGroupMembershipCommandSchema>;

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

export const AdapterSessionMetadataSchema = z
  .object({
    adapter: AdapterKindSchema,
    sessionId: z.string().min(1).optional(),
    sessionFile: z.string().min(1).optional(),
    adapterMessageId: z.string().min(1).optional(),
    updatedAt: TimestampSchema,
  })
  .strict();

export type AdapterSessionMetadata = z.infer<typeof AdapterSessionMetadataSchema>;

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

export const AgentRunSchema = z.object({
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
  adapterSessionId: z.string().min(1).optional(),
  adapterSession: AdapterSessionMetadataSchema.optional(),
  terminal: TerminalBindingSchema.optional(),
  startedAt: TimestampSchema,
  stoppedAt: TimestampSchema.optional(),
});

export type AgentRun = z.infer<typeof AgentRunSchema>;

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

export const AdapterReadinessSchema = z.enum(["starting", "ready", "unavailable", "closed"]);

export type AdapterReadiness = z.infer<typeof AdapterReadinessSchema>;

export const AgentAdapterStatusSchema = z
  .object({
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    adapter: AdapterKindSchema,
    capabilities: z.array(AgentCapabilitySchema).max(2),
    readiness: AdapterReadinessSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();

export type AgentAdapterStatus = z.infer<typeof AgentAdapterStatusSchema>;

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

export const EffectiveDeliveryModesCommandSchema = z
  .object({
    memberIds: z.array(IdentifierSchema).min(1),
  })
  .strict()
  .superRefine((command, context) => {
    if (new Set(command.memberIds).size !== command.memberIds.length) {
      context.addIssue({
        code: "custom",
        message: "Member IDs must be unique",
        path: ["memberIds"],
      });
    }
  });

export const EffectiveDeliveryModesSchema = z
  .object({
    memberIds: z.array(IdentifierSchema).min(1),
    modes: z.array(DeliveryModeSchema).max(3),
  })
  .strict();

export type EffectiveDeliveryModesCommand = z.infer<typeof EffectiveDeliveryModesCommandSchema>;
export type EffectiveDeliveryModes = z.infer<typeof EffectiveDeliveryModesSchema>;

export const DeliveryPolicySchema = z
  .object({
    mode: DeliveryModeSchema,
    expiresAt: TimestampSchema.optional(),
  })
  .strict();

export type DeliveryPolicy = z.infer<typeof DeliveryPolicySchema>;

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

export const MessageSchema = z
  .object({
    id: IdentifierSchema,
    groupId: IdentifierSchema,
    groupSeq: z.number().int().positive(),
    conversationId: IdentifierSchema,
    intent: MessageIntentSchema,
    sender: MessageSenderSchema,
    audience: AudienceSchema,
    body: z.object({
      contentType: z.enum(["text/plain", "text/markdown"]),
      text: z.string().min(1),
    }),
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
    body: z.object({
      contentType: z.enum(["text/plain", "text/markdown"]),
      text: z.string().min(1),
    }),
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

export const DeliveryOutcomeSchema = z.object({
  messageId: IdentifierSchema,
  recipientMemberId: IdentifierSchema,
  requestedMode: DeliveryModeSchema,
  appliedMode: DeliveryModeSchema.optional(),
  fallbackApplied: z.boolean().default(false),
  reason: z.string().min(1).optional(),
  status: DeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  adapter: AdapterKindSchema.optional(),
  adapterSessionId: z.string().min(1).optional(),
  adapterMessageId: z.string().min(1).optional(),
  updatedAt: TimestampSchema,
});

export type DeliveryOutcome = z.infer<typeof DeliveryOutcomeSchema>;

export const MessageSubmissionResultSchema = z.object({
  message: MessageSchema,
  deliveryOutcomes: z.array(DeliveryOutcomeSchema),
});

export type MessageSubmissionResult = z.infer<typeof MessageSubmissionResultSchema>;

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
  messages: z.array(MessageSchema),
  deliveryOutcomes: z.array(DeliveryOutcomeSchema),
  config: NanasaConfigSchema.optional(),
  configStatus: ConfigStatusSchema.optional(),
});

export type PortalSnapshot = z.infer<typeof PortalSnapshotSchema>;
