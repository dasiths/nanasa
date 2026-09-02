import { z } from "zod";
import {
  AssetDigestSchema,
  CapabilityDeclarationSchema,
  ImmutableAssetReferenceSchema,
  OpenIdentitySchema,
  ProviderExtensionIdSchema,
  ProviderGrantSchema,
  ProviderIdSchema,
  ProviderRuntimeHealthSchema,
  SnapshotDigestSchema,
} from "./provider-runtime.js";

export const PROVIDER_EXTENSION_V2_API_VERSION = "nanasa.dev/provider-extension/v2" as const;

const ReservedBuiltinProviderIds = new Set(["copilot", "claude-code", "pi", "opencode"]);

export const ProviderExtensionGenerationSchema = z
  .object({
    id: z.string().min(1).max(128),
    extensionId: ProviderExtensionIdSchema,
    version: z
      .string()
      .regex(
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
    packageDigest: SnapshotDigestSchema,
    manifestDigest: SnapshotDigestSchema,
    publisherId: OpenIdentitySchema,
    namespaceClaims: z.array(OpenIdentitySchema).min(1).max(32),
  })
  .strict();

export const ProviderPackageSignatureSchema = z
  .object({
    algorithm: z.literal("ed25519"),
    keyId: OpenIdentitySchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    signedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ProviderPackageManifestSchema = z
  .object({
    apiVersion: z.literal(PROVIDER_EXTENSION_V2_API_VERSION),
    kind: z.literal("ProviderExtension"),
    generation: ProviderExtensionGenerationSchema,
    displayName: z.string().min(1).max(100),
    description: z.string().min(1).max(1_000),
    providerId: ProviderIdSchema,
    capabilities: z.array(CapabilityDeclarationSchema).min(1).max(128),
    requestedGrants: z.array(ProviderGrantSchema).max(128),
    assets: z.array(ImmutableAssetReferenceSchema).max(256),
    signatures: z.array(ProviderPackageSignatureSchema).min(1).max(16),
    antiRollbackSequence: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const nanasaBuiltin =
      manifest.generation.publisherId === "nanasa" &&
      ReservedBuiltinProviderIds.has(manifest.providerId);
    if (
      !manifest.generation.namespaceClaims.includes(manifest.providerId) ||
      (!nanasaBuiltin &&
        manifest.providerId !== manifest.generation.publisherId &&
        !manifest.providerId.startsWith(`${manifest.generation.publisherId}.`))
    ) {
      context.addIssue({
        code: "custom",
        message: "Provider ID must be covered by the signed namespace claims",
        path: ["providerId"],
      });
    }
    const capabilityIds = manifest.capabilities.map((capability) => capability.id);
    if (new Set(capabilityIds).size !== capabilityIds.length) {
      context.addIssue({
        code: "custom",
        message: "Capability declarations must be unique",
        path: ["capabilities"],
      });
    }
    const assetPaths = new Set<string>();
    const assetDigests = new Set<string>();
    for (const [index, asset] of manifest.assets.entries()) {
      const normalized = asset.path.normalize("NFC").toLocaleLowerCase("en-US");
      if (assetPaths.has(normalized) || assetDigests.has(asset.digest)) {
        context.addIssue({
          code: "custom",
          message: "Assets must have unique normalized paths and digests",
          path: ["assets", index],
        });
      }
      assetPaths.add(normalized);
      assetDigests.add(asset.digest);
      if (
        /\.(?:c?js|mjs|jsx|ts|tsx|sh|bash|zsh|fish|ps1|bat|cmd|exe|dll|so|dylib|wasm)$/i.test(
          asset.path,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Declarative provider packages cannot contain executable assets",
          path: ["assets", index, "path"],
        });
      }
    }
  });
export type ProviderPackageManifest = z.infer<typeof ProviderPackageManifestSchema>;

export const ProviderPackageSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), buildDigest: SnapshotDigestSchema }).strict(),
  z
    .object({
      kind: z.literal("upload"),
      uploadDigest: SnapshotDigestSchema,
      originalName: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      kind: z.literal("catalog"),
      catalogId: OpenIdentitySchema,
      metadataDigest: SnapshotDigestSchema,
    })
    .strict(),
]);

export const ProviderPackageRecordSchema = z
  .object({
    generation: ProviderExtensionGenerationSchema,
    source: ProviderPackageSourceSchema,
    manifest: ProviderPackageManifestSchema,
    state: z.enum(["quarantined", "verified", "resolved", "revoked", "rejected"]),
    importedAt: z.string().datetime({ offset: true }),
    verifiedAt: z.string().datetime({ offset: true }).optional(),
    revokedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ProviderActivationSchema = z
  .object({
    id: z.string().min(1).max(128),
    indexGeneration: z.number().int().positive(),
    providerId: ProviderIdSchema,
    extensionGeneration: z.string().min(1).max(128),
    packageDigest: SnapshotDigestSchema,
    snapshotDigest: SnapshotDigestSchema,
    grantDigest: SnapshotDigestSchema,
    trustDigest: SnapshotDigestSchema,
    rollbackActivationId: z.string().min(1).max(128).optional(),
    state: z.enum(["staged", "active", "superseded", "rolled-back", "revoked"]),
    activatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ProviderPermissionPlanSchema = z
  .object({
    providerId: ProviderIdSchema,
    extensionGeneration: z.string().min(1).max(128),
    packageDigest: SnapshotDigestSchema,
    snapshotDigest: SnapshotDigestSchema,
    grants: z.array(ProviderGrantSchema).max(128),
    commands: z
      .array(
        z
          .object({
            executable: z.string().min(1).max(4_096),
            argv: z.array(z.string().max(4_096)).max(128),
            environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(128),
          })
          .strict(),
      )
      .max(256),
    assets: z.array(AssetDigestSchema).max(256),
    planDigest: SnapshotDigestSchema,
  })
  .strict();

export const ProviderPackageInspectSchema = z
  .object({
    package: ProviderPackageRecordSchema,
    activation: ProviderActivationSchema.optional(),
    plan: ProviderPermissionPlanSchema.optional(),
    health: ProviderRuntimeHealthSchema,
  })
  .strict();
