import { z } from "zod";
import { EnvironmentSchema, IdentifierSchema, TimestampSchema } from "./control.js";

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

export const ProviderStateScopeSchema = z.enum(["membership", "integration", "custom"]);
export const ProviderStatePolicySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("membership") }).strict(),
  z.object({ scope: z.literal("integration") }).strict(),
  z
    .object({
      scope: z.literal("custom"),
      path: z.string().trim().min(1).max(4_096),
    })
    .strict(),
]);
export type ProviderStatePolicy = z.infer<typeof ProviderStatePolicySchema>;

export const CredentialProfileReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provider-managed") }).strict(),
  z
    .object({
      kind: z.literal("broker-profile"),
      profileId: IdentifierSchema,
    })
    .strict(),
]);
export type CredentialProfileReference = z.infer<typeof CredentialProfileReferenceSchema>;

export const ModelResumePolicySchema = z.enum(["preserve-session", "enforce-configured"]);
export type ModelResumePolicy = z.infer<typeof ModelResumePolicySchema>;
export const DesiredModelPolicySchema = z
  .object({
    model: z.string().trim().min(1).max(256).optional(),
    resumePolicy: ModelResumePolicySchema.default("preserve-session"),
  })
  .strict();
export type DesiredModelPolicy = z.infer<typeof DesiredModelPolicySchema>;

export const NativeRecoveryPolicySchema = z
  .object({
    mode: z.enum(["resume-or-restart", "resume-only", "restart"]),
    confirmationTimeoutSeconds: z.number().int().min(5).max(300).default(30),
  })
  .strict();
export type NativeRecoveryPolicy = z.infer<typeof NativeRecoveryPolicySchema>;

export const AgentProfileSchema = z
  .object({
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
  })
  .strict();
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const InternalCreateAgentProfileCommandSchema = AgentProfileSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InternalCreateAgentProfileCommand = z.infer<
  typeof InternalCreateAgentProfileCommandSchema
>;

export const ProviderStateBindingSchema = z
  .object({
    id: IdentifierSchema,
    integrationId: IntegrationIdSchema,
    memberId: IdentifierSchema.optional(),
    scope: ProviderStateScopeSchema,
    storageReference: z.string().trim().min(1).max(4_096),
    credentialReference: CredentialProfileReferenceSchema,
    lifecycle: z.enum(["active", "retained", "deleting", "deleted"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ProviderStateBinding = z.infer<typeof ProviderStateBindingSchema>;

export const GeneratedOverlaySchema = z
  .object({
    id: IdentifierSchema,
    bindingId: IdentifierSchema,
    revision: z.number().int().positive(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    ownershipManifestReference: z.string().trim().min(1).max(4_096),
    state: z.enum(["staged", "active", "replaced", "failed"]),
    createdAt: TimestampSchema,
  })
  .strict();
export type GeneratedOverlay = z.infer<typeof GeneratedOverlaySchema>;

export const NativeSessionReferenceSchema = z
  .object({
    provider: AgentKindSchema,
    source: z.string().trim().min(1).max(64),
    referenceKind: z.enum(["id", "path"]),
    referenceValue: z.string().trim().min(1).max(4_096),
    dedupeHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type NativeSessionReference = z.infer<typeof NativeSessionReferenceSchema>;

export const DurableNativeSessionSchema = NativeSessionReferenceSchema.extend({
  id: IdentifierSchema,
  memberId: IdentifierSchema,
  integrationId: IntegrationIdSchema,
  runId: IdentifierSchema,
  generation: z.number().int().positive(),
  effectiveModel: z.string().trim().min(1).max(256).optional(),
  status: z.enum(["ready", "reserved", "resumed", "invalid"]),
  reportedAt: TimestampSchema,
  lastResumedAt: TimestampSchema.optional(),
}).strict();
export type DurableNativeSession = z.infer<typeof DurableNativeSessionSchema>;

export const EffectiveModelObservationSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    desiredModel: z.string().trim().min(1).max(256).optional(),
    effectiveModel: z.string().trim().min(1).max(256),
    source: z.enum(["configuration", "provider-default", "native-session", "provider-report"]),
    observedAt: TimestampSchema,
  })
  .strict();
export type EffectiveModelObservation = z.infer<typeof EffectiveModelObservationSchema>;

export const ProviderAdapterDescriptorSchema = z
  .object({
    protocolVersion: z.literal(1),
    integrationId: IntegrationIdSchema,
    launchStrategy: z.string().trim().min(1).max(64),
    reporterStrategy: z.string().trim().min(1).max(64),
    nativeResumeStrategy: z.string().trim().min(1).max(64),
    credentialStrategy: z.string().trim().min(1).max(64),
  })
  .strict();

export const ProviderHealthSchema = z
  .object({
    integrationId: IntegrationIdSchema,
    state: z.enum(["healthy", "degraded", "unavailable", "unknown"]),
    checkedAt: TimestampSchema,
    diagnostics: z.array(z.string().trim().min(1).max(500)).max(32),
  })
  .strict();

export const ProviderExtensionManifestSchema = z
  .object({
    version: z.literal(1),
    id: IntegrationIdSchema,
    displayName: z.string().trim().min(1).max(100),
    release: z.string().trim().min(1).max(64),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    capabilities: z.array(z.string().trim().min(1).max(64)).max(64),
    strategies: z.array(z.string().trim().min(1).max(64)).max(32),
  })
  .strict();
