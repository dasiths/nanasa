import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  type ProviderStatusClaim,
  ProviderStatusClaimSchema,
} from "@nanasa/contracts";

interface ClaimRow {
  readonly id: string;
  readonly binding_id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly provider_id: string;
  readonly snapshot_digest: string;
  readonly process_incarnation_digest: string;
  readonly status_policy_digest: string;
  readonly source: ProviderStatusClaim["source"];
  readonly source_id: string;
  readonly source_session_id: string | null;
  readonly source_manifest_digest: string | null;
  readonly claim_type: ProviderStatusClaim["claimType"];
  readonly value_json: string;
  readonly confidence: ProviderStatusClaim["confidence"];
  readonly reason_code: string;
  readonly source_sequence: number;
  readonly source_occurred_at: string | null;
  readonly received_at: string;
  readonly expires_at: string | null;
}

export interface StatusClaimWriteResult {
  readonly claim: ProviderStatusClaim;
  readonly changed: boolean;
}

function claimValue(claim: ProviderStatusClaim): Record<string, unknown> {
  return {
    ...(claim.semanticState === undefined ? {} : { semanticState: claim.semanticState }),
    ...(claim.phase === undefined ? {} : { phase: claim.phase }),
    ...(claim.outcome === undefined ? {} : { outcome: claim.outcome }),
    ...(claim.processState === undefined ? {} : { processState: claim.processState }),
    ...(claim.waitRequestId === undefined ? {} : { waitRequestId: claim.waitRequestId }),
  };
}

function fromRow(row: ClaimRow): ProviderStatusClaim {
  return ProviderStatusClaimSchema.parse({
    id: row.id,
    fence: {
      bindingId: row.binding_id,
      runId: row.run_id,
      generation: row.generation,
      providerId: row.provider_id,
      snapshotDigest: row.snapshot_digest,
      processIncarnationDigest: row.process_incarnation_digest,
    },
    policyDigest: row.status_policy_digest,
    source: row.source,
    sourceId: row.source_id,
    ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id }),
    ...(row.source_manifest_digest === null
      ? {}
      : { sourceManifestDigest: row.source_manifest_digest }),
    claimType: row.claim_type,
    ...JSON.parse(row.value_json),
    confidence: row.confidence,
    reasonCode: row.reason_code,
    sourceSequence: row.source_sequence,
    ...(row.source_occurred_at === null ? {} : { sourceOccurredAt: row.source_occurred_at }),
    receivedAt: row.received_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  });
}

function semanticIdentity(claim: ProviderStatusClaim): unknown {
  return {
    fence: claim.fence,
    policyDigest: claim.policyDigest,
    source: claim.source,
    sourceId: claim.sourceId,
    ...(claim.sourceSessionId === undefined ? {} : { sourceSessionId: claim.sourceSessionId }),
    ...(claim.sourceManifestDigest === undefined
      ? {}
      : { sourceManifestDigest: claim.sourceManifestDigest }),
    claimType: claim.claimType,
    value: claimValue(claim),
    confidence: claim.confidence,
    reasonCode: claim.reasonCode,
    ...(claim.expiresAt === undefined ? {} : { expiresAt: claim.expiresAt }),
  };
}

export class ProviderStatusClaimRepository {
  readonly #database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.#database = database;
  }

  public record(input: unknown): StatusClaimWriteResult {
    const claim = ProviderStatusClaimSchema.parse(input);
    const authority = this.#database
      .prepare(
        `SELECT binding.provider_id
         FROM run_provider_bindings AS binding
         JOIN provider_process_incarnations AS process
           ON process.binding_id = binding.id AND process.snapshot_digest = binding.snapshot_digest
         WHERE binding.id = ? AND binding.run_id = ? AND binding.generation = ?
           AND binding.provider_id = ? AND binding.snapshot_digest = ?
           AND binding.status_policy_digest = ? AND process.digest = ? AND process.ended_at IS NULL`,
      )
      .get(
        claim.fence.bindingId,
        claim.fence.runId,
        claim.fence.generation,
        claim.fence.providerId,
        claim.fence.snapshotDigest,
        claim.policyDigest,
        claim.fence.processIncarnationDigest,
      );
    if (authority === undefined) throw new Error("Status claim authority fence is not current");
    const existing = this.#current(claim);
    if (existing !== undefined) {
      if (claim.sourceSequence <= existing.sourceSequence) {
        throw new Error("Status claim source sequence is reordered");
      }
      if (canonicalJson(semanticIdentity(existing)) === canonicalJson(semanticIdentity(claim))) {
        return Object.freeze({ claim: existing, changed: false });
      }
      const updated = this.#database
        .prepare(
          `UPDATE status_source_claims SET id = ?, source_session_id = ?,
             source_manifest_digest = ?, value_json = ?, confidence = ?, reason_code = ?,
             source_sequence = ?, source_occurred_at = ?, received_at = ?, expires_at = ?
           WHERE binding_id = ? AND source = ? AND source_id = ? AND claim_type = ?
             AND EXISTS (
               SELECT 1 FROM provider_process_incarnations
               WHERE digest = ? AND binding_id = ? AND snapshot_digest = ? AND ended_at IS NULL
             )`,
        )
        .run(
          claim.id,
          claim.sourceSessionId ?? null,
          claim.sourceManifestDigest ?? null,
          canonicalJson(claimValue(claim)),
          claim.confidence,
          claim.reasonCode,
          claim.sourceSequence,
          claim.sourceOccurredAt ?? null,
          claim.receivedAt,
          claim.expiresAt ?? null,
          claim.fence.bindingId,
          claim.source,
          claim.sourceId,
          claim.claimType,
          claim.fence.processIncarnationDigest,
          claim.fence.bindingId,
          claim.fence.snapshotDigest,
        );
      if (updated.changes !== 1) throw new Error("Status claim authority changed during update");
      return Object.freeze({ claim, changed: true });
    }
    this.#database
      .prepare(
        `INSERT INTO status_source_claims
          (id,binding_id,run_id,generation,snapshot_digest,process_incarnation_digest,
           status_policy_digest,source,source_id,source_session_id,source_manifest_digest,
           claim_type,value_json,confidence,reason_code,source_sequence,source_occurred_at,
           received_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        claim.id,
        claim.fence.bindingId,
        claim.fence.runId,
        claim.fence.generation,
        claim.fence.snapshotDigest,
        claim.fence.processIncarnationDigest,
        claim.policyDigest,
        claim.source,
        claim.sourceId,
        claim.sourceSessionId ?? null,
        claim.sourceManifestDigest ?? null,
        claim.claimType,
        canonicalJson(claimValue(claim)),
        claim.confidence,
        claim.reasonCode,
        claim.sourceSequence,
        claim.sourceOccurredAt ?? null,
        claim.receivedAt,
        claim.expiresAt ?? null,
      );
    return Object.freeze({ claim, changed: true });
  }

  public list(runId: string, generation: number): readonly ProviderStatusClaim[] {
    const rows = this.#database
      .prepare(
        `SELECT claim.*, binding.provider_id
         FROM status_source_claims AS claim
         JOIN run_provider_bindings AS binding ON binding.id = claim.binding_id
         WHERE claim.run_id = ? AND claim.generation = ?
         ORDER BY claim.source, claim.source_id, claim.claim_type`,
      )
      .all(runId, generation) as unknown as ClaimRow[];
    return Object.freeze(rows.map(fromRow));
  }

  #current(claim: ProviderStatusClaim): ProviderStatusClaim | undefined {
    const row = this.#database
      .prepare(
        `SELECT claim.*, binding.provider_id
         FROM status_source_claims AS claim
         JOIN run_provider_bindings AS binding ON binding.id = claim.binding_id
         WHERE claim.binding_id = ? AND claim.source = ? AND claim.source_id = ?
           AND claim.claim_type = ?`,
      )
      .get(claim.fence.bindingId, claim.source, claim.sourceId, claim.claimType) as
      | ClaimRow
      | undefined;
    return row === undefined ? undefined : fromRow(row);
  }
}
