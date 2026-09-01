import { z } from "zod";
import {
  ConfiguredGroupSchema,
  DEFAULT_MESSAGE_RETENTION_PER_GROUP,
  InstructionPathSchema,
  MessageConfigSchema,
  RepositoryIntentSchema,
  RoleDefinitionSchema,
  TerminalPolicySchema,
} from "./config-v2.js";
import { RoleIdSchema } from "./control-v1.js";
import {
  ExtensionIdV2Schema,
  IntegrationIdV3Schema,
  OpenIdentitySchema,
  ProviderCapabilityIdSchema,
  ProviderIdSchema,
} from "./provider-runtime-v2.js";

export const CONFIG_V3_VERSION = 3 as const;

export const ProviderStatePolicyV3Schema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("membership") }).strict(),
  z.object({ scope: z.literal("integration") }).strict(),
  z
    .object({
      scope: z.literal("custom"),
      path: z
        .string()
        .min(1)
        .max(4_096)
        .refine(
          (path) =>
            !path.includes("\0") &&
            !path.includes("\\") &&
            !path.startsWith("/") &&
            path.split("/").every((segment) => segment !== ".."),
          "Custom provider state must be a normalized relative path",
        ),
    })
    .strict(),
]);

export const CredentialSlotReferenceV3Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("provider-managed") }).strict(),
  z
    .object({
      mode: z.literal("broker-profile"),
      profileId: z.string().min(1).max(128),
      slotId: OpenIdentitySchema,
    })
    .strict(),
]);

export const IntegrationConfigV3Schema = z
  .object({
    id: IntegrationIdV3Schema,
    name: z.string().min(1).max(100),
    providerId: ProviderIdSchema,
    command: z.array(z.string().min(1).max(4_096)).min(1).max(128),
    cwd: z.string().min(1).max(4_096).optional(),
    providerState: ProviderStatePolicyV3Schema.default({ scope: "membership" }),
    credentialSlots: z.record(OpenIdentitySchema, CredentialSlotReferenceV3Schema).default({}),
    model: z
      .object({
        desired: z.string().min(1).max(256).optional(),
        resumePolicy: z.enum(["preserve-session", "enforce-configured"]),
      })
      .strict()
      .default({ resumePolicy: "preserve-session" }),
    nativeRecovery: z
      .object({
        mode: z.enum(["resume-or-restart", "resume-only", "restart"]),
        confirmationTimeoutSeconds: z.number().int().min(5).max(300),
      })
      .strict()
      .default({ mode: "resume-or-restart", confirmationTimeoutSeconds: 30 }),
    extensions: z.array(ExtensionIdV2Schema).max(32).default([]),
    requiredCapabilities: z.array(ProviderCapabilityIdSchema).max(32).default([]),
    environment: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16_384))
      .default({}),
  })
  .strict();
export type IntegrationConfigV3 = z.infer<typeof IntegrationConfigV3Schema>;

export const ConfiguredProviderExtensionV3Schema = z
  .object({
    version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/),
    packageDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export const NanasaConfigV3Schema = z
  .object({
    version: z.literal(CONFIG_V3_VERSION),
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
    integrations: z.record(IntegrationIdV3Schema, IntegrationConfigV3Schema),
    extensions: z.record(ExtensionIdV2Schema, ConfiguredProviderExtensionV3Schema).default({}),
    roles: z.record(RoleIdSchema, RoleDefinitionSchema).default({}),
    groups: z.record(z.string().min(1).max(128), ConfiguredGroupSchema).default({}),
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
      if (
        new Set(integration.requiredCapabilities).size !== integration.requiredCapabilities.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Required capabilities must be unique",
          path: ["integrations", integrationId, "requiredCapabilities"],
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
export type NanasaConfigV3 = z.infer<typeof NanasaConfigV3Schema>;
