import { z } from "zod";
import { IdentifierSchema, TimestampSchema } from "./control.js";

export const PROVIDER_EXTENSION_API_VERSION = "nanasa.dev/provider-extension/v1" as const;
export const PROVIDER_EXTENSION_LOCK_VERSION = 1 as const;
export const PROVIDER_REPORTER_PROTOCOL_VERSION = 2 as const;

export const ExtensionIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
export type ExtensionId = z.infer<typeof ExtensionIdSchema>;

export const SemanticVersionSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
export const Sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ProviderExtensionPermissionSchema = z.enum([
  "provider-home:read-managed",
  "provider-home:write-owned",
  "runtime:launch-provider",
  "prompt:append",
  "mcp:register-nanasa",
  "reporter:status",
  "native-session:resume",
]);
export type ProviderExtensionPermission = z.infer<typeof ProviderExtensionPermissionSchema>;

export const ProviderAdapterStrategySchema = z.enum([
  "copilot-adapter-v1",
  "claude-code-adapter-v1",
  "pi-adapter-v1",
  "opencode-adapter-v1",
]);
export const ProviderHomeStrategySchema = z.enum([
  "copilot-home-v1",
  "claude-code-home-v1",
  "pi-home-v1",
  "opencode-xdg-v1",
]);
export const ProviderPromptStrategySchema = z.enum([
  "copilot-agent-v1",
  "claude-settings-v1",
  "pi-prompt-v1",
  "opencode-primary-agent-v1",
]);
export const ProviderMcpStrategySchema = z.enum([
  "copilot-mcp-v1",
  "claude-mcp-v1",
  "pi-mcp-v1",
  "opencode-mcp-v1",
]);
export const ProviderReporterStrategySchema = z.enum([
  "copilot-hooks-v2",
  "claude-hooks-v2",
  "pi-events-v2",
  "opencode-events-v2",
]);
export const ProviderControlStrategyIdSchema = z.enum([
  "copilot-terminal-v1",
  "claude-terminal-v1",
  "pi-terminal-v1",
  "opencode-terminal-v1",
]);
export const ProviderNativeResumeStrategySchema = z.enum([
  "copilot-resume-v1",
  "claude-resume-v1",
  "pi-resume-v1",
  "opencode-resume-v1",
]);
export const ProviderProvisioningStrategySchema = z.enum([
  "owned-file-v1",
  "managed-json-object-v1",
  "managed-json-array-v1",
  "marked-text-block-v1",
]);

export const ProviderExtensionAssetPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.includes("\\") &&
      !path.startsWith("/") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Extension asset paths must be normalized relative paths without traversal",
  )
  .refine(
    (path) =>
      !/\.(?:c?js|mjs|jsx|ts|tsx|sh|bash|zsh|fish|ps1|bat|cmd|exe|dll|so|dylib|wasm)$/i.test(path),
    "Executable and script assets are not allowed",
  );

export const ProviderExtensionAssetSchema = z
  .object({
    path: ProviderExtensionAssetPathSchema,
    mediaType: z.enum([
      "application/json",
      "application/toml",
      "application/yaml",
      "text/markdown",
      "text/plain",
    ]),
    bytes: z.number().int().min(1).max(1_048_576),
    sha256: Sha256DigestSchema,
  })
  .strict();
export type ProviderExtensionAsset = z.infer<typeof ProviderExtensionAssetSchema>;

const ProviderStrategiesSchema = z
  .object({
    adapter: ProviderAdapterStrategySchema,
    home: ProviderHomeStrategySchema,
    prompt: ProviderPromptStrategySchema,
    mcp: ProviderMcpStrategySchema,
    reporter: ProviderReporterStrategySchema,
    control: ProviderControlStrategyIdSchema,
    nativeResume: ProviderNativeResumeStrategySchema,
    provisioning: z.array(ProviderProvisioningStrategySchema).min(1).max(8),
  })
  .strict();

export const ProviderDescriptorSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    displayName: z.string().trim().min(1).max(100),
    commandNames: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
      .min(1)
      .max(16),
    strategies: ProviderStrategiesSchema,
  })
  .strict();
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;

const approvedStrategies = {
  "copilot-adapter-v1": {
    home: "copilot-home-v1",
    prompt: "copilot-agent-v1",
    mcp: "copilot-mcp-v1",
    reporter: "copilot-hooks-v2",
    control: "copilot-terminal-v1",
    nativeResume: "copilot-resume-v1",
  },
  "claude-code-adapter-v1": {
    home: "claude-code-home-v1",
    prompt: "claude-settings-v1",
    mcp: "claude-mcp-v1",
    reporter: "claude-hooks-v2",
    control: "claude-terminal-v1",
    nativeResume: "claude-resume-v1",
  },
  "pi-adapter-v1": {
    home: "pi-home-v1",
    prompt: "pi-prompt-v1",
    mcp: "pi-mcp-v1",
    reporter: "pi-events-v2",
    control: "pi-terminal-v1",
    nativeResume: "pi-resume-v1",
  },
  "opencode-adapter-v1": {
    home: "opencode-xdg-v1",
    prompt: "opencode-primary-agent-v1",
    mcp: "opencode-mcp-v1",
    reporter: "opencode-events-v2",
    control: "opencode-terminal-v1",
    nativeResume: "opencode-resume-v1",
  },
} as const;

export const REQUIRED_PROVIDER_EXTENSION_PERMISSIONS = Object.freeze([
  "provider-home:read-managed",
  "provider-home:write-owned",
  "runtime:launch-provider",
  "prompt:append",
  "mcp:register-nanasa",
  "reporter:status",
  "native-session:resume",
] satisfies ProviderExtensionPermission[]);

export const ProviderExtensionDescriptorSchema = z
  .object({
    apiVersion: z.literal(PROVIDER_EXTENSION_API_VERSION),
    kind: z.literal("ProviderExtension"),
    metadata: z
      .object({
        id: ExtensionIdSchema,
        name: z.string().trim().min(1).max(100),
        version: SemanticVersionSchema,
        publisher: z.string().trim().min(1).max(100),
        description: z.string().trim().min(1).max(500),
      })
      .strict(),
    compatibility: z
      .object({
        minNanasaVersion: SemanticVersionSchema,
        maxNanasaVersion: SemanticVersionSchema.optional(),
        reporterProtocol: z.literal(PROVIDER_REPORTER_PROTOCOL_VERSION),
      })
      .strict(),
    providers: z.array(ProviderDescriptorSchema).min(1).max(16),
    permissions: z.array(ProviderExtensionPermissionSchema).min(1).max(16),
    assets: z.array(ProviderExtensionAssetSchema).max(128).default([]),
  })
  .strict()
  .superRefine((descriptor, context) => {
    const providerIds = new Set<string>();
    for (const [index, provider] of descriptor.providers.entries()) {
      if (providerIds.has(provider.id)) {
        context.addIssue({
          code: "custom",
          message: "Provider IDs must be unique",
          path: ["providers", index, "id"],
        });
      }
      providerIds.add(provider.id);
      const approved = approvedStrategies[provider.strategies.adapter];
      for (const key of ["home", "prompt", "mcp", "reporter", "control", "nativeResume"] as const) {
        if (provider.strategies[key] !== approved[key]) {
          context.addIssue({
            code: "custom",
            message: `Strategy ${provider.strategies[key]} is not approved for ${provider.strategies.adapter}`,
            path: ["providers", index, "strategies", key],
          });
        }
      }
    }
    const permissions = [...descriptor.permissions].sort();
    const required = [...REQUIRED_PROVIDER_EXTENSION_PERMISSIONS].sort();
    if (
      permissions.length !== required.length ||
      permissions.some((item, index) => item !== required[index])
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Declared permissions must exactly match the permissions derived from provider strategies",
        path: ["permissions"],
      });
    }
    const paths = new Set<string>();
    for (const [index, asset] of descriptor.assets.entries()) {
      const key = asset.path.normalize("NFC").toLocaleLowerCase("en-US");
      if (paths.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Asset paths must not collide by case or Unicode normalization",
          path: ["assets", index, "path"],
        });
      }
      paths.add(key);
    }
  });
export type ProviderExtensionDescriptor = z.infer<typeof ProviderExtensionDescriptorSchema>;

export const ExtensionPackageSignatureSchema = z
  .object({
    algorithm: z.literal("ed25519"),
    keyId: IdentifierSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type ExtensionPackageSignature = z.infer<typeof ExtensionPackageSignatureSchema>;

export const ExtensionPackageSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), name: ExtensionIdSchema }).strict(),
  z.object({ kind: z.literal("uploaded"), label: z.string().trim().min(1).max(200) }).strict(),
]);

export const ExtensionLockGenerationSchema = z
  .object({
    descriptor: ProviderExtensionDescriptorSchema,
    descriptorDigest: Sha256DigestSchema,
    packageDigest: Sha256DigestSchema,
    source: ExtensionPackageSourceSchema,
    signature: ExtensionPackageSignatureSchema.optional(),
    grantedPermissions: z.array(ProviderExtensionPermissionSchema).min(1).max(16),
    packageReference: z.string().trim().min(1).max(4_096),
    installedAt: TimestampSchema,
  })
  .strict();
export type ExtensionLockGeneration = z.infer<typeof ExtensionLockGenerationSchema>;

export const ExtensionLockEntrySchema = ExtensionLockGenerationSchema.extend({
  enabled: z.boolean(),
  previous: ExtensionLockGenerationSchema.optional(),
}).strict();
export type ExtensionLockEntry = z.infer<typeof ExtensionLockEntrySchema>;

export const ExtensionLockSchema = z
  .object({
    version: z.literal(PROVIDER_EXTENSION_LOCK_VERSION),
    revision: z.number().int().nonnegative(),
    extensions: z.record(ExtensionIdSchema, ExtensionLockEntrySchema),
  })
  .strict();
export type ExtensionLock = z.infer<typeof ExtensionLockSchema>;

export const ProviderExtensionHealthStateSchema = z.enum([
  "not-installed",
  "current",
  "disabled",
  "drifted",
  "incompatible",
  "untrusted",
  "unavailable",
  "invalid",
]);
export const ProviderExtensionDiagnosticSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1_000),
    artifact: ProviderExtensionAssetPathSchema.optional(),
  })
  .strict();
export const ProviderExtensionHealthSchema = z
  .object({
    extensionId: ExtensionIdSchema,
    version: SemanticVersionSchema.optional(),
    state: ProviderExtensionHealthStateSchema,
    checkedAt: TimestampSchema,
    diagnostics: z.array(ProviderExtensionDiagnosticSchema).max(64),
    repairable: z.boolean(),
    rollbackAvailable: z.boolean(),
  })
  .strict();
export type ProviderExtensionHealth = z.infer<typeof ProviderExtensionHealthSchema>;

export const ProviderExtensionPlanSchema = z
  .object({
    extensionId: ExtensionIdSchema,
    version: SemanticVersionSchema,
    planDigest: Sha256DigestSchema,
    configRevision: Sha256DigestSchema,
    lockRevision: z.number().int().nonnegative(),
    permissions: z.array(ProviderExtensionPermissionSchema),
    mutations: z
      .array(
        z
          .object({
            kind: z.enum(["package", "owned-file", "managed-key", "lock"]),
            target: z.string().trim().min(1).max(4_096),
            ownershipKey: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .max(256),
    commands: z
      .array(
        z
          .object({
            integrationId: IdentifierSchema,
            executable: z.string().trim().min(1).max(4_096),
            argv: z.array(z.string().max(4_096)).max(64),
            cwd: z.string().trim().min(1).max(4_096),
            environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(128),
          })
          .strict(),
      )
      .max(256),
    impactedAgents: z.array(IdentifierSchema).max(1_024),
    requiresStoppedRuns: z.boolean(),
  })
  .strict();
export type ProviderExtensionPlan = z.infer<typeof ProviderExtensionPlanSchema>;

export const ProviderCatalogItemSchema = z
  .object({
    descriptor: ProviderExtensionDescriptorSchema,
    source: ExtensionPackageSourceSchema,
    descriptorDigest: Sha256DigestSchema,
    packageDigest: Sha256DigestSchema,
    signatureState: z.enum(["builtin", "verified", "unavailable"]),
    installed: z.boolean(),
    enabled: z.boolean(),
    health: ProviderExtensionHealthSchema,
  })
  .strict();
export type ProviderCatalogItem = z.infer<typeof ProviderCatalogItemSchema>;

export const ProviderExtensionInspectSchema = z
  .object({
    catalog: ProviderCatalogItemSchema,
    lock: ExtensionLockEntrySchema.optional(),
    plan: ProviderExtensionPlanSchema,
  })
  .strict();
export type ProviderExtensionInspect = z.infer<typeof ProviderExtensionInspectSchema>;

export const ExtensionTrustReceiptSchema = z
  .object({
    extensionId: ExtensionIdSchema,
    version: SemanticVersionSchema,
    repositoryIdentity: Sha256DigestSchema,
    configRevision: Sha256DigestSchema,
    planDigest: Sha256DigestSchema,
    packageDigest: Sha256DigestSchema,
    permissions: z.array(ProviderExtensionPermissionSchema),
    principalId: IdentifierSchema,
    trustedAt: TimestampSchema,
  })
  .strict();
export type ExtensionTrustReceipt = z.infer<typeof ExtensionTrustReceiptSchema>;

export const TrustProviderExtensionCommandSchema = z
  .object({ planDigest: Sha256DigestSchema, configRevision: Sha256DigestSchema })
  .strict();
export const InstallProviderExtensionCommandSchema = z
  .object({
    planDigest: Sha256DigestSchema,
    configRevision: Sha256DigestSchema,
    expectedLockRevision: z.number().int().nonnegative(),
  })
  .strict();
export const RepairProviderExtensionCommandSchema = InstallProviderExtensionCommandSchema;
export const ExtensionLifecycleCommandSchema = z
  .object({ expectedLockRevision: z.number().int().nonnegative() })
  .strict();
export type TrustProviderExtensionCommand = z.infer<typeof TrustProviderExtensionCommandSchema>;
export type InstallProviderExtensionCommand = z.infer<typeof InstallProviderExtensionCommandSchema>;
export type ExtensionLifecycleCommand = z.infer<typeof ExtensionLifecycleCommandSchema>;

export const ProviderExtensionReferenceSchema = z
  .object({
    schema: z.unknown(),
    permissions: z.array(ProviderExtensionPermissionSchema),
    strategies: z.record(z.string(), z.array(z.string())),
    descriptors: z.array(ProviderExtensionDescriptorSchema),
  })
  .strict();
