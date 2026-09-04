import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ProviderUpdatePlan,
  ProviderUpdatePlanSchema,
  type ProviderUpdateSafeError,
  type ProviderUpdateTransition,
  type ProviderUpdateTransitionOutcome,
  ProviderUpdateTransitionOutcomeSchema,
  ProviderUpdateTransitionSchema,
} from "@nanasa/contracts";

interface TransitionRow {
  readonly id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly member_id: string;
  readonly provider_id: string;
  readonly previous_snapshot_digest: string;
  readonly current_snapshot_digest: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly replacement_run_id: string | null;
  readonly safe_error_code: string | null;
  readonly safe_error_message: string | null;
  readonly safe_error_retryable: number | null;
  readonly detected_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

export interface BeginProviderUpdateTransitionResult {
  readonly created: boolean;
  readonly transition: ProviderUpdateTransition;
}

export interface CompleteProviderUpdateTransitionInput {
  readonly outcome: ProviderUpdateTransitionOutcome;
  readonly replacementRunId?: string;
  readonly safeError?: ProviderUpdateSafeError;
  readonly completedAt?: string;
}

function transitionFromRow(row: TransitionRow): ProviderUpdateTransition {
  return ProviderUpdateTransitionSchema.parse({
    id: row.id,
    runId: row.run_id,
    generation: row.generation,
    memberId: row.member_id,
    providerId: row.provider_id,
    previousSnapshotDigest: row.previous_snapshot_digest,
    currentSnapshotDigest: row.current_snapshot_digest,
    state: row.state,
    outcome: row.outcome ?? undefined,
    replacementRunId: row.replacement_run_id ?? undefined,
    safeError:
      row.safe_error_code === null
        ? undefined
        : {
            code: row.safe_error_code,
            message: row.safe_error_message,
            retryable: row.safe_error_retryable === 1,
          },
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  });
}

export class ProviderUpdateTransitionRepository {
  readonly #database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.#database = database;
  }

  public begin(
    plan: ProviderUpdatePlan,
    detectedAt = new Date().toISOString(),
  ): BeginProviderUpdateTransitionResult {
    const parsed = ProviderUpdatePlanSchema.parse(plan);
    if (parsed.status !== "outdated") {
      throw new Error("Provider update transitions require an outdated run binding");
    }
    this.#assertTargetMatches(parsed);
    const id = `provider-update-${randomUUID()}`;
    const insert = this.#database
      .prepare(
        `INSERT INTO provider_update_transitions
          (id,run_id,generation,member_id,provider_id,previous_snapshot_digest,
           current_snapshot_digest,state,detected_at,updated_at)
         VALUES (?,?,?,?,?,?,?,'pending',?,?)
         ON CONFLICT (run_id,generation,previous_snapshot_digest,current_snapshot_digest)
         DO NOTHING`,
      )
      .run(
        id,
        parsed.runId,
        parsed.generation,
        parsed.memberId,
        parsed.providerId,
        parsed.previousSnapshotDigest,
        parsed.currentSnapshotDigest,
        detectedAt,
        detectedAt,
      );
    const transition = this.getForPair(parsed);
    if (transition === undefined) throw new Error("Provider update transition was not persisted");
    if (transition.memberId !== parsed.memberId || transition.providerId !== parsed.providerId) {
      throw new Error("Persisted provider update transition identity does not match the plan");
    }
    return { created: Number(insert.changes) === 1, transition };
  }

  public get(id: string): ProviderUpdateTransition | undefined {
    const row = this.#database
      .prepare("SELECT * FROM provider_update_transitions WHERE id = ?")
      .get(id) as TransitionRow | undefined;
    return row === undefined ? undefined : transitionFromRow(row);
  }

  public getForPair(
    plan: Pick<
      ProviderUpdatePlan,
      "runId" | "generation" | "previousSnapshotDigest" | "currentSnapshotDigest"
    >,
  ): ProviderUpdateTransition | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM provider_update_transitions
         WHERE run_id = ? AND generation = ?
           AND previous_snapshot_digest = ? AND current_snapshot_digest = ?`,
      )
      .get(plan.runId, plan.generation, plan.previousSnapshotDigest, plan.currentSnapshotDigest) as
      | TransitionRow
      | undefined;
    return row === undefined ? undefined : transitionFromRow(row);
  }

  public listForRun(runId: string, generation: number): ProviderUpdateTransition[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM provider_update_transitions
         WHERE run_id = ? AND generation = ?
         ORDER BY detected_at, id`,
      )
      .all(runId, generation) as unknown as TransitionRow[];
    return rows.map(transitionFromRow);
  }

  public markInProgress(
    transitionId: string,
    updatedAt = new Date().toISOString(),
  ): ProviderUpdateTransition {
    const transition = this.#require(transitionId);
    if (transition.replacementRunId !== undefined) {
      throw new Error("Provider update transition already has a replacement run");
    }
    this.#database
      .prepare(
        `UPDATE provider_update_transitions
         SET state = 'in-progress', outcome = NULL, safe_error_code = NULL,
             safe_error_message = NULL, safe_error_retryable = NULL,
             updated_at = ?, completed_at = NULL
         WHERE id = ?`,
      )
      .run(updatedAt, transitionId);
    return this.#require(transitionId);
  }

  public recordReplacement(
    transitionId: string,
    replacementRunId: string,
    updatedAt = new Date().toISOString(),
  ): ProviderUpdateTransition {
    const existing = this.#require(transitionId);
    if (existing.replacementRunId !== undefined) {
      if (existing.replacementRunId === replacementRunId) return existing;
      throw new Error("Provider update transition already references a different replacement run");
    }
    if (existing.state === "completed") {
      throw new Error("Provider update transition is already completed");
    }
    this.#database
      .prepare(
        `UPDATE provider_update_transitions
         SET replacement_run_id = ?, updated_at = ?
         WHERE id = ? AND replacement_run_id IS NULL AND state != 'completed'`,
      )
      .run(replacementRunId, updatedAt, transitionId);
    const persisted = this.#require(transitionId);
    if (persisted.replacementRunId !== replacementRunId) {
      throw new Error(
        "Provider update transition concurrently recorded a different replacement run",
      );
    }
    return persisted;
  }

  public complete(
    transitionId: string,
    input: CompleteProviderUpdateTransitionInput,
  ): ProviderUpdateTransition {
    const outcome = ProviderUpdateTransitionOutcomeSchema.parse(input.outcome);
    const existing = this.#require(transitionId);
    const replacementRunId = input.replacementRunId ?? existing.replacementRunId;
    if (existing.state === "completed") {
      const sameResult =
        existing.outcome === outcome &&
        existing.replacementRunId === replacementRunId &&
        JSON.stringify(existing.safeError) === JSON.stringify(input.safeError);
      if (sameResult) return existing;
      throw new Error("Provider update transition is already completed with a different result");
    }
    const completedAt = input.completedAt ?? new Date().toISOString();
    const candidate = ProviderUpdateTransitionSchema.parse({
      ...existing,
      state: "completed",
      outcome,
      replacementRunId,
      safeError: input.safeError,
      updatedAt: completedAt,
      completedAt,
    });
    this.#database
      .prepare(
        `UPDATE provider_update_transitions
         SET state = 'completed', outcome = ?, replacement_run_id = ?,
             safe_error_code = ?, safe_error_message = ?, safe_error_retryable = ?,
             updated_at = ?, completed_at = ?
         WHERE id = ? AND state != 'completed'`,
      )
      .run(
        outcome,
        candidate.replacementRunId ?? null,
        candidate.safeError?.code ?? null,
        candidate.safeError?.message ?? null,
        candidate.safeError === undefined ? null : candidate.safeError.retryable ? 1 : 0,
        completedAt,
        completedAt,
        transitionId,
      );
    const persisted = this.#require(transitionId);
    if (
      persisted.outcome !== outcome ||
      persisted.replacementRunId !== candidate.replacementRunId ||
      JSON.stringify(persisted.safeError) !== JSON.stringify(candidate.safeError)
    ) {
      throw new Error("Provider update transition completed concurrently with a different result");
    }
    return persisted;
  }

  #require(id: string): ProviderUpdateTransition {
    const transition = this.get(id);
    if (transition === undefined) throw new Error("Provider update transition is unavailable");
    return transition;
  }

  #assertTargetMatches(plan: ProviderUpdatePlan): void {
    const target = this.#database
      .prepare(
        `SELECT run.member_id, binding.provider_id, binding.snapshot_digest,
                current.provider_id AS current_provider_id
         FROM runs AS run
         JOIN run_provider_bindings AS binding
           ON binding.run_id = run.id AND binding.generation = run.generation
         JOIN provider_snapshots AS current ON current.digest = ?
         WHERE run.id = ? AND run.generation = ?`,
      )
      .get(plan.currentSnapshotDigest, plan.runId, plan.generation) as
      | {
          member_id: string;
          provider_id: string;
          snapshot_digest: string;
          current_provider_id: string;
        }
      | undefined;
    if (
      target === undefined ||
      target.member_id !== plan.memberId ||
      target.provider_id !== plan.providerId ||
      target.current_provider_id !== plan.providerId ||
      target.snapshot_digest !== plan.previousSnapshotDigest
    ) {
      throw new Error("Provider update plan does not match persisted run authority");
    }
  }
}
