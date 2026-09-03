import { z } from "zod";
import { canonicalJsonBytes } from "./canonical-json.js";
import { ProviderArgumentStrategySchema } from "./config.js";

const OpenIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const OperationIdPattern = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const EnvironmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const OpenIdentitySchema = z.string().min(1).max(128).regex(OpenIdPattern);
export const ProviderIdSchema = OpenIdentitySchema;
export const ProviderExtensionIdSchema = OpenIdentitySchema;
export const AdapterIdSchema = OpenIdentitySchema;
export const ReporterSourceIdSchema = OpenIdentitySchema;
export const ProviderIntegrationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export const SnapshotDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const ProcessIncarnationDigestSchema = SnapshotDigestSchema;
export const StatusPolicyDigestSchema = SnapshotDigestSchema;
export const AssetDigestSchema = SnapshotDigestSchema;
export const OperationIdSchema = z.string().min(1).max(160).regex(OperationIdPattern);
export const RunGenerationSchema = z.number().int().positive();
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type AdapterId = z.infer<typeof AdapterIdSchema>;
export type SnapshotDigest = z.infer<typeof SnapshotDigestSchema>;

export const PROVIDER_CAPABILITY_IDS = [
  "identity",
  "recognition",
  "launch",
  "state",
  "prompt",
  "mcp",
  "reporter",
  "control",
  "models",
  "sessions",
  "credentials",
  "semantic-status",
  "screen",
  "osc",
  "actions",
  "health",
  "compatibility",
] as const;
export const ProviderCapabilityIdSchema = z.enum(PROVIDER_CAPABILITY_IDS);
export type ProviderCapabilityId = z.infer<typeof ProviderCapabilityIdSchema>;

export const CapabilityVersionSchema = z
  .object({ major: z.number().int().positive(), minor: z.number().int().nonnegative().max(65_535) })
  .strict();
export const CapabilityVersionRangeSchema = z
  .object({
    major: z.number().int().positive(),
    minimumMinor: z.number().int().nonnegative().max(65_535),
    maximumMinor: z.number().int().nonnegative().max(65_535),
  })
  .strict()
  .refine((range) => range.minimumMinor <= range.maximumMinor, {
    message: "Capability minimum minor must not exceed maximum minor",
  });
export const CapabilityDependencySchema = z
  .object({ id: ProviderCapabilityIdSchema, version: CapabilityVersionRangeSchema })
  .strict();

const MatcherSchema = z
  .object({
    executableNames: z.array(z.string().min(1).max(128)).min(1).max(32),
    requiredArgvLiterals: z.array(z.string().min(1).max(256)).max(16).default([]),
  })
  .strict();
const FileRecipeSchema = z
  .object({
    recipeId: OperationIdSchema,
    relativePath: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (path) =>
          !path.includes("\0") &&
          !path.includes("\\") &&
          !path.startsWith("/") &&
          path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
        "Recipe paths must be normalized relative paths",
      ),
    mode: z.enum(["private-file", "private-directory"]),
    assetDigest: AssetDigestSchema.optional(),
  })
  .strict();
const TransportSchema = z.enum(["terminal", "provider-api", "rpc", "hook", "acp"]);
const EventIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const IdentityCapabilityPayloadSchema = z
  .object({
    publisherId: OpenIdentitySchema,
    providerId: ProviderIdSchema,
    extensionId: ProviderExtensionIdSchema,
    adapterId: AdapterIdSchema,
    ownedNamespaces: z.array(OpenIdentitySchema).min(1).max(32),
  })
  .strict();
export const RecognitionCapabilityPayloadSchema = z
  .object({
    observedProcessMatchers: z.array(MatcherSchema).min(1).max(32),
    maximumWrapperDepth: z.number().int().min(0).max(16),
  })
  .strict();
export const LaunchCapabilityPayloadSchema = z
  .object({
    executableSlot: z.literal("configured-command"),
    argumentTemplate: z.array(z.string().max(4_096)).max(128),
    environmentNames: z.array(z.string().regex(EnvironmentNamePattern)).max(128),
    files: z.array(FileRecipeSchema).max(128),
    directExec: z.literal(true),
  })
  .strict();
export const StateCapabilityPayloadSchema = z
  .object({
    scopes: z
      .array(z.enum(["membership", "integration", "custom"]))
      .min(1)
      .max(3),
    defaultScope: z.enum(["membership", "integration", "custom"]),
    environmentNames: z.array(z.string().regex(EnvironmentNamePattern)).max(32),
    environmentPaths: z.record(
      z.string().regex(EnvironmentNamePattern),
      z
        .string()
        .min(11)
        .max(256)
        .refine(
          (value) =>
            value === "{stateRoot}" ||
            (value.startsWith("{stateRoot}/") &&
              value
                .slice("{stateRoot}/".length)
                .split("/")
                .every((segment) => segment !== "" && segment !== "." && segment !== "..")),
          "State environment paths must remain beneath the state root",
        ),
    ),
    cacheSubdirectories: z.array(z.string().min(1).max(128)).max(32),
    formatVersion: z.string().min(1).max(64),
    sharing: z.enum(["isolated", "integration-explicit"]),
  })
  .strict()
  .refine((payload) => payload.scopes.includes(payload.defaultScope), {
    message: "Default state scope must be supported",
  })
  .refine(
    (payload) =>
      payload.environmentNames.length === Object.keys(payload.environmentPaths).length &&
      payload.environmentNames.every((name) => Object.hasOwn(payload.environmentPaths, name)),
    {
      message: "State environment names and path templates must match exactly",
    },
  )
  .refine(
    (payload) =>
      payload.cacheSubdirectories.every((directory) =>
        Object.values(payload.environmentPaths).includes(`{stateRoot}/${directory}`),
      ),
    {
      message: "Cache subdivisions must be represented by state environment paths",
    },
  );
export const PromptCapabilityPayloadSchema = z
  .object({
    placement: z.enum(["argument-file", "argument-text", "generated-agent", "settings-file"]),
    identityTemplateId: OperationIdSchema,
    includesRoleContext: z.boolean(),
    readOnlyFloor: z.array(z.string().min(1).max(128)).max(32),
    maximumBytes: z.number().int().min(1).max(1_048_576),
  })
  .strict();
export const McpCapabilityPayloadSchema = z
  .object({
    registration: z.enum(["argument-file", "managed-environment", "generated-config"]),
    endpointPlaceholder: z.literal("NANASA_MCP_URL"),
    tokenPlaceholder: z.literal("NANASA_MCP_TOKEN"),
    loopbackOnly: z.literal(true),
    fileRecipeId: OperationIdSchema.optional(),
    adapterAssetDigest: AssetDigestSchema.optional(),
  })
  .strict();
export const ReporterCapabilityPayloadSchema = z
  .object({
    protocolMajor: z.literal(3),
    driverId: OperationIdSchema,
    sourceId: ReporterSourceIdSchema,
    reporterVersion: z.string().min(1).max(64),
    sourceAssetDigest: AssetDigestSchema,
    events: z.array(EventIdSchema).min(1).max(128),
    fieldsByEvent: z.record(EventIdSchema, z.array(EventIdSchema).max(64)),
    readinessEvents: z.array(EventIdSchema).min(1).max(16),
    waitTransports: z.array(TransportSchema).max(8),
    rootSessionPolicy: z.enum(["single", "qualified-root", "none"]),
    sequencing: z.literal("monotonic"),
    permanentRejectionCodes: z.array(EventIdSchema).min(1).max(16),
  })
  .strict();
export const ControlCapabilityPayloadSchema = z
  .object({
    operations: z
      .array(
        z
          .object({
            operationId: OperationIdSchema,
            kind: z.enum(["prompt", "wait-reply", "interrupt", "cancel", "acknowledgement"]),
            transport: TransportSchema,
            codecId: OperationIdSchema,
            acknowledgement: z.enum(["none", "transport", "reporter", "operation-result"]),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export const ModelsCapabilityPayloadSchema = z
  .object({
    identifierPattern: z.string().min(1).max(256),
    launchTemplate: z.array(z.string().max(256)).max(16),
    effectiveEvidence: z.array(z.enum(["reporter", "native-session", "bounded-probe"])).max(3),
    resumePolicy: z.enum(["preserve-session", "enforce-configured"]),
  })
  .strict();
export const SessionsCapabilityPayloadSchema = z
  .object({
    referenceKinds: z
      .array(z.enum(["id", "state-contained-path"]))
      .min(1)
      .max(2),
    maximumReferenceBytes: z.number().int().min(1).max(8_192),
    normalizationVersion: z.string().min(1).max(64),
    dedupeVersion: z.string().min(1).max(64),
    resumeArgumentTemplate: z.array(z.string().min(1).max(256)).min(1).max(16),
    resumeOperationId: OperationIdSchema.optional(),
    exportOperationId: OperationIdSchema.optional(),
    deleteOperationId: OperationIdSchema.optional(),
  })
  .strict();
export const CredentialsCapabilityPayloadSchema = z
  .object({
    providerManaged: z.boolean(),
    slots: z
      .array(
        z
          .object({
            slotId: OpenIdentitySchema,
            optional: z.boolean(),
            targetNames: z.array(z.string().regex(EnvironmentNamePattern)).min(1).max(32),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export const SemanticStatusCapabilityPayloadSchema = z
  .object({
    policyId: OperationIdSchema,
    authorityOrder: z
      .array(z.enum(["reporter", "status-api", "screen", "osc", "process"]))
      .min(1)
      .max(5),
    processOnlyProjection: z.enum(["running", "unknown"]),
    maximumHintConfidence: z.enum(["low", "medium"]),
    turnCycle: z.enum(["reporter-root", "none"]),
    thresholdsMs: z.record(EventIdSchema, z.number().int().min(100).max(86_400_000)),
  })
  .strict();
export const ScreenCapabilityPayloadSchema = z
  .object({
    manifestDigest: AssetDigestSchema,
    maximumRows: z.number().int().min(1).max(80),
    maximumBytes: z.number().int().min(1).max(65_536),
    confidenceCeiling: z.enum(["low", "medium"]),
    startupGraceMs: z.number().int().min(0).max(30_000),
    confirmationCount: z.number().int().min(1).max(10),
  })
  .strict();
export const OscCapabilityPayloadSchema = z
  .object({
    classifications: z
      .array(z.enum(["title", "progress"]))
      .min(1)
      .max(2),
    maximumBytes: z.number().int().min(1).max(4_096),
    confidenceCeiling: z.enum(["low", "medium"]),
    clipboardEffects: z.literal(false),
  })
  .strict();
export const ActionsCapabilityPayloadSchema = z
  .object({
    operations: z
      .array(
        z
          .object({
            operationId: OperationIdSchema,
            kind: z.enum(["prompt", "wait-reply", "interrupt", "cancel"]),
            transport: TransportSchema,
            idempotency: z.enum(["required", "unsupported"]),
            acknowledgement: z.enum(["transport", "reporter", "operation-result"]),
          })
          .strict(),
      )
      .max(64),
    waitKinds: z.array(z.enum(["permission", "question", "elicitation", "plan-approval"])).max(16),
  })
  .strict();
export const HealthCapabilityPayloadSchema = z
  .object({
    binaryNames: z.array(z.string().min(1).max(128)).min(1).max(32),
    versionOperationId: OperationIdSchema.optional(),
    selfTestOperationId: OperationIdSchema.optional(),
    requiredReporterEvents: z.array(EventIdSchema).max(128),
  })
  .strict();
export const CompatibilityCapabilityPayloadSchema = z
  .object({
    nanasa: z.string().min(1).max(128),
    rpcMajors: z.array(z.number().int().positive()).max(16),
    providerBinary: z.string().min(1).max(128),
    operatingSystems: z
      .array(z.enum(["linux"]))
      .min(1)
      .max(1),
    architectures: z
      .array(z.enum(["x64", "arm64"]))
      .min(1)
      .max(2),
  })
  .strict();

export const ProviderCapabilityPayloadSchemas = Object.freeze({
  identity: IdentityCapabilityPayloadSchema,
  recognition: RecognitionCapabilityPayloadSchema,
  launch: LaunchCapabilityPayloadSchema,
  state: StateCapabilityPayloadSchema,
  prompt: PromptCapabilityPayloadSchema,
  mcp: McpCapabilityPayloadSchema,
  reporter: ReporterCapabilityPayloadSchema,
  control: ControlCapabilityPayloadSchema,
  models: ModelsCapabilityPayloadSchema,
  sessions: SessionsCapabilityPayloadSchema,
  credentials: CredentialsCapabilityPayloadSchema,
  "semantic-status": SemanticStatusCapabilityPayloadSchema,
  screen: ScreenCapabilityPayloadSchema,
  osc: OscCapabilityPayloadSchema,
  actions: ActionsCapabilityPayloadSchema,
  health: HealthCapabilityPayloadSchema,
  compatibility: CompatibilityCapabilityPayloadSchema,
});

export const CapabilityDeclarationSchema = z
  .object({
    id: z.string().min(1).max(128).regex(OpenIdPattern),
    required: z.boolean(),
    version: CapabilityVersionRangeSchema,
    payload: z.unknown(),
    requires: z.array(CapabilityDependencySchema).max(32).default([]),
    conflicts: z.array(ProviderCapabilityIdSchema).max(32).default([]),
  })
  .strict();
export type CapabilityDeclaration = z.infer<typeof CapabilityDeclarationSchema>;
export const HostCapabilitySupportSchema = z
  .object({ id: ProviderCapabilityIdSchema, version: CapabilityVersionRangeSchema })
  .strict();
export type HostCapabilitySupport = z.infer<typeof HostCapabilitySupportSchema>;

export const SelectedCapabilitySchema = z
  .object({
    id: ProviderCapabilityIdSchema,
    version: CapabilityVersionSchema,
    payload: z.unknown(),
  })
  .strict();
export type SelectedCapability = z.infer<typeof SelectedCapabilitySchema>;

export const IgnoredOptionalCapabilitySchema = z
  .object({ id: z.string().min(1).max(128), reason: z.enum(["unknown", "incompatible-version"]) })
  .strict();

export class CapabilityNegotiationError extends Error {
  public constructor(
    public readonly code:
      | "capability_duplicate"
      | "capability_unknown_required"
      | "capability_incompatible_required"
      | "capability_payload_invalid"
      | "capability_dependency_missing"
      | "capability_dependency_version"
      | "capability_conflict"
      | "capability_constraint",
    message: string,
  ) {
    super(message);
    this.name = "CapabilityNegotiationError";
  }
}

function capabilityMap(
  capabilities: readonly SelectedCapability[],
): Map<ProviderCapabilityId, SelectedCapability> {
  return new Map(capabilities.map((capability) => [capability.id, capability]));
}

function assertUniqueOperationIds(capability: SelectedCapability | undefined): void {
  if (capability === undefined) return;
  const payload = capability.payload as { operations: Array<{ operationId: string }> };
  const ids = new Set<string>();
  for (const operation of payload.operations) {
    if (ids.has(operation.operationId)) {
      throw new CapabilityNegotiationError(
        "capability_constraint",
        `Duplicate operation ID ${operation.operationId} in ${capability.id}`,
      );
    }
    ids.add(operation.operationId);
  }
}

export function assertCapabilityConstraints(capabilities: readonly SelectedCapability[]): void {
  const selected = capabilityMap(capabilities);
  if (!selected.has("identity")) {
    throw new CapabilityNegotiationError("capability_dependency_missing", "identity is required");
  }
  assertUniqueOperationIds(selected.get("control"));
  assertUniqueOperationIds(selected.get("actions"));

  const sessions = selected.get("sessions")?.payload as
    | { resumeOperationId?: string; exportOperationId?: string; deleteOperationId?: string }
    | undefined;
  const control = selected.get("control")?.payload as
    | {
        operations: Array<{
          operationId: string;
          kind: string;
          transport: string;
          acknowledgement: string;
        }>;
      }
    | undefined;
  const reporter = selected.get("reporter")?.payload as
    | { waitTransports: string[]; events: string[] }
    | undefined;
  const actions = selected.get("actions")?.payload as
    | {
        operations: Array<{
          operationId: string;
          kind: string;
          transport: string;
          acknowledgement: string;
        }>;
      }
    | undefined;
  const controlById = new Map(
    control?.operations.map((operation) => [operation.operationId, operation]),
  );
  for (const operationId of [
    sessions?.resumeOperationId,
    sessions?.exportOperationId,
    sessions?.deleteOperationId,
  ]) {
    if (operationId !== undefined && !controlById.has(operationId)) {
      throw new CapabilityNegotiationError(
        "capability_constraint",
        `Session operation ${operationId} has no control executor`,
      );
    }
  }
  for (const operation of actions?.operations ?? []) {
    const executor = controlById.get(operation.operationId);
    if (
      executor === undefined ||
      executor.kind !== operation.kind ||
      executor.transport !== operation.transport ||
      executor.acknowledgement !== operation.acknowledgement
    ) {
      throw new CapabilityNegotiationError(
        "capability_constraint",
        `Action operation ${operation.operationId} has no matching control executor`,
      );
    }
    if (operation.kind === "wait-reply") {
      if (reporter === undefined || !reporter.waitTransports.includes(operation.transport)) {
        throw new CapabilityNegotiationError(
          "capability_constraint",
          `Wait transport ${operation.transport} is not observed by reporter capability`,
        );
      }
    }
  }
  const models = selected.get("models")?.payload as { effectiveEvidence: string[] } | undefined;
  if (models?.effectiveEvidence.includes("reporter") === true && reporter === undefined) {
    throw new CapabilityNegotiationError(
      "capability_dependency_missing",
      "Reporter effective-model evidence requires reporter capability",
    );
  }
  if (models?.effectiveEvidence.includes("native-session") === true && sessions === undefined) {
    throw new CapabilityNegotiationError(
      "capability_dependency_missing",
      "Native-session model evidence requires sessions capability",
    );
  }
  const status = selected.get("semantic-status")?.payload as
    | { maximumHintConfidence: "low" | "medium" }
    | undefined;
  const confidenceRank = { low: 0, medium: 1 } as const;
  for (const id of ["screen", "osc"] as const) {
    const observer = selected.get(id)?.payload as
      | { confidenceCeiling: "low" | "medium" }
      | undefined;
    if (observer !== undefined && status === undefined) {
      throw new CapabilityNegotiationError(
        "capability_dependency_missing",
        `${id} requires semantic-status capability`,
      );
    }
    if (
      observer !== undefined &&
      status !== undefined &&
      confidenceRank[observer.confidenceCeiling] > confidenceRank[status.maximumHintConfidence]
    ) {
      throw new CapabilityNegotiationError(
        "capability_constraint",
        `${id} confidence exceeds semantic-status ceiling`,
      );
    }
  }
}

export const CapabilityNegotiationResultSchema = z
  .object({
    selected: z.array(SelectedCapabilitySchema).min(1).max(PROVIDER_CAPABILITY_IDS.length),
    ignoredOptional: z.array(IgnoredOptionalCapabilitySchema).max(128),
  })
  .strict();
export type CapabilityNegotiationResult = z.infer<typeof CapabilityNegotiationResultSchema>;

export function negotiateProviderCapabilities(
  declarationsInput: readonly CapabilityDeclaration[],
  hostInput: readonly HostCapabilitySupport[],
): CapabilityNegotiationResult {
  const declarations = declarationsInput.map((declaration) =>
    CapabilityDeclarationSchema.parse(declaration),
  );
  const host = new Map(
    hostInput.map((support) => {
      const parsed = HostCapabilitySupportSchema.parse(support);
      return [parsed.id, parsed.version] as const;
    }),
  );
  const seen = new Set<string>();
  const selected: SelectedCapability[] = [];
  const ignoredOptional: Array<{ id: string; reason: "unknown" | "incompatible-version" }> = [];
  const declarationsById = new Map<string, CapabilityDeclaration>();
  for (const declaration of declarations) {
    if (seen.has(declaration.id)) {
      throw new CapabilityNegotiationError(
        "capability_duplicate",
        `Duplicate capability ${declaration.id}`,
      );
    }
    seen.add(declaration.id);
    declarationsById.set(declaration.id, declaration);
    const payloadSchema = Object.hasOwn(ProviderCapabilityPayloadSchemas, declaration.id)
      ? ProviderCapabilityPayloadSchemas[declaration.id as ProviderCapabilityId]
      : undefined;
    const supported = host.get(declaration.id as ProviderCapabilityId);
    if (payloadSchema === undefined || supported === undefined) {
      if (declaration.required) {
        throw new CapabilityNegotiationError(
          "capability_unknown_required",
          `Required capability ${declaration.id} is not supported`,
        );
      }
      ignoredOptional.push({ id: declaration.id, reason: "unknown" });
      continue;
    }
    if (supported.major !== declaration.version.major) {
      if (declaration.required) {
        throw new CapabilityNegotiationError(
          "capability_incompatible_required",
          `Required capability ${declaration.id} has no compatible major`,
        );
      }
      ignoredOptional.push({ id: declaration.id, reason: "incompatible-version" });
      continue;
    }
    const minimum = Math.max(supported.minimumMinor, declaration.version.minimumMinor);
    const maximum = Math.min(supported.maximumMinor, declaration.version.maximumMinor);
    if (minimum > maximum) {
      if (declaration.required) {
        throw new CapabilityNegotiationError(
          "capability_incompatible_required",
          `Required capability ${declaration.id} has no compatible minor`,
        );
      }
      ignoredOptional.push({ id: declaration.id, reason: "incompatible-version" });
      continue;
    }
    const payload = payloadSchema.safeParse(declaration.payload);
    if (!payload.success) {
      throw new CapabilityNegotiationError(
        "capability_payload_invalid",
        `Capability ${declaration.id} payload is invalid: ${payload.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    selected.push({
      id: declaration.id as ProviderCapabilityId,
      version: { major: supported.major, minor: maximum },
      payload: payload.data,
    });
  }
  const selectedById = capabilityMap(selected);
  for (const capability of selected) {
    const declaration = declarationsById.get(capability.id);
    for (const requirement of declaration?.requires ?? []) {
      const dependency = selectedById.get(requirement.id);
      if (dependency === undefined) {
        throw new CapabilityNegotiationError(
          "capability_dependency_missing",
          `${capability.id} requires ${requirement.id}`,
        );
      }
      if (
        dependency.version.major !== requirement.version.major ||
        dependency.version.minor < requirement.version.minimumMinor ||
        dependency.version.minor > requirement.version.maximumMinor
      ) {
        throw new CapabilityNegotiationError(
          "capability_dependency_version",
          `${capability.id} requires a different ${requirement.id} version`,
        );
      }
    }
    for (const conflict of declaration?.conflicts ?? []) {
      if (selectedById.has(conflict)) {
        throw new CapabilityNegotiationError(
          "capability_conflict",
          `${capability.id} conflicts with ${conflict}`,
        );
      }
    }
  }
  assertCapabilityConstraints(selected);
  return CapabilityNegotiationResultSchema.parse({
    selected: [...selected].sort((left, right) => left.id.localeCompare(right.id)),
    ignoredOptional: [...ignoredOptional].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export const ProviderGrantSchema = z.discriminatedUnion("permission", [
  z
    .object({
      permission: z.literal("provider-state.read-managed"),
      parameters: z
        .object({
          scopes: z
            .array(z.enum(["membership", "integration", "custom"]))
            .min(1)
            .max(3),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      permission: z.literal("provider-state.write-owned"),
      parameters: z.object({ recipeIds: z.array(OperationIdSchema).min(1).max(128) }).strict(),
    })
    .strict(),
  z
    .object({
      permission: z.literal("runtime.launch"),
      parameters: z
        .object({ executableNames: z.array(z.string().min(1).max(128)).min(1).max(32) })
        .strict(),
    })
    .strict(),
  z
    .object({
      permission: z.literal("network.connect"),
      parameters: z
        .object({
          origins: z
            .array(
              z
                .string()
                .url()
                .refine(
                  (value) =>
                    new URL(value).hostname === "127.0.0.1" ||
                    new URL(value).hostname === "localhost",
                  "Only loopback network origins are allowed",
                ),
            )
            .min(1)
            .max(16),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      permission: z.literal("reporter.emit"),
      parameters: z
        .object({
          sourceId: ReporterSourceIdSchema,
          events: z.array(EventIdSchema).min(1).max(128),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      permission: z.literal("terminal.operate"),
      parameters: z.object({ operationIds: z.array(OperationIdSchema).min(1).max(64) }).strict(),
    })
    .strict(),
  z
    .object({
      permission: z.literal("credential.inject"),
      parameters: z
        .object({
          slotIds: z.array(OpenIdentitySchema).min(1).max(32),
          targetNames: z.array(z.string().regex(EnvironmentNamePattern)).min(1).max(128),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      permission: z.literal("provider.operation"),
      parameters: z.object({ operationIds: z.array(OperationIdSchema).min(1).max(64) }).strict(),
    })
    .strict(),
]);
export type ProviderGrant = z.infer<typeof ProviderGrantSchema>;

function assertGrantConstraints(
  capabilities: readonly SelectedCapability[],
  grants: readonly ProviderGrant[],
): void {
  const selected = capabilityMap(capabilities);
  const control = selected.get("control")?.payload as
    | { operations: Array<{ operationId: string }> }
    | undefined;
  const reporter = selected.get("reporter")?.payload as
    | { sourceId: string; events: string[] }
    | undefined;
  const credentials = selected.get("credentials")?.payload as
    | { slots: Array<{ slotId: string; targetNames: string[] }> }
    | undefined;
  const controlOperations = new Set(control?.operations.map((operation) => operation.operationId));
  const credentialSlots = new Map(
    credentials?.slots.map((slot) => [slot.slotId, new Set(slot.targetNames)]),
  );
  for (const grant of grants) {
    if (
      (grant.permission === "provider-state.read-managed" ||
        grant.permission === "provider-state.write-owned") &&
      !selected.has("state")
    ) {
      throw new CapabilityNegotiationError(
        "capability_constraint",
        `${grant.permission} requires state capability`,
      );
    }
    if (grant.permission === "runtime.launch" && !selected.has("launch")) {
      throw new CapabilityNegotiationError(
        "capability_constraint",
        "runtime.launch requires launch capability",
      );
    }
    if (grant.permission === "network.connect" && !selected.has("mcp")) {
      throw new CapabilityNegotiationError(
        "capability_constraint",
        "network.connect requires mcp capability",
      );
    }
    if (grant.permission === "reporter.emit") {
      if (
        reporter === undefined ||
        reporter.sourceId !== grant.parameters.sourceId ||
        grant.parameters.events.some((event) => !reporter.events.includes(event))
      ) {
        throw new CapabilityNegotiationError(
          "capability_constraint",
          "reporter.emit exceeds reporter capability",
        );
      }
    }
    if (
      (grant.permission === "terminal.operate" || grant.permission === "provider.operation") &&
      grant.parameters.operationIds.some((operationId) => !controlOperations.has(operationId))
    ) {
      throw new CapabilityNegotiationError(
        "capability_constraint",
        `${grant.permission} names an unavailable operation`,
      );
    }
    if (grant.permission === "credential.inject") {
      if (
        grant.parameters.slotIds.some((slotId) => !credentialSlots.has(slotId)) ||
        grant.parameters.targetNames.some(
          (target) =>
            !grant.parameters.slotIds.some(
              (slotId) => credentialSlots.get(slotId)?.has(target) === true,
            ),
        )
      ) {
        throw new CapabilityNegotiationError(
          "capability_constraint",
          "credential.inject exceeds credential capability",
        );
      }
    }
  }
}

export const ImmutableAssetReferenceSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (path) =>
          !path.includes("\0") &&
          !path.includes("\\") &&
          !path.startsWith("/") &&
          !/^[A-Za-z]:/.test(path) &&
          path
            .split("/")
            .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
        "Asset paths must be normalized relative paths without traversal",
      ),
    mediaType: z.string().min(1).max(128),
    bytes: z.number().int().positive().max(16_777_216),
    digest: AssetDigestSchema,
  })
  .strict();

export const ResolvedProviderAdapterSnapshotBodySchema = z
  .object({
    formatVersion: z.literal(2),
    manifestProtocol: CapabilityVersionSchema,
    adapterProtocol: CapabilityVersionSchema,
    packageDigest: SnapshotDigestSchema,
    compilerDigest: SnapshotDigestSchema.optional(),
    providerId: ProviderIdSchema,
    adapterId: AdapterIdSchema,
    extensionId: ProviderExtensionIdSchema,
    extensionGeneration: z.string().min(1).max(128),
    interpreterVersions: z.record(z.string().min(1).max(64), z.string().min(1).max(64)),
    capabilities: z.array(SelectedCapabilitySchema).min(1).max(PROVIDER_CAPABILITY_IDS.length),
    grants: z.array(ProviderGrantSchema).max(128),
    assets: z.array(ImmutableAssetReferenceSchema).max(256),
    providerBinaryCompatibility: z
      .object({
        state: z.enum(["compatible", "degraded", "unavailable"]),
        range: z.string().min(1).max(128),
        observedVersion: z.string().min(1).max(128).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    try {
      const capabilityIds = new Set<string>();
      for (const capability of snapshot.capabilities) {
        if (capabilityIds.has(capability.id)) {
          throw new CapabilityNegotiationError(
            "capability_duplicate",
            `Duplicate capability ${capability.id}`,
          );
        }
        capabilityIds.add(capability.id);
        ProviderCapabilityPayloadSchemas[capability.id].parse(capability.payload);
      }
      assertCapabilityConstraints(snapshot.capabilities);
      assertGrantConstraints(snapshot.capabilities, snapshot.grants);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid capability constraints",
        path: ["capabilities"],
      });
    }
    const identity = snapshot.capabilities.find((capability) => capability.id === "identity")
      ?.payload as z.infer<typeof IdentityCapabilityPayloadSchema> | undefined;
    if (
      identity !== undefined &&
      (identity.providerId !== snapshot.providerId ||
        identity.adapterId !== snapshot.adapterId ||
        identity.extensionId !== snapshot.extensionId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Snapshot identity does not match identity capability",
        path: ["capabilities"],
      });
    }
    for (const key of ["capabilities", "grants", "assets"] as const) {
      const values = snapshot[key].map((item) => JSON.stringify(item));
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: `${key} must not contain duplicates`,
          path: [key],
        });
      }
    }
  });
export type ResolvedProviderAdapterSnapshotBody = z.infer<
  typeof ResolvedProviderAdapterSnapshotBodySchema
>;

const SnapshotSetLikePaths = ["/capabilities", "/grants", "/assets"] as const;

export function canonicalProviderSnapshotBytes(input: unknown): Uint8Array {
  const snapshot = ResolvedProviderAdapterSnapshotBodySchema.parse(input);
  return canonicalJsonBytes(snapshot, { setLikePaths: SnapshotSetLikePaths });
}

export async function digestProviderSnapshot(input: unknown): Promise<string> {
  const bytes = canonicalProviderSnapshotBytes(input);
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64Url(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export const ResolvedProviderAdapterSnapshotSchema = z
  .object({
    digest: SnapshotDigestSchema,
    canonicalBytes: z
      .string()
      .min(1)
      .max(16_777_216)
      .regex(/^[A-Za-z0-9_-]+$/),
    body: ResolvedProviderAdapterSnapshotBodySchema,
  })
  .strict();

export async function parseResolvedProviderAdapterSnapshot(
  input: unknown,
): Promise<z.infer<typeof ResolvedProviderAdapterSnapshotSchema>> {
  const snapshot = ResolvedProviderAdapterSnapshotSchema.parse(input);
  const canonicalBytes = canonicalProviderSnapshotBytes(snapshot.body);
  if (!equalBytes(decodeBase64Url(snapshot.canonicalBytes), canonicalBytes)) {
    throw new Error("Snapshot canonical bytes do not match its body");
  }
  if ((await digestProviderSnapshot(snapshot.body)) !== snapshot.digest) {
    throw new Error("Snapshot digest does not match its canonical bytes");
  }
  return snapshot;
}

export const RunProviderLaunchSelectionSchema = z
  .object({
    configuredCommand: z.array(z.string().min(1).max(4_096)).min(1).max(256),
    providerArgumentStrategy: ProviderArgumentStrategySchema.optional(),
    command: z.array(z.string().min(1).max(4_096)).min(1).max(256),
    overlayArguments: z.array(z.string().min(1).max(4_096)).max(256),
    environmentNames: z.array(z.string().regex(EnvironmentNamePattern)).max(256),
    stateStorageReference: z.string().min(1).max(4_096),
    workingDirectory: z.string().min(1).max(4_096).optional(),
    desiredModel: z.string().min(1).max(256).optional(),
    modelResumePolicy: z.enum(["preserve-session", "enforce-configured"]),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.environmentNames).size !== selection.environmentNames.length) {
      context.addIssue({
        code: "custom",
        message: "Launch environment names must be unique",
        path: ["environmentNames"],
      });
    }
    if (
      [...selection.environmentNames]
        .sort((left, right) => left.localeCompare(right))
        .some((name, index) => name !== selection.environmentNames[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Launch environment names must use canonical order",
        path: ["environmentNames"],
      });
    }
  });
export type RunProviderLaunchSelection = z.infer<typeof RunProviderLaunchSelectionSchema>;

export const RunProviderBindingSchema = z
  .object({
    id: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    generation: RunGenerationSchema,
    integrationId: ProviderIntegrationIdSchema,
    providerId: ProviderIdSchema,
    adapterId: AdapterIdSchema,
    snapshotDigest: SnapshotDigestSchema,
    activationId: z.string().min(1).max(128),
    processRecognitionDigest: SnapshotDigestSchema,
    statusPolicyDigest: StatusPolicyDigestSchema,
    providerStateId: z.string().min(1).max(128),
    overlayId: z.string().min(1).max(128),
    credentialSlots: z.record(OpenIdentitySchema, z.string().min(1).max(128)),
    launchPlan: RunProviderLaunchSelectionSchema,
    launchDigest: SnapshotDigestSchema,
    permissionFloorDigest: SnapshotDigestSchema,
    repositoryTrustDigest: SnapshotDigestSchema,
    providerBinary: z
      .object({
        state: z.enum(["compatible", "degraded", "unavailable"]),
        range: z.string().min(1).max(128),
        observedVersion: z.string().min(1).max(128).optional(),
      })
      .strict(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type RunProviderBinding = z.infer<typeof RunProviderBindingSchema>;

export const RunProviderBindingFenceSchema = z
  .object({
    runId: z.string().min(1).max(128),
    generation: RunGenerationSchema,
    bindingId: z.string().min(1).max(128),
    providerId: ProviderIdSchema,
    snapshotDigest: SnapshotDigestSchema,
  })
  .strict();
export type RunProviderBindingFence = z.infer<typeof RunProviderBindingFenceSchema>;

export const ProviderProcessIncarnationSchema = z
  .object({
    digest: ProcessIncarnationDigestSchema,
    fence: RunProviderBindingFenceSchema,
    paneId: z.string().min(1).max(128),
    foregroundPgid: z.number().int().positive(),
    leaderPid: z.number().int().positive(),
    pidStartIdentity: z.string().min(1).max(128),
    observedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type ProviderProcessIncarnation = z.infer<typeof ProviderProcessIncarnationSchema>;

export const ProviderAuthorityFenceSchema = RunProviderBindingFenceSchema.extend({
  processIncarnationDigest: ProcessIncarnationDigestSchema,
}).strict();
export type ProviderAuthorityFence = z.infer<typeof ProviderAuthorityFenceSchema>;

export const ProviderStateRecordSchema = z
  .object({
    id: z.string().min(1).max(128),
    integrationId: ProviderIntegrationIdSchema,
    providerId: ProviderIdSchema,
    snapshotDigest: SnapshotDigestSchema,
    stateFormatVersion: z.string().min(1).max(64),
    memberId: z.string().min(1).max(128).optional(),
    scope: z.enum(["membership", "integration", "custom"]),
    storageReference: z.string().min(1).max(4_096),
    credentialSlotReferences: z.record(OpenIdentitySchema, z.string().min(1).max(128)),
    lifecycle: z.enum(["active", "retained", "deleting", "deleted"]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const ProviderGeneratedOverlaySchema = z
  .object({
    id: z.string().min(1).max(128),
    fence: RunProviderBindingFenceSchema,
    providerStateId: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    recipeDigest: SnapshotDigestSchema,
    assetDigest: SnapshotDigestSchema,
    contentDigest: SnapshotDigestSchema,
    ownershipManifestDigest: SnapshotDigestSchema,
    state: z.enum(["staged", "active", "replaced", "failed"]),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProviderGeneratedOverlay = z.infer<typeof ProviderGeneratedOverlaySchema>;

export const ProviderNativeSessionSchema = z
  .object({
    id: z.string().min(1).max(128),
    fence: ProviderAuthorityFenceSchema,
    memberId: z.string().min(1).max(128),
    integrationId: ProviderIntegrationIdSchema,
    providerId: ProviderIdSchema,
    referenceKind: z.enum(["id", "state-contained-path"]),
    opaqueReference: z.string().min(1).max(4_096),
    normalizationVersion: z.string().min(1).max(64),
    dedupeVersion: z.string().min(1).max(64),
    dedupeDigest: SnapshotDigestSchema,
    resumeCompatibility: z.enum(["compatible", "incompatible"]),
    status: z.enum(["ready", "reserved", "resumed", "invalid"]),
    reportedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.providerId !== session.fence.providerId) {
      context.addIssue({
        code: "custom",
        message: "Native session provider must match its authority fence",
        path: ["providerId"],
      });
    }
  });

export const ProviderTrustReceiptSchema = z
  .object({
    id: z.string().min(1).max(128),
    providerId: ProviderIdSchema,
    packageDigest: SnapshotDigestSchema,
    snapshotDigest: SnapshotDigestSchema,
    capabilityDigest: SnapshotDigestSchema,
    launchDigest: SnapshotDigestSchema,
    repositoryDigest: SnapshotDigestSchema,
    grantDigest: SnapshotDigestSchema,
    principalId: z.string().min(1).max(128),
    decision: z.enum(["trusted", "denied", "revoked"]),
    decidedAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export function assertSameProviderAuthority(
  expectedInput: unknown,
  actualInput: unknown,
): ProviderAuthorityFence {
  const expected = ProviderAuthorityFenceSchema.parse(expectedInput);
  const actual = ProviderAuthorityFenceSchema.parse(actualInput);
  for (const field of [
    "runId",
    "generation",
    "bindingId",
    "providerId",
    "snapshotDigest",
    "processIncarnationDigest",
  ] as const) {
    if (expected[field] !== actual[field]) {
      throw new Error(`Provider authority fence mismatch: ${field}`);
    }
  }
  return actual;
}

export const ProviderRuntimeIndexEntrySchema = z
  .object({
    indexGeneration: z.number().int().positive(),
    providerId: ProviderIdSchema,
    extensionGeneration: z.string().min(1).max(128),
    snapshotDigest: SnapshotDigestSchema,
    grantDigest: SnapshotDigestSchema,
    state: z.enum(["active", "disabled", "revoked"]),
    activatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const ProviderHealthStateSchema = z.enum([
  "discovered",
  "imported",
  "verified",
  "resolved",
  "trusted",
  "active",
  "selected",
  "incompatible",
  "revoked",
  "quarantined",
  "disabled",
  "unavailable",
]);
export const ProviderRuntimeHealthSchema = z
  .object({
    providerId: ProviderIdSchema,
    extensionId: ProviderExtensionIdSchema,
    snapshotDigest: SnapshotDigestSchema.optional(),
    state: ProviderHealthStateSchema,
    checkedAt: z.string().datetime({ offset: true }),
    diagnostics: z
      .array(
        z
          .object({
            code: EventIdSchema,
            message: z.string().min(1).max(1_000),
            retryable: z.boolean(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
