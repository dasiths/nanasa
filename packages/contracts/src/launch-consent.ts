import { z } from "zod";
import { ProviderArgumentStrategySchema, RolePermissionPolicySchema } from "./config.js";
import {
  AgentRunSchema,
  ConfiguredAgentIdSchema,
  IdentifierSchema,
  TimestampSchema,
} from "./control.js";
import { Sha256DigestSchema } from "./extensions.js";
import {
  AgentKindSchema,
  CredentialProfileReferenceSchema,
  IntegrationIdSchema,
} from "./provider.js";

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const CustomLaunchConsentLauncherFileSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    digest: Sha256DigestSchema,
  })
  .strict();
export type CustomLaunchConsentLauncherFile = z.infer<typeof CustomLaunchConsentLauncherFileSchema>;

export const CustomLaunchConsentSubjectSchema = z
  .object({
    repositoryIdentity: IdentifierSchema,
    integrationId: IntegrationIdSchema,
    providerKind: AgentKindSchema,
    adapterId: z.string().trim().min(1).max(128),
    adapterSecurityVersion: z.string().trim().min(1).max(128),
    configuredCommand: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    launcher: ProviderArgumentStrategySchema,
    launcherFiles: z.array(CustomLaunchConsentLauncherFileSchema).max(64),
    workingDirectory: z.string().min(1).max(4_096).optional(),
    environmentNames: z.array(EnvironmentNameSchema).max(128),
    credentialReference: CredentialProfileReferenceSchema,
    permissionFloor: RolePermissionPolicySchema,
    permissionFloorCapability: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((subject, context) => {
    if (new Set(subject.environmentNames).size !== subject.environmentNames.length) {
      context.addIssue({
        code: "custom",
        message: "Environment names must be unique",
        path: ["environmentNames"],
      });
    }
    const launcherPaths = subject.launcherFiles.map((file) => file.path);
    if (new Set(launcherPaths).size !== launcherPaths.length) {
      context.addIssue({
        code: "custom",
        message: "Launcher file paths must be unique",
        path: ["launcherFiles"],
      });
    }
    if (
      subject.permissionFloor === "read-only" &&
      subject.permissionFloorCapability === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Read-only custom launches require an adapter permission-floor capability",
        path: ["permissionFloorCapability"],
      });
    }
  });
export type CustomLaunchConsentSubject = z.infer<typeof CustomLaunchConsentSubjectSchema>;

export const CustomLaunchConsentRequestStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "cancelled",
  "stale",
]);
export type CustomLaunchConsentRequestState = z.infer<typeof CustomLaunchConsentRequestStateSchema>;

export const CustomLaunchConsentRequestSchema = z
  .object({
    id: IdentifierSchema,
    repositoryIdentity: IdentifierSchema,
    groupId: IdentifierSchema,
    agentId: ConfiguredAgentIdSchema,
    memberId: IdentifierSchema,
    integrationId: IntegrationIdSchema,
    subjectDigest: Sha256DigestSchema,
    configRevision: Sha256DigestSchema,
    subject: CustomLaunchConsentSubjectSchema,
    state: CustomLaunchConsentRequestStateSchema,
    requestedAt: TimestampSchema,
    decidedAt: TimestampSchema.optional(),
    decidedBy: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.repositoryIdentity !== request.subject.repositoryIdentity) {
      context.addIssue({
        code: "custom",
        message: "Request repository identity must match its consent subject",
        path: ["repositoryIdentity"],
      });
    }
    if (request.integrationId !== request.subject.integrationId) {
      context.addIssue({
        code: "custom",
        message: "Request integration ID must match its consent subject",
        path: ["integrationId"],
      });
    }
  });
export type CustomLaunchConsentRequest = z.infer<typeof CustomLaunchConsentRequestSchema>;

export const CustomLaunchConsentDecisionSchema = z
  .object({
    id: IdentifierSchema,
    repositoryIdentity: IdentifierSchema,
    subjectDigest: Sha256DigestSchema,
    principalId: IdentifierSchema,
    decision: z.enum(["trusted", "denied", "revoked"]),
    decidedAt: TimestampSchema,
    revokedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.decision === "revoked" && receipt.revokedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "Revoked consent decisions require a revocation timestamp",
        path: ["revokedAt"],
      });
    }
  });
export type CustomLaunchConsentDecision = z.infer<typeof CustomLaunchConsentDecisionSchema>;

export const CustomLaunchConsentDecisionResultSchema = z
  .object({
    request: CustomLaunchConsentRequestSchema,
    decision: CustomLaunchConsentDecisionSchema,
  })
  .strict();
export type CustomLaunchConsentDecisionResult = z.infer<
  typeof CustomLaunchConsentDecisionResultSchema
>;

export const CustomLaunchConsentRequestListSchema = z
  .array(CustomLaunchConsentRequestSchema)
  .max(500);
export const CustomLaunchConsentListQuerySchema = z
  .object({ state: CustomLaunchConsentRequestStateSchema.optional() })
  .strict();
export type CustomLaunchConsentListQuery = z.infer<typeof CustomLaunchConsentListQuerySchema>;

export const CustomLaunchConsentLifecycleEventPayloadSchema = z
  .object({
    state: z.enum(["pending", "approved", "denied", "cancelled", "stale", "revoked"]),
    repositoryIdentity: IdentifierSchema,
    subjectDigest: Sha256DigestSchema,
    requestId: IdentifierSchema.optional(),
    groupId: IdentifierSchema.optional(),
    agentId: ConfiguredAgentIdSchema.optional(),
    memberId: IdentifierSchema.optional(),
    integrationId: IntegrationIdSchema.optional(),
    configRevision: Sha256DigestSchema.optional(),
    decisionId: IdentifierSchema.optional(),
  })
  .strict();
export type CustomLaunchConsentLifecycleEventPayload = z.infer<
  typeof CustomLaunchConsentLifecycleEventPayloadSchema
>;

export const CustomLaunchConsentErrorCodeSchema = z.enum([
  "launch_consent_required",
  "launch_consent_denied",
  "launch_consent_stale",
  "launch_consent_not_found",
  "launch_consent_not_pending",
  "custom_launcher_permission_floor_unsupported",
]);
export type CustomLaunchConsentErrorCode = z.infer<typeof CustomLaunchConsentErrorCodeSchema>;

const ExactCustomLaunchConsentCommandSchema = z
  .object({
    expectedSubjectDigest: Sha256DigestSchema,
    configRevision: Sha256DigestSchema,
  })
  .strict();
export const ApproveCustomLaunchConsentCommandSchema = ExactCustomLaunchConsentCommandSchema;
export const DenyCustomLaunchConsentCommandSchema = ExactCustomLaunchConsentCommandSchema;
export const CancelCustomLaunchConsentCommandSchema = ExactCustomLaunchConsentCommandSchema;
export const RevokeCustomLaunchConsentCommandSchema = z
  .object({ expectedSubjectDigest: Sha256DigestSchema })
  .strict();
export type ApproveCustomLaunchConsentCommand = z.infer<
  typeof ApproveCustomLaunchConsentCommandSchema
>;
export type DenyCustomLaunchConsentCommand = z.infer<typeof DenyCustomLaunchConsentCommandSchema>;
export type CancelCustomLaunchConsentCommand = z.infer<
  typeof CancelCustomLaunchConsentCommandSchema
>;
export type RevokeCustomLaunchConsentCommand = z.infer<
  typeof RevokeCustomLaunchConsentCommandSchema
>;

export const StartAgentRunResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started"), run: AgentRunSchema }).strict(),
  z.object({ status: z.literal("already-running"), run: AgentRunSchema }).strict(),
  z
    .object({
      status: z.literal("approval-required"),
      request: CustomLaunchConsentRequestSchema,
    })
    .strict(),
  z.object({ status: z.literal("denied"), request: CustomLaunchConsentRequestSchema }).strict(),
]);
export type StartAgentRunResult = z.infer<typeof StartAgentRunResultSchema>;
