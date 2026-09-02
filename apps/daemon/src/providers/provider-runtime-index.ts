import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, ProviderRuntimeIndexEntrySchema } from "@nanasa/contracts";
import type { TrustedBuiltInProviderPackage } from "./builtin-provider-packages.js";
import { ProviderNamespaceOwnership } from "./provider-capability-negotiator.js";
import { ProviderSnapshotRepository } from "./provider-snapshot-repository.js";

type RuntimeIndexEntry = ReturnType<typeof ProviderRuntimeIndexEntrySchema.parse>;

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class ProviderRuntimeIndex {
  readonly #database: DatabaseSync;
  readonly #snapshots: ProviderSnapshotRepository;
  readonly #namespaces: ProviderNamespaceOwnership;
  #entries: ReadonlyMap<string, RuntimeIndexEntry> = new Map();

  public constructor(
    database: DatabaseSync,
    snapshots = new ProviderSnapshotRepository(database),
    namespaces = new ProviderNamespaceOwnership(),
  ) {
    this.#database = database;
    this.#snapshots = snapshots;
    this.#namespaces = namespaces;
    this.refresh();
  }

  public get(providerId: string): RuntimeIndexEntry {
    const entry = this.#entries.get(providerId);
    if (entry === undefined) throw new Error(`Provider is not active: ${providerId}`);
    return entry;
  }

  public list(): readonly RuntimeIndexEntry[] {
    return Object.freeze([...this.#entries.values()]);
  }

  public refresh(): void {
    const rows = this.#database
      .prepare(
        `SELECT index_generation,provider_id,extension_generation,snapshot_digest,
                grants_digest,state,activated_at
         FROM provider_activations WHERE state = 'active'
         ORDER BY provider_id`,
      )
      .all() as Array<{
      index_generation: number;
      provider_id: string;
      extension_generation: string;
      snapshot_digest: string;
      grants_digest: string;
      state: "active";
      activated_at: string | null;
    }>;
    const entries = new Map<string, RuntimeIndexEntry>();
    for (const row of rows) {
      if (row.activated_at === null)
        throw new Error("Active provider index entry has no activation time");
      const entry = ProviderRuntimeIndexEntrySchema.parse({
        indexGeneration: row.index_generation,
        providerId: row.provider_id,
        extensionGeneration: row.extension_generation,
        snapshotDigest: row.snapshot_digest,
        grantDigest: row.grants_digest,
        state: row.state,
        activatedAt: row.activated_at,
      });
      if (entries.has(entry.providerId))
        throw new Error(`Ambiguous provider ownership: ${entry.providerId}`);
      entries.set(entry.providerId, Object.freeze(entry));
    }
    this.#entries = entries;
  }

  public async registerTrustedBuiltin(
    builtIn: TrustedBuiltInProviderPackage,
    activatedAt = "2026-09-01T00:00:00.000Z",
  ): Promise<RuntimeIndexEntry> {
    if (builtIn.packageRecord.source.kind !== "builtin") {
      throw new Error("Trusted built-in registration requires a built-in package source");
    }
    return this.activateResolvedPackage(builtIn, activatedAt, "trusted-builtin");
  }

  public async activateResolvedPackage(
    resolvedPackage: TrustedBuiltInProviderPackage,
    activatedAt = new Date().toISOString(),
    trustKind = "verified-package",
  ): Promise<RuntimeIndexEntry> {
    if (resolvedPackage.packageRecord.state !== "resolved") {
      throw new Error("Provider activation requires a resolved package");
    }
    this.#namespaces.assertManifest(resolvedPackage.packageRecord.manifest);
    this.#snapshots.storePackage(resolvedPackage.packageRecord);
    this.#snapshots.storeAssets(
      resolvedPackage.packageRecord.generation.id,
      resolvedPackage.resolved.assets.list(),
      activatedAt,
    );
    await this.#snapshots.storeSnapshot(resolvedPackage.snapshot, activatedAt);
    this.refresh();
    const providerId = resolvedPackage.snapshot.body.providerId;
    const existing = this.#entries.get(providerId);
    if (existing?.snapshotDigest === resolvedPackage.snapshot.digest) return existing;
    const grantsDigest = digest(resolvedPackage.snapshot.body.grants);
    const trustDigest = digest({
      kind: trustKind,
      packageDigest: resolvedPackage.snapshot.body.packageDigest,
      snapshotDigest: resolvedPackage.snapshot.digest,
      grantsDigest,
    });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const indexGeneration =
        (
          this.#database
            .prepare("SELECT coalesce(max(index_generation), 0) AS value FROM provider_activations")
            .get() as { value: number }
        ).value + 1;
      const activationId = `activation-${indexGeneration}-${providerId}-${resolvedPackage.snapshot.digest.slice(0, 16)}`;
      this.#database
        .prepare(
          "UPDATE provider_activations SET state = 'superseded' WHERE provider_id = ? AND state = 'active'",
        )
        .run(providerId);
      this.#database
        .prepare(
          `INSERT INTO provider_activations
            (id,index_generation,provider_id,extension_generation,snapshot_digest,grants_digest,
             trust_digest,state,created_at,activated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          activationId,
          indexGeneration,
          providerId,
          resolvedPackage.snapshot.body.extensionGeneration,
          resolvedPackage.snapshot.digest,
          grantsDigest,
          trustDigest,
          "active",
          activatedAt,
          activatedAt,
        );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#namespaces.claim(resolvedPackage.packageRecord.manifest);
    this.refresh();
    return this.get(providerId);
  }
}
