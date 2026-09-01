import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  ProviderPackageRecordSchema,
  parseResolvedProviderAdapterSnapshot,
} from "@nanasa/contracts";
import { ProviderNamespaceOwnership } from "./provider-capability-negotiator.js";
import {
  type ProviderAssetContent,
  ProviderAssetRegistry,
  providerAssetBytes,
  resolveProviderAdapter,
} from "./resolved-provider-adapter.js";

type PackageRecord = ReturnType<typeof ProviderPackageRecordSchema.parse>;
type Snapshot = Awaited<ReturnType<typeof parseResolvedProviderAdapterSnapshot>>;
type PackageState = PackageRecord["state"];

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export class ProviderSnapshotRepository {
  readonly #database: DatabaseSync;
  readonly #namespaces: ProviderNamespaceOwnership;

  public constructor(database: DatabaseSync, namespaces = new ProviderNamespaceOwnership()) {
    this.#database = database;
    this.#namespaces = namespaces;
  }

  public storePackage(input: unknown): PackageRecord {
    const record = ProviderPackageRecordSchema.parse(input);
    this.#namespaces.assertManifest(record.manifest);
    const existing = this.getPackage(record.generation.id);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new Error(`Provider package generation ${record.generation.id} is immutable`);
      }
      return existing;
    }
    this.#database
      .prepare(
        `INSERT INTO provider_packages
          (extension_generation,extension_id,version,package_digest,manifest_digest,publisher_id,
           namespace_claims_json,source_json,signatures_json,manifest_json,state,
           anti_rollback_sequence,imported_at,verified_at,revoked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.generation.id,
        record.generation.extensionId,
        record.generation.version,
        record.generation.packageDigest,
        record.generation.manifestDigest,
        record.generation.publisherId,
        canonicalJson(record.generation.namespaceClaims),
        canonicalJson(record.source),
        canonicalJson(record.manifest.signatures),
        canonicalJson(record.manifest),
        record.state,
        record.manifest.antiRollbackSequence,
        record.importedAt,
        record.verifiedAt ?? null,
        record.revokedAt ?? null,
      );
    this.#namespaces.claim(record.manifest);
    return record;
  }

  public getPackage(extensionGeneration: string): PackageRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT source_json, manifest_json, state, imported_at, verified_at, revoked_at
         FROM provider_packages WHERE extension_generation = ?`,
      )
      .get(extensionGeneration) as
      | {
          source_json: string;
          manifest_json: string;
          state: string;
          imported_at: string;
          verified_at: string | null;
          revoked_at: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    return ProviderPackageRecordSchema.parse({
      generation: manifest.generation,
      source: JSON.parse(row.source_json),
      manifest,
      state: row.state,
      importedAt: row.imported_at,
      ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    });
  }

  public transitionPackage(
    extensionGeneration: string,
    expected: PackageState,
    next: PackageState,
    timestamp = new Date().toISOString(),
  ): PackageRecord {
    const allowed: Readonly<Record<PackageState, readonly PackageState[]>> = {
      quarantined: ["verified", "rejected"],
      verified: ["resolved", "rejected"],
      resolved: ["revoked", "rejected"],
      revoked: [],
      rejected: [],
    };
    if (!allowed[expected].includes(next)) {
      throw new Error(`Provider package transition is not allowed: ${expected} -> ${next}`);
    }
    const changed = this.#database
      .prepare(
        `UPDATE provider_packages SET state = ?,
           verified_at = CASE WHEN ? IN ('verified','resolved') THEN coalesce(verified_at, ?) ELSE verified_at END,
           revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END
         WHERE extension_generation = ? AND state = ?`,
      )
      .run(next, next, timestamp, next, timestamp, extensionGeneration, expected);
    if (changed.changes !== 1) {
      throw new Error("Provider package state changed before the transition completed");
    }
    return this.getPackage(extensionGeneration)!;
  }

  public storeAssets(
    extensionGeneration: string,
    assets: readonly ProviderAssetContent[],
    createdAt = new Date().toISOString(),
  ): void {
    const packageRecord = this.getPackage(extensionGeneration);
    if (packageRecord === undefined) {
      throw new Error(`Provider package is unavailable: ${extensionGeneration}`);
    }
    const declarations = new Map(
      packageRecord.manifest.assets.map((asset) => [asset.digest, asset]),
    );
    if (assets.length !== declarations.size) {
      throw new Error("Provider package asset inventory is incomplete");
    }
    for (const asset of assets) {
      const declaration = declarations.get(asset.digest);
      const bytes = providerAssetBytes(asset);
      if (
        declaration === undefined ||
        declaration.path !== asset.path ||
        declaration.mediaType !== asset.mediaType ||
        declaration.bytes !== bytes.byteLength
      ) {
        throw new Error(`Provider package asset declaration mismatch for ${asset.path}`);
      }
      const existing = this.#database
        .prepare(
          `SELECT path,media_type,kind,content,payload_json FROM provider_assets
           WHERE extension_generation = ? AND digest = ?`,
        )
        .get(extensionGeneration, asset.digest) as
        | {
            path: string;
            media_type: string;
            kind: string;
            content: Uint8Array;
            payload_json: string | null;
          }
        | undefined;
      const payloadJson = asset.kind === "literal" ? null : JSON.stringify(asset.payload);
      if (existing !== undefined) {
        if (
          existing.path !== asset.path ||
          existing.media_type !== asset.mediaType ||
          existing.kind !== asset.kind ||
          !equalBytes(existing.content, bytes) ||
          existing.payload_json !== payloadJson
        ) {
          throw new Error(`Provider asset ${asset.digest} is immutable`);
        }
        continue;
      }
      this.#database
        .prepare(
          `INSERT INTO provider_assets
            (extension_generation,digest,path,media_type,kind,content,payload_json,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          extensionGeneration,
          asset.digest,
          asset.path,
          asset.mediaType,
          asset.kind,
          bytes,
          payloadJson,
          createdAt,
        );
    }
  }

  public async storeSnapshot(
    input: unknown,
    createdAt = new Date().toISOString(),
  ): Promise<Snapshot> {
    const snapshot = await parseResolvedProviderAdapterSnapshot(input);
    const packageRecord = this.getPackage(snapshot.body.extensionGeneration);
    if (packageRecord === undefined) {
      throw new Error(`Provider package is unavailable: ${snapshot.body.extensionGeneration}`);
    }
    if (packageRecord.generation.packageDigest !== snapshot.body.packageDigest) {
      throw new Error("Provider snapshot package digest does not match its generation");
    }
    for (const declaration of snapshot.body.assets) {
      const stored = this.#database
        .prepare(
          `SELECT path,media_type,length(content) AS bytes,content FROM provider_assets
           WHERE extension_generation = ? AND digest = ?`,
        )
        .get(snapshot.body.extensionGeneration, declaration.digest) as
        | { path: string; media_type: string; bytes: number; content: Uint8Array }
        | undefined;
      if (
        stored === undefined ||
        stored.path !== declaration.path ||
        stored.media_type !== declaration.mediaType ||
        stored.bytes !== declaration.bytes ||
        createHash("sha256").update(stored.content).digest("hex") !== declaration.digest
      ) {
        throw new Error(`Provider snapshot asset is unavailable: ${declaration.digest}`);
      }
    }
    const existing = await this.getSnapshot(snapshot.digest);
    const canonicalBytes = Buffer.from(snapshot.canonicalBytes, "base64url");
    if (existing !== undefined) {
      if (!equalBytes(Buffer.from(existing.canonicalBytes, "base64url"), canonicalBytes)) {
        throw new Error(`Provider snapshot ${snapshot.digest} is immutable`);
      }
      return existing;
    }
    this.#database
      .prepare(
        `INSERT INTO provider_snapshots
          (digest,extension_generation,provider_id,adapter_id,canonical_bytes,
           manifest_protocol_json,adapter_protocol_json,interpreter_versions_json,
           capabilities_json,grants_json,assets_json,compatibility_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        snapshot.digest,
        snapshot.body.extensionGeneration,
        snapshot.body.providerId,
        snapshot.body.adapterId,
        canonicalBytes,
        canonicalJson(snapshot.body.manifestProtocol),
        canonicalJson(snapshot.body.adapterProtocol),
        canonicalJson(snapshot.body.interpreterVersions),
        canonicalJson(snapshot.body.capabilities),
        canonicalJson(snapshot.body.grants),
        canonicalJson(snapshot.body.assets),
        canonicalJson(snapshot.body.providerBinaryCompatibility),
        createdAt,
      );
    return snapshot;
  }

  public async getSnapshot(snapshotDigest: string): Promise<Snapshot | undefined> {
    const row = this.#database
      .prepare("SELECT canonical_bytes FROM provider_snapshots WHERE digest = ?")
      .get(snapshotDigest) as { canonical_bytes: Uint8Array } | undefined;
    if (row === undefined) return undefined;
    const canonicalBytes = Buffer.from(row.canonical_bytes);
    const body = JSON.parse(canonicalBytes.toString("utf8"));
    return parseResolvedProviderAdapterSnapshot({
      digest: snapshotDigest,
      canonicalBytes: canonicalBytes.toString("base64url"),
      body,
    });
  }

  public async getResolvedSnapshot(snapshotDigest: string) {
    const snapshot = await this.getSnapshot(snapshotDigest);
    if (snapshot === undefined) return undefined;
    const rows = this.#database
      .prepare(
        `SELECT digest,path,media_type,kind,content,payload_json FROM provider_assets
         WHERE extension_generation = ? ORDER BY path`,
      )
      .all(snapshot.body.extensionGeneration) as Array<{
      digest: string;
      path: string;
      media_type: string;
      kind: ProviderAssetContent["kind"];
      content: Uint8Array;
      payload_json: string | null;
    }>;
    const declaredDigests = new Set(snapshot.body.assets.map((asset) => asset.digest));
    const declaredRows = rows.filter((row) => declaredDigests.has(row.digest));
    if (declaredRows.length !== declaredDigests.size) {
      throw new Error("Stored provider asset inventory is incomplete for the snapshot");
    }
    const assets = declaredRows.map((row): ProviderAssetContent => {
      const bytes = Buffer.from(row.content);
      if (row.kind === "literal") {
        return {
          digest: row.digest,
          path: row.path,
          mediaType: row.media_type,
          kind: row.kind,
          payload: bytes.toString("utf8"),
        };
      }
      if (row.payload_json === null) {
        throw new Error(`Stored provider asset ${row.digest} is malformed`);
      }
      return {
        digest: row.digest,
        path: row.path,
        mediaType: row.media_type,
        kind: row.kind,
        payload: JSON.parse(row.payload_json),
      };
    });
    return resolveProviderAdapter(snapshot, new ProviderAssetRegistry(assets));
  }
}
