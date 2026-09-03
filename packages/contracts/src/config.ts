import { z } from "zod";
import { ConfiguredAgentIdSchema, IdentifierSchema, RoleIdSchema } from "./control.js";
import { ExtensionIdSchema, SemanticVersionSchema } from "./extensions.js";
import {
  AgentKindSchema,
  CredentialProfileReferenceSchema,
  DesiredModelPolicySchema,
  IntegrationIdSchema,
  NativeRecoveryPolicySchema,
  ProviderStatePolicySchema,
} from "./provider.js";

export const CONFIG_VERSION = 2 as const;
export const DEFAULT_MESSAGE_RETENTION_PER_GROUP = 1_000;

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

const EnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(16_384),
);

export const IntegrationCommandSourceSchema = z.enum(["builtin", "custom"]);
export type IntegrationCommandSource = z.infer<typeof IntegrationCommandSourceSchema>;
export const ProviderArgumentStrategySchema = z.union([
  z.literal("append"),
  z
    .object({
      kind: z.literal("environment"),
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    })
    .strict(),
]);
export type ProviderArgumentStrategy = z.infer<typeof ProviderArgumentStrategySchema>;
export const IntegrationLauncherSchema = z
  .object({ providerArguments: ProviderArgumentStrategySchema })
  .strict();
export type IntegrationLauncher = z.infer<typeof IntegrationLauncherSchema>;

export const IntegrationConfigSchema = z
  .object({
    id: IntegrationIdSchema,
    name: z.string().trim().min(1).max(100),
    kind: AgentKindSchema,
    command: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    commandSource: IntegrationCommandSourceSchema,
    launcher: IntegrationLauncherSchema.optional(),
    cwd: z.string().min(1).max(4_096).optional(),
    providerState: ProviderStatePolicySchema.default({ scope: "membership" }),
    credentials: CredentialProfileReferenceSchema.default({ kind: "provider-managed" }),
    model: DesiredModelPolicySchema.default({ resumePolicy: "preserve-session" }),
    nativeRecovery: NativeRecoveryPolicySchema.default({
      mode: "resume-or-restart",
      confirmationTimeoutSeconds: 30,
    }),
    extensions: z.array(ExtensionIdSchema).max(32).default([]),
    environment: EnvironmentSchema.default({}),
  })
  .strict()
  .superRefine((integration, context) => {
    if (integration.commandSource === "builtin" && integration.launcher !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Built-in integration commands may not define a launcher",
        path: ["launcher"],
      });
    }
    if (integration.commandSource === "custom" && integration.launcher === undefined) {
      context.addIssue({
        code: "custom",
        message: "Custom integration commands require a launcher",
        path: ["launcher"],
      });
    }
  });
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;

export const ConfiguredProviderExtensionSchema = z
  .object({ version: SemanticVersionSchema })
  .strict();

export const ConfiguredAgentSchema = z
  .object({
    memberId: IdentifierSchema,
    name: z.string().trim().min(1).max(100),
    integrationId: IntegrationIdSchema,
    roleId: RoleIdSchema.optional(),
    checkoutId: IdentifierSchema.optional(),
    desiredModel: z.string().trim().min(1).max(256).optional(),
    instructions: z.array(InstructionPathSchema).max(32).default([]),
    order: z.number().int().nonnegative().max(255).optional(),
  })
  .strict();
export type ConfiguredAgent = z.infer<typeof ConfiguredAgentSchema>;

export const ConfiguredGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    order: z.number().int().nonnegative().max(255).optional(),
    instructions: z.array(InstructionPathSchema).max(32).default([]),
    agents: z.record(ConfiguredAgentIdSchema, ConfiguredAgentSchema).default({}),
  })
  .strict();
export type ConfiguredGroup = z.infer<typeof ConfiguredGroupSchema>;

export const MessageConfigSchema = z
  .object({
    retentionPerGroup: z.number().int().min(1).max(100_000).default(1_000),
  })
  .strict();
export type MessageConfig = z.infer<typeof MessageConfigSchema>;

export const TerminalPolicySchema = z
  .object({
    checkpoints: z
      .object({
        enabled: z.boolean().default(false),
        maxLines: z.number().int().min(1).max(100_000).default(5_000),
        maxBytes: z.number().int().min(1).max(16_777_216).default(1_048_576),
        retentionSeconds: z.number().int().min(60).max(31_536_000).default(86_400),
        sensitivity: z.enum(["repository-private", "encrypted"]).default("repository-private"),
      })
      .strict()
      .default({
        enabled: false,
        maxLines: 5_000,
        maxBytes: 1_048_576,
        retentionSeconds: 86_400,
        sensitivity: "repository-private",
      }),
  })
  .strict();
export type TerminalPolicy = z.infer<typeof TerminalPolicySchema>;

export const RepositoryIntentSchema = z
  .object({
    path: z.string().trim().min(1).max(4_096).default("."),
    checkout: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("current") }).strict(),
        z.object({ kind: z.literal("worktree"), checkoutId: IdentifierSchema }).strict(),
      ])
      .default({ kind: "current" }),
  })
  .strict();
export type RepositoryIntent = z.infer<typeof RepositoryIntentSchema>;

export const NanasaConfigSchema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    repository: RepositoryIntentSchema.default({ path: ".", checkout: { kind: "current" } }),
    terminal: TerminalPolicySchema.default({
      checkpoints: {
        enabled: false,
        maxLines: 5_000,
        maxBytes: 1_048_576,
        retentionSeconds: 86_400,
        sensitivity: "repository-private",
      },
    }),
    instructions: z.array(InstructionPathSchema).max(32).default([]),
    integrations: z.record(IntegrationIdSchema, IntegrationConfigSchema),
    extensions: z.record(ExtensionIdSchema, ConfiguredProviderExtensionSchema).default({}),
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
      for (const extensionId of integration.extensions) {
        if (config.extensions[extensionId] === undefined) {
          context.addIssue({
            code: "custom",
            message: `Integration references unknown extension ${extensionId}`,
            path: ["integrations", integrationId, "extensions"],
          });
        }
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
