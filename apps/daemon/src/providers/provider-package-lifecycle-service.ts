import { createHash, createPublicKey, verify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalProviderSnapshotBytes,
  digestProviderSnapshot,
  type ProviderExtensionV2Manifest,
  ProviderExtensionV2ManifestSchema,
  ProviderPackageRecordSchema,
  ResolvedProviderAdapterSnapshotSchema,
} from "@nanasa/contracts";
import type { TrustedBuiltInProviderPackage } from "./builtin-provider-packages.js";
import {
  HOST_PROVIDER_CAPABILITIES,
  negotiateProviderPackage,
  ProviderNamespaceOwnership,
} from "./provider-capability-negotiator.js";
import { ProviderReporterDriverRegistry } from "./provider-reporter-driver-registry.js";
import type { ProviderRuntimeIndex } from "./provider-runtime-index.js";
import type { ProviderSnapshotRepository } from "./provider-snapshot-repository.js";
import {
  type ProviderAssetContent,
  ProviderAssetRegistry,
  providerAssetBytes,
  resolveProviderAdapter,
} from "./resolved-provider-adapter.js";

export interface ImportProviderPackageInput {
  readonly manifest: unknown;
  readonly assets: readonly ProviderAssetContent[];
  readonly source:
    | { readonly kind: "upload"; readonly uploadDigest: string; readonly originalName: string }
    | { readonly kind: "catalog"; readonly catalogId: string; readonly metadataDigest: string };
  readonly importedAt?: string;
}

export interface ProviderPackageLifecycleOptions {
  readonly trustKeys: Readonly<Record<string, string | Buffer>>;
  readonly hostCapabilities?: typeof HOST_PROVIDER_CAPABILITIES;
  readonly now?: () => Date;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unsignedManifest(manifest: ProviderExtensionV2Manifest) {
  const { signatures, ...unsigned } = manifest;
  void signatures;
  return unsigned;
}

function expectedPackageDigest(manifest: ProviderExtensionV2Manifest): string {
  return sha256(
    canonicalJsonBytes({
      providerId: manifest.providerId,
      capabilities: manifest.capabilities,
      requestedGrants: manifest.requestedGrants,
      assets: manifest.assets,
    }),
  );
}

function expectedManifestDigest(manifest: ProviderExtensionV2Manifest): string {
  return sha256(
    canonicalJsonBytes({
      packageDigest: manifest.generation.packageDigest,
      capabilities: manifest.capabilities,
      requestedGrants: manifest.requestedGrants,
      assets: manifest.assets,
    }),
  );
}

export class ProviderPackageLifecycleService {
  readonly #database: DatabaseSync;
  readonly #snapshots: ProviderSnapshotRepository;
  readonly #index: ProviderRuntimeIndex;
  readonly #options: ProviderPackageLifecycleOptions;
  readonly #namespaces: ProviderNamespaceOwnership;

  public constructor(
    database: DatabaseSync,
    snapshots: ProviderSnapshotRepository,
    index: ProviderRuntimeIndex,
    options: ProviderPackageLifecycleOptions,
    namespaces = new ProviderNamespaceOwnership(),
  ) {
    this.#database = database;
    this.#snapshots = snapshots;
    this.#index = index;
    this.#options = options;
    this.#namespaces = namespaces;
  }

  public async importAndActivate(
    input: ImportProviderPackageInput,
  ): Promise<TrustedBuiltInProviderPackage> {
    const manifest = ProviderExtensionV2ManifestSchema.parse(input.manifest);
    const importedAt = input.importedAt ?? this.#now();
    this.#namespaces.assertManifest(manifest);
    this.#assertDigestChain(manifest);
    this.#assertAntiRollback(manifest);
    const quarantined = ProviderPackageRecordSchema.parse({
      generation: manifest.generation,
      source: input.source,
      manifest,
      state: "quarantined",
      importedAt,
    });
    this.#snapshots.storePackage(quarantined);
    let resolvedPackage: TrustedBuiltInProviderPackage | undefined;
    try {
      this.#verifySignatures(manifest);
      this.#assertAssets(manifest, input.assets);
      this.#snapshots.transitionPackage(
        manifest.generation.id,
        "quarantined",
        "verified",
        importedAt,
      );
      this.#snapshots.storeAssets(manifest.generation.id, input.assets, importedAt);
      const negotiated = negotiateProviderPackage(
        manifest,
        this.#options.hostCapabilities ?? HOST_PROVIDER_CAPABILITIES,
        this.#namespaces,
      );
      const compatibility = manifest.capabilities.find((item) => item.id === "compatibility")
        ?.payload as { providerBinary?: string } | undefined;
      if (compatibility?.providerBinary === undefined) {
        throw new Error("Provider package has no binary compatibility declaration");
      }
      const identity = manifest.capabilities.find((item) => item.id === "identity")?.payload as
        | { adapterId?: string }
        | undefined;
      if (identity?.adapterId === undefined) {
        throw new Error("Provider package has no adapter identity");
      }
      const body = {
        formatVersion: 2 as const,
        manifestProtocol: { major: 2, minor: 0 },
        adapterProtocol: { major: 2, minor: 0 },
        packageDigest: manifest.generation.packageDigest,
        providerId: manifest.providerId,
        adapterId: identity.adapterId,
        extensionId: manifest.generation.extensionId,
        extensionGeneration: manifest.generation.id,
        interpreterVersions: { core: "2.0.0" },
        capabilities: negotiated.capabilities,
        grants: negotiated.grants,
        assets: manifest.assets,
        providerBinaryCompatibility: {
          state: "compatible" as const,
          range: compatibility.providerBinary,
        },
      };
      const canonicalBytes = canonicalProviderSnapshotBytes(body);
      const snapshot = ResolvedProviderAdapterSnapshotSchema.parse({
        digest: await digestProviderSnapshot(body),
        canonicalBytes: Buffer.from(canonicalBytes).toString("base64url"),
        body: JSON.parse(Buffer.from(canonicalBytes).toString("utf8")),
      });
      await this.#snapshots.storeSnapshot(snapshot, importedAt);
      const resolved = await resolveProviderAdapter(
        snapshot,
        new ProviderAssetRegistry(input.assets),
      );
      const resolvedRecord = this.#snapshots.transitionPackage(
        manifest.generation.id,
        "verified",
        "resolved",
        importedAt,
      );
      resolvedPackage = Object.freeze({
        packageRecord: resolvedRecord,
        snapshot: Object.freeze({
          digest: snapshot.digest,
          canonicalBytes: snapshot.canonicalBytes,
          body: resolved.body,
        }),
        resolved,
        reporterDrivers: ProviderReporterDriverRegistry.fromSnapshot(resolved),
      });
      await this.#index.activateResolvedPackage(resolvedPackage, importedAt, "signed-package");
      this.#namespaces.claim(manifest);
      return resolvedPackage;
    } catch (error) {
      const current = this.#snapshots.getPackage(manifest.generation.id);
      if (current?.state === "quarantined") {
        this.#snapshots.transitionPackage(
          manifest.generation.id,
          "quarantined",
          "rejected",
          importedAt,
        );
      } else if (current?.state === "verified") {
        this.#snapshots.transitionPackage(
          manifest.generation.id,
          "verified",
          "rejected",
          importedAt,
        );
      } else if (current?.state === "resolved") {
        const active = this.#database
          .prepare(
            `SELECT 1 FROM provider_activations
             WHERE extension_generation = ? AND snapshot_digest = ? AND state = 'active'`,
          )
          .get(manifest.generation.id, resolvedPackage?.snapshot.digest ?? "");
        if (active !== undefined && resolvedPackage !== undefined) {
          this.#index.refresh();
          return resolvedPackage;
        }
        this.#snapshots.transitionPackage(
          manifest.generation.id,
          "resolved",
          "rejected",
          importedAt,
        );
      }
      throw error;
    }
  }

  public disable(providerId: string): void {
    this.#database
      .prepare(
        "UPDATE provider_activations SET state = 'superseded' WHERE provider_id = ? AND state = 'active'",
      )
      .run(providerId);
    this.#index.refresh();
  }

  public rollback(providerId: string, activatedAt = this.#now()): void {
    const candidate = this.#database
      .prepare(
        `SELECT activation.id, activation.snapshot_digest, activation.extension_generation
         FROM provider_activations AS activation
         JOIN provider_packages AS package
           ON package.extension_generation = activation.extension_generation
         WHERE activation.provider_id = ? AND activation.state = 'superseded'
           AND package.state = 'resolved'
         ORDER BY activation.index_generation DESC LIMIT 1`,
      )
      .get(providerId) as
      | { id: string; snapshot_digest: string; extension_generation: string }
      | undefined;
    if (candidate === undefined) throw new Error("Provider rollback activation is unavailable");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          "UPDATE provider_activations SET state = 'rolled-back' WHERE provider_id = ? AND state = 'active'",
        )
        .run(providerId);
      this.#database
        .prepare(
          "UPDATE provider_activations SET state = 'active', activated_at = ? WHERE id = ? AND state = 'superseded'",
        )
        .run(activatedAt, candidate.id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#index.refresh();
  }

  public revoke(extensionGeneration: string, revokedAt = this.#now()): void {
    const current = this.#snapshots.getPackage(extensionGeneration);
    if (current?.state !== "resolved")
      throw new Error("Only resolved provider packages can be revoked");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          "UPDATE provider_activations SET state = 'revoked' WHERE extension_generation = ? AND state = 'active'",
        )
        .run(extensionGeneration);
      this.#snapshots.transitionPackage(extensionGeneration, "resolved", "revoked", revokedAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#index.refresh();
  }

  public assertUninstallable(extensionGeneration: string): void {
    const references = this.#database
      .prepare(
        `SELECT
           (SELECT count(*) FROM provider_activations
            WHERE extension_generation = ? AND state IN ('staged','active')) AS activations,
           (SELECT count(*) FROM run_provider_bindings AS binding
            JOIN provider_snapshots AS snapshot ON snapshot.digest = binding.snapshot_digest
            WHERE snapshot.extension_generation = ?) AS bindings`,
      )
      .get(extensionGeneration, extensionGeneration) as { activations: number; bindings: number };
    if (references.activations > 0 || references.bindings > 0) {
      throw new Error("Provider package is retained by activation or run recovery references");
    }
  }

  public uninstall(extensionGeneration: string): void {
    this.assertUninstallable(extensionGeneration);
    const record = this.#snapshots.getPackage(extensionGeneration);
    if (record === undefined) throw new Error("Provider package is unavailable for uninstall");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("DELETE FROM provider_activations WHERE extension_generation = ?")
        .run(extensionGeneration);
      const snapshots = this.#database
        .prepare("SELECT digest FROM provider_snapshots WHERE extension_generation = ?")
        .all(extensionGeneration) as Array<{ digest: string }>;
      for (const snapshot of snapshots) {
        this.#database
          .prepare("DELETE FROM provider_snapshots WHERE digest = ?")
          .run(snapshot.digest);
      }
      this.#database
        .prepare("DELETE FROM provider_assets WHERE extension_generation = ?")
        .run(extensionGeneration);
      this.#database
        .prepare("DELETE FROM provider_packages WHERE extension_generation = ?")
        .run(extensionGeneration);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#index.refresh();
  }

  #assertDigestChain(manifest: ProviderExtensionV2Manifest): void {
    if (manifest.generation.packageDigest !== expectedPackageDigest(manifest)) {
      throw new Error("Provider package digest chain does not match its manifest");
    }
    if (manifest.generation.manifestDigest !== expectedManifestDigest(manifest)) {
      throw new Error("Provider manifest digest chain is invalid");
    }
  }

  #assertAntiRollback(manifest: ProviderExtensionV2Manifest): void {
    const current = this.#database
      .prepare(
        `SELECT max(anti_rollback_sequence) AS sequence FROM provider_packages
         WHERE extension_id = ? AND state <> 'rejected'`,
      )
      .get(manifest.generation.extensionId) as { sequence: number | null };
    if (current.sequence !== null && manifest.antiRollbackSequence <= current.sequence) {
      throw new Error("Provider package anti-rollback sequence is not newer");
    }
  }

  #verifySignatures(manifest: ProviderExtensionV2Manifest): void {
    const now = Date.parse(this.#now());
    const bytes = Buffer.from(canonicalJson(unsignedManifest(manifest)), "utf8");
    const accepted = manifest.signatures.some((signature) => {
      if (signature.expiresAt !== undefined && Date.parse(signature.expiresAt) <= now) return false;
      const key = this.#options.trustKeys[signature.keyId];
      return (
        key !== undefined &&
        verify(null, bytes, createPublicKey(key), Buffer.from(signature.signature, "base64url"))
      );
    });
    if (!accepted) throw new Error("Provider package has no current trusted signature");
  }

  #assertAssets(
    manifest: ProviderExtensionV2Manifest,
    assets: readonly ProviderAssetContent[],
  ): void {
    const declared = new Map(manifest.assets.map((asset) => [asset.digest, asset]));
    if (declared.size !== assets.length)
      throw new Error("Provider package asset inventory is incomplete");
    for (const asset of assets) {
      const reference = declared.get(asset.digest);
      if (
        reference === undefined ||
        reference.path !== asset.path ||
        reference.mediaType !== asset.mediaType ||
        reference.bytes !== providerAssetBytes(asset).byteLength
      ) {
        throw new Error(`Provider package asset mismatch: ${asset.path}`);
      }
    }
  }

  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }
}
