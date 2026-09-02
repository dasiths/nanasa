import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  type ProcessIdentityObservation,
  type ProviderProcessIncarnation,
  ProviderProcessIncarnationSchema,
  type RunProviderBinding,
} from "@nanasa/contracts";

interface IncarnationRow {
  readonly digest: string;
  readonly binding_id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly provider_id: string;
  readonly snapshot_digest: string;
  readonly pane_id: string;
  readonly foreground_pgid: number;
  readonly leader_pid: number;
  readonly pid_start_identity: string;
  readonly observed_at: string;
  readonly ended_at: string | null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function fromRow(row: IncarnationRow): ProviderProcessIncarnation {
  return ProviderProcessIncarnationSchema.parse({
    digest: row.digest,
    fence: {
      bindingId: row.binding_id,
      runId: row.run_id,
      generation: row.generation,
      providerId: row.provider_id,
      snapshotDigest: row.snapshot_digest,
    },
    paneId: row.pane_id,
    foregroundPgid: row.foreground_pgid,
    leaderPid: row.leader_pid,
    pidStartIdentity: row.pid_start_identity,
    observedAt: row.observed_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  });
}

export class ProviderProcessIncarnationRepository {
  readonly #database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.#database = database;
  }

  public record(
    binding: RunProviderBinding,
    paneId: string,
    observation: ProcessIdentityObservation,
    observedAt = new Date().toISOString(),
  ): ProviderProcessIncarnation {
    if (observation.expectedProviderMatch !== "match") {
      throw new Error("Observed process does not match the pinned provider snapshot");
    }
    const incarnationDigest = digest({
      bindingId: binding.id,
      snapshotDigest: binding.snapshotDigest,
      paneId,
      foregroundPgid: observation.foregroundPgid,
      leaderPid: observation.leaderPid,
      pidStartIdentity: observation.pidStartIdentity,
    });
    const incarnation = ProviderProcessIncarnationSchema.parse({
      digest: incarnationDigest,
      fence: {
        bindingId: binding.id,
        runId: binding.runId,
        generation: binding.generation,
        providerId: binding.providerId,
        snapshotDigest: binding.snapshotDigest,
      },
      paneId,
      foregroundPgid: observation.foregroundPgid,
      leaderPid: observation.leaderPid,
      pidStartIdentity: observation.pidStartIdentity,
      observedAt,
    });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#active(binding.id, paneId);
      if (current?.digest === incarnation.digest) {
        this.#database.exec("COMMIT");
        return current;
      }
      if (current !== undefined) {
        this.#database
          .prepare(
            `UPDATE provider_process_incarnations SET ended_at = ?
             WHERE digest = ? AND ended_at IS NULL`,
          )
          .run(observedAt, current.digest);
      }
      this.#database
        .prepare(
          `INSERT INTO provider_process_incarnations
            (digest,binding_id,run_id,generation,snapshot_digest,pane_id,foreground_pgid,
             leader_pid,pid_start_identity,observed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          incarnation.digest,
          binding.id,
          binding.runId,
          binding.generation,
          binding.snapshotDigest,
          incarnation.paneId,
          incarnation.foregroundPgid,
          incarnation.leaderPid,
          incarnation.pidStartIdentity,
          incarnation.observedAt,
        );
      this.#database.exec("COMMIT");
      return incarnation;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public get(digestValue: string): ProviderProcessIncarnation | undefined {
    const row = this.#database
      .prepare(
        `SELECT incarnation.*, binding.provider_id
         FROM provider_process_incarnations AS incarnation
         JOIN run_provider_bindings AS binding ON binding.id = incarnation.binding_id
         WHERE incarnation.digest = ?`,
      )
      .get(digestValue) as IncarnationRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  #active(bindingId: string, paneId: string): ProviderProcessIncarnation | undefined {
    const row = this.#database
      .prepare(
        `SELECT incarnation.*, binding.provider_id
         FROM provider_process_incarnations AS incarnation
         JOIN run_provider_bindings AS binding ON binding.id = incarnation.binding_id
         WHERE incarnation.binding_id = ? AND incarnation.pane_id = ?
           AND incarnation.ended_at IS NULL`,
      )
      .get(bindingId, paneId) as IncarnationRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }
}
