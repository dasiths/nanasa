import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  type ProviderOperationAudit,
  ProviderOperationAuditSchema,
  type RunProviderBinding,
} from "@nanasa/contracts";
import type { ResolvedProviderAdapter } from "./resolved-provider-adapter.js";

export interface SelectedProviderOperation {
  readonly operationId: string;
  readonly kind: "prompt" | "wait-reply" | "interrupt" | "cancel" | "acknowledgement";
  readonly transport: string;
  readonly codecId: string;
  readonly acknowledgement: "none" | "transport" | "reporter" | "operation-result";
}

export interface BeginProviderOperationInput {
  readonly binding: RunProviderBinding;
  readonly processIncarnationDigest: string;
  readonly operation: SelectedProviderOperation;
  readonly idempotencyKey: string;
  readonly targetHandles: readonly string[];
  readonly input: unknown;
  readonly startedAt?: string;
}

interface AuditRow {
  readonly id: string;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly snapshot_digest: string;
  readonly process_incarnation_digest: string | null;
  readonly target_handles_json: string;
  readonly state: ProviderOperationAudit["state"];
  readonly input_digest: string;
  readonly output_digest: string | null;
  readonly safe_error_code: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function capability<T>(snapshot: ResolvedProviderAdapter, id: string): T {
  const selected = snapshot.body.capabilities.find((item) => item.id === id);
  if (selected === undefined) throw new Error(`Provider snapshot is missing ${id} capability`);
  return selected.payload as T;
}

function fromRow(row: AuditRow): ProviderOperationAudit {
  return ProviderOperationAuditSchema.parse({
    id: row.id,
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    snapshotDigest: row.snapshot_digest,
    ...(row.process_incarnation_digest === null
      ? {}
      : { processIncarnationDigest: row.process_incarnation_digest }),
    targetHandles: JSON.parse(row.target_handles_json),
    state: row.state,
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.safe_error_code === null ? {} : { safeErrorCode: row.safe_error_code }),
    inputDigest: row.input_digest,
    ...(row.output_digest === null ? {} : { outputDigest: row.output_digest }),
  });
}

export class ProviderOperationSelector {
  readonly #snapshot: ResolvedProviderAdapter;

  public constructor(snapshot: ResolvedProviderAdapter) {
    this.#snapshot = snapshot;
  }

  public select(
    kind: SelectedProviderOperation["kind"],
    transport: string,
  ): SelectedProviderOperation {
    const control = capability<{ operations: SelectedProviderOperation[] }>(
      this.#snapshot,
      "control",
    );
    const matches = control.operations.filter(
      (operation) => operation.kind === kind && operation.transport === transport,
    );
    if (matches.length === 0) {
      throw new Error(
        `Provider operation is unavailable for exact transport: ${kind}/${transport}`,
      );
    }
    if (matches.length !== 1) {
      throw new Error(`Provider operation selection is ambiguous: ${kind}/${transport}`);
    }
    const selected = matches[0]!;
    if (kind === "wait-reply") {
      const reporter = capability<{ waitTransports: string[] }>(this.#snapshot, "reporter");
      if (!reporter.waitTransports.includes(selected.transport)) {
        throw new Error("Wait reply transport is not admitted by the reporter capability");
      }
    }
    return Object.freeze({ ...selected });
  }
}

export class ProviderOperationAuditRepository {
  readonly #database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.#database = database;
  }

  public begin(input: BeginProviderOperationInput): ProviderOperationAudit {
    const inputDigest = digest(input.input);
    const existing = this.#byIdempotency(
      input.binding.snapshotDigest,
      input.operation.operationId,
      input.idempotencyKey,
    );
    if (existing !== undefined) {
      if (
        existing.inputDigest !== inputDigest ||
        existing.processIncarnationDigest !== input.processIncarnationDigest ||
        canonicalJson(existing.targetHandles) !== canonicalJson(input.targetHandles)
      ) {
        throw new Error(
          "Provider operation idempotency replay does not match the original request",
        );
      }
      return existing;
    }
    const process = this.#database
      .prepare(
        `SELECT 1 FROM provider_process_incarnations
         WHERE digest = ? AND binding_id = ? AND run_id = ? AND generation = ?
           AND snapshot_digest = ? AND ended_at IS NULL`,
      )
      .get(
        input.processIncarnationDigest,
        input.binding.id,
        input.binding.runId,
        input.binding.generation,
        input.binding.snapshotDigest,
      );
    if (process === undefined) {
      throw new Error("Provider operation process incarnation is not authoritative");
    }
    const audit = ProviderOperationAuditSchema.parse({
      id: `provider-operation-${digest({ snapshotDigest: input.binding.snapshotDigest, operationId: input.operation.operationId, idempotencyKey: input.idempotencyKey }).slice(0, 48)}`,
      operationId: input.operation.operationId,
      idempotencyKey: input.idempotencyKey,
      snapshotDigest: input.binding.snapshotDigest,
      processIncarnationDigest: input.processIncarnationDigest,
      targetHandles: input.targetHandles,
      state: "started",
      startedAt: input.startedAt ?? new Date().toISOString(),
      inputDigest,
    });
    this.#database
      .prepare(
        `INSERT INTO provider_operation_audits
          (id,operation_id,idempotency_key,snapshot_digest,binding_id,run_id,generation,
           process_incarnation_digest,target_handles_json,state,input_digest,started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        audit.id,
        audit.operationId,
        audit.idempotencyKey,
        audit.snapshotDigest,
        input.binding.id,
        input.binding.runId,
        input.binding.generation,
        input.processIncarnationDigest,
        canonicalJson(audit.targetHandles),
        audit.state,
        audit.inputDigest,
        audit.startedAt,
      );
    return audit;
  }

  public complete(
    auditId: string,
    state: Exclude<ProviderOperationAudit["state"], "started">,
    options: {
      readonly output?: unknown;
      readonly safeErrorCode?: string;
      readonly completedAt?: string;
    } = {},
  ): ProviderOperationAudit {
    const completedAt = options.completedAt ?? new Date().toISOString();
    const outputDigest = options.output === undefined ? undefined : digest(options.output);
    const result = this.#database
      .prepare(
        `UPDATE provider_operation_audits
         SET state = ?, output_digest = ?, safe_error_code = ?, completed_at = ?
         WHERE id = ? AND state = 'started'`,
      )
      .run(state, outputDigest ?? null, options.safeErrorCode ?? null, completedAt, auditId);
    const completed = this.get(auditId);
    if (completed === undefined) throw new Error("Provider operation audit is unavailable");
    if (result.changes === 0 && completed.state !== state) {
      throw new Error("Provider operation audit is already terminal with a different outcome");
    }
    return completed;
  }

  public get(auditId: string): ProviderOperationAudit | undefined {
    const row = this.#database
      .prepare("SELECT * FROM provider_operation_audits WHERE id = ?")
      .get(auditId) as AuditRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  #byIdempotency(
    snapshotDigest: string,
    operationId: string,
    idempotencyKey: string,
  ): ProviderOperationAudit | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM provider_operation_audits
         WHERE snapshot_digest = ? AND operation_id = ? AND idempotency_key = ?`,
      )
      .get(snapshotDigest, operationId, idempotencyKey) as AuditRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }
}
