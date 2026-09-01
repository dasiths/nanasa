import { z } from "zod";
import {
  AdapterIdSchema,
  IntegrationIdV3Schema,
  ProcessIncarnationDigestSchema,
  ProviderIdSchema,
  SnapshotDigestSchema,
} from "./provider-runtime-v2.js";

export const CONTROL_API_V2 = 2 as const;
export const ControlMetadataV2Schema = z
  .object({
    apiVersion: z.literal(CONTROL_API_V2),
    eventProtocolVersion: z.literal(2),
    reporterProtocolVersion: z.literal(3),
    configVersion: z.literal(3),
    databaseSchemaVersion: z.number().int().positive(),
    productVersion: z.string().min(1).max(100),
    buildCommit: z.string().regex(/^[a-f0-9]{40}$/),
    repositoryId: z.string().min(1).max(128),
    instanceId: z.string().min(1).max(128),
    daemonEpoch: z.number().int().positive(),
    lifecycle: z.enum(["starting", "ready", "draining"]),
    remoteAccess: z.literal("loopback-only"),
  })
  .strict();

export const AgentProfileV2Schema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(100),
    integrationId: IntegrationIdV3Schema,
    providerId: ProviderIdSchema,
    command: z.string().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(128),
    workingDirectory: z.string().min(1).max(4_096).optional(),
    environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(128),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const AgentRunV2Schema = z
  .object({
    id: z.string().min(1).max(128),
    groupId: z.string().min(1).max(128),
    memberId: z.string().min(1).max(128),
    agentProfileId: z.string().min(1).max(128),
    generation: z.number().int().positive(),
    integrationId: IntegrationIdV3Schema,
    providerId: ProviderIdSchema,
    adapterId: AdapterIdSchema,
    bindingId: z.string().min(1).max(128),
    snapshotDigest: SnapshotDigestSchema,
    processIncarnationDigest: ProcessIncarnationDigestSchema.optional(),
    status: z.enum(["starting", "running", "stopping", "stopped", "failed"]),
    desiredState: z.enum(["running", "stopped"]),
    recoveryPhase: z.enum(["idle", "reconciling", "resuming", "restarting", "recovered", "failed"]),
    requestedModel: z.string().min(1).max(256).optional(),
    effectiveModel: z.string().min(1).max(256).optional(),
    effectiveModelSource: z
      .enum(["provider-report", "native-session", "bounded-probe", "unavailable"])
      .optional(),
    nativeSessionId: z.string().min(1).max(128).optional(),
    startedAt: z.string().datetime({ offset: true }),
    stoppedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ProviderBindingInspectionV2Schema = z
  .object({
    run: AgentRunV2Schema,
    packageDigest: SnapshotDigestSchema,
    activationId: z.string().min(1).max(128),
    statusPolicyDigest: SnapshotDigestSchema,
    launchDigest: SnapshotDigestSchema,
    overlayDigest: SnapshotDigestSchema,
    trustDigest: SnapshotDigestSchema,
    grantsDigest: SnapshotDigestSchema,
    recoverable: z.boolean(),
    diagnostics: z.array(z.string().min(1).max(1_000)).max(64),
  })
  .strict();
