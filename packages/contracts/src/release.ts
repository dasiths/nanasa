import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith("/"));

export const ReleaseChannelSchema = z.enum(["next", "latest"]);
export const BuildIdentitySchema = z
  .object({
    packageName: z.literal("nanasa"),
    packageVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    channel: ReleaseChannelSchema,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    builtAt: z.string().datetime({ offset: true }),
    databaseSchema: z
      .object({ minimum: z.number().int().positive(), maximum: z.number().int().positive() })
      .strict(),
    configVersion: z.literal(2),
    apiVersion: z.literal(1),
    eventProtocolVersion: z.literal(1),
    terminalProtocolVersion: z.literal(1),
    node: z.literal(">=22 <23 || >=24 <25"),
    hosts: z.array(z.enum(["linux-x64", "linux-arm64"])).length(2),
    tmux: z.literal(">=3.2"),
    terminalHelper: z.object({ name: z.literal("node-pty"), version: z.literal("1.1.0") }).strict(),
    xterm: z.object({ name: z.literal("@xterm/xterm"), version: z.literal("6.0.0") }).strict(),
    browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).length(3),
    portalAssetDigest: DigestSchema,
  })
  .strict();

export const BackupArtifactSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    sha256: DigestSchema,
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export const BackupManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    backupId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    package: BuildIdentitySchema.pick({ packageVersion: true, commit: true, channel: true }).extend(
      {
        packageRoot: AbsolutePathSchema,
      },
    ),
    databaseSchema: z.number().int().positive(),
    configRevision: DigestSchema,
    extensionLockRevision: DigestSchema,
    providerOverlayRevisions: z.record(z.string(), DigestSchema),
    artifacts: z.array(BackupArtifactSchema).min(3),
  })
  .strict();

export const ActivationManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    activationId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    from: BuildIdentitySchema.pick({ packageVersion: true, commit: true }),
    to: BuildIdentitySchema.pick({ packageVersion: true, commit: true }),
    packagePointer: BackupArtifactSchema,
    database: BackupArtifactSchema,
    config: BackupArtifactSchema,
    extensionLock: BackupArtifactSchema,
    overlays: z.array(BackupArtifactSchema),
    state: z.enum(["staged", "activating", "ready", "rolling-back", "rolled-back", "failed"]),
  })
  .strict();

export const ServiceStateSchema = z.enum([
  "unsupported",
  "not-installed",
  "inactive",
  "starting",
  "ready",
  "failed",
  "stopping",
]);
export const ServiceDescriptorSchema = z
  .object({
    formatVersion: z.literal(1),
    repositoryId: z.string().min(1).max(128),
    instanceName: z.string().regex(/^nanasa-[a-f0-9]{20}$/),
    unitName: z.string().regex(/^nanasa-[a-f0-9]{20}\.service$/),
    repositoryRoot: AbsolutePathSchema,
    packageRoot: AbsolutePathSchema,
    nodePath: AbsolutePathSchema,
    cliPath: AbsolutePathSchema,
    portalUrl: z.string().url(),
    state: ServiceStateSchema,
    detail: z.string().max(2_000),
    killMode: z.literal("process"),
    lastActivation: ActivationManifestSchema.pick({
      activationId: true,
      createdAt: true,
      from: true,
      to: true,
      state: true,
    }).optional(),
  })
  .strict();

export const RemoteDescriptorSchema = z
  .object({
    formatVersion: z.literal(1),
    repositoryId: z.string().min(1).max(128),
    instanceId: z.string().min(1).max(128),
    build: BuildIdentitySchema.pick({ packageVersion: true, commit: true }),
    apiVersion: z.literal(1),
    eventProtocolVersion: z.literal(1),
    terminalProtocolVersion: z.literal(1),
    service: ServiceDescriptorSchema.pick({ instanceName: true, unitName: true, state: true }),
    loopbackHost: z.enum(["127.0.0.1", "::1"]),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();

export const BrowserRestartFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("service.restart"),
    reason: z.enum(["upgrade", "rollback", "operator-restart"]),
    instanceId: z.string().min(1).max(128),
    retryAfterMs: z.number().int().min(100).max(30_000),
    resnapshotRequired: z.literal(true),
    terminalHandoff: z.literal(false),
  })
  .strict();

export type BuildIdentity = z.infer<typeof BuildIdentitySchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
export type ActivationManifest = z.infer<typeof ActivationManifestSchema>;
export type ServiceDescriptor = z.infer<typeof ServiceDescriptorSchema>;
export type RemoteDescriptor = z.infer<typeof RemoteDescriptorSchema>;
export type BrowserRestartFrame = z.infer<typeof BrowserRestartFrameSchema>;
