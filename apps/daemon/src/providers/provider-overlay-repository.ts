import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  type GeneratedOverlayV2,
  GeneratedOverlayV2Schema,
  type RunProviderBinding,
} from "@nanasa/contracts";
import {
  GeneratedOverlayTransaction,
  type OverlayLedger,
  type OverlayLedgerEntry,
} from "../generated-overlay-transaction.js";
import type { GeneratedOverlayFile } from "./provider-adapter.js";
import type { RecoveredRunProviderBinding } from "./provider-run-binding-repository.js";

interface OverlayRow {
  readonly id: string;
  readonly binding_id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly provider_id: string;
  readonly snapshot_digest: string;
  readonly provider_state_id: string;
  readonly revision: number;
  readonly recipe_digest: string;
  readonly asset_digest: string;
  readonly content_digest: string;
  readonly ownership_manifest_digest: string;
  readonly ledger_json: string;
  readonly state: "active" | "replaced" | "failed";
  readonly created_at: string;
}

export interface CommitProviderOverlayInput {
  readonly binding: RunProviderBinding;
  readonly snapshot: RecoveredRunProviderBinding["snapshot"];
  readonly adapterVersion: string;
  readonly files: readonly GeneratedOverlayFile[];
  readonly revision?: number;
}

export interface RecoveredProviderOverlay {
  readonly record: GeneratedOverlayV2;
  readonly root: string;
  readonly ledger: OverlayLedger;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function launchRecipes(snapshot: RecoveredRunProviderBinding["snapshot"]): unknown {
  const launch = snapshot.body.capabilities.find((capability) => capability.id === "launch");
  if (launch === undefined) throw new Error("Pinned provider snapshot has no launch capability");
  return (launch.payload as { files?: unknown }).files ?? [];
}

function contentDigest(entries: readonly OverlayLedgerEntry[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(entries.map((entry) => [entry.relativePath, entry.contentHash, entry.mode])),
    )
    .digest("hex");
}

function ownershipDigest(ledger: OverlayLedger): string {
  return digest({
    version: ledger.version,
    bindingId: ledger.bindingId,
    revision: ledger.revision,
    entries: ledger.entries,
  });
}

function recordFromRow(row: OverlayRow): GeneratedOverlayV2 {
  return GeneratedOverlayV2Schema.parse({
    id: row.id,
    fence: {
      runId: row.run_id,
      generation: row.generation,
      bindingId: row.binding_id,
      providerId: row.provider_id,
      snapshotDigest: row.snapshot_digest,
    },
    providerStateId: row.provider_state_id,
    revision: row.revision,
    recipeDigest: row.recipe_digest,
    assetDigest: row.asset_digest,
    contentDigest: row.content_digest,
    ownershipManifestDigest: row.ownership_manifest_digest,
    state: row.state,
    createdAt: row.created_at,
  });
}

export class ProviderOverlayRepository {
  readonly #database: DatabaseSync;
  readonly #overlays: GeneratedOverlayTransaction;

  public constructor(database: DatabaseSync, overlays: GeneratedOverlayTransaction) {
    this.#database = database;
    this.#overlays = overlays;
  }

  public overlayRoot(overlayId: string, revision = 1): string {
    return this.#overlays.overlayRoot(overlayId, revision);
  }

  public commit(input: CommitProviderOverlayInput): RecoveredProviderOverlay {
    this.#assertSnapshotBinding(input.binding, input.snapshot);
    const existing = this.#row(input.binding.overlayId);
    if (existing !== undefined) {
      return this.requireForRecovery({ binding: input.binding, snapshot: input.snapshot });
    }
    const revision = input.revision ?? 1;
    const committed = this.#overlays.commit(
      input.binding.overlayId,
      revision,
      input.adapterVersion,
      input.files,
    );
    const record = GeneratedOverlayV2Schema.parse({
      id: input.binding.overlayId,
      fence: {
        runId: input.binding.runId,
        generation: input.binding.generation,
        bindingId: input.binding.id,
        providerId: input.binding.providerId,
        snapshotDigest: input.binding.snapshotDigest,
      },
      providerStateId: input.binding.providerStateId,
      revision,
      recipeDigest: digest(launchRecipes(input.snapshot)),
      assetDigest: digest(input.snapshot.body.assets),
      contentDigest: committed.digest,
      ownershipManifestDigest: ownershipDigest(committed.ledger),
      state: "active",
      createdAt: committed.ledger.committedAt,
    });
    try {
      this.#database
        .prepare(
          `INSERT INTO provider_overlays
            (id,binding_id,run_id,generation,provider_id,snapshot_digest,provider_state_id,
             revision,recipe_digest,asset_digest,content_digest,ownership_manifest_digest,
             ledger_json,state,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.id,
          record.fence.bindingId,
          record.fence.runId,
          record.fence.generation,
          record.fence.providerId,
          record.fence.snapshotDigest,
          record.providerStateId,
          record.revision,
          record.recipeDigest,
          record.assetDigest,
          record.contentDigest,
          record.ownershipManifestDigest,
          canonicalJson(committed.ledger),
          record.state,
          record.createdAt,
        );
    } catch (error) {
      this.#overlays.removeConservatively(input.binding.overlayId);
      throw error;
    }
    return Object.freeze({
      record: Object.freeze(record),
      root: committed.root,
      ledger: committed.ledger,
    });
  }

  public requireForRecovery(input: RecoveredRunProviderBinding): RecoveredProviderOverlay {
    this.#assertSnapshotBinding(input.binding, input.snapshot);
    const row = this.#row(input.binding.overlayId);
    if (row === undefined) throw new Error("Pinned provider overlay is unavailable for recovery");
    const record = recordFromRow(row);
    const ledger = this.#overlays.readLedger(input.binding.overlayId);
    if (ledger === undefined) throw new Error("Pinned provider overlay ledger is unavailable");
    const drift = this.#overlays.detectDrift(input.binding.overlayId);
    if (drift.length > 0) {
      throw new Error(`Pinned provider overlay drift detected: ${drift.join(", ")}`);
    }
    if (
      record.state !== "active" ||
      record.fence.bindingId !== input.binding.id ||
      record.fence.runId !== input.binding.runId ||
      record.fence.generation !== input.binding.generation ||
      record.fence.providerId !== input.binding.providerId ||
      record.fence.snapshotDigest !== input.binding.snapshotDigest ||
      record.providerStateId !== input.binding.providerStateId ||
      record.recipeDigest !== digest(launchRecipes(input.snapshot)) ||
      record.assetDigest !== digest(input.snapshot.body.assets) ||
      record.contentDigest !== contentDigest(ledger.entries) ||
      record.ownershipManifestDigest !== ownershipDigest(ledger) ||
      canonicalJson(JSON.parse(row.ledger_json)) !== canonicalJson(ledger)
    ) {
      throw new Error("Pinned provider overlay does not match its immutable metadata");
    }
    return Object.freeze({ record: Object.freeze(record), root: ledger.overlayPath, ledger });
  }

  #row(overlayId: string): OverlayRow | undefined {
    return this.#database.prepare("SELECT * FROM provider_overlays WHERE id = ?").get(overlayId) as
      | OverlayRow
      | undefined;
  }

  #assertSnapshotBinding(
    binding: RunProviderBinding,
    snapshot: RecoveredRunProviderBinding["snapshot"],
  ): void {
    if (
      binding.snapshotDigest !== snapshot.digest ||
      binding.providerId !== snapshot.body.providerId ||
      binding.adapterId !== snapshot.body.adapterId
    ) {
      throw new Error("Provider overlay snapshot does not match its run binding");
    }
  }
}
