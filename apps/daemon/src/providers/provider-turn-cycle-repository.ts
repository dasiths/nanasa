import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  type ReporterTurnCycleV3,
  ReporterTurnCycleV3Schema,
  type RunProviderBinding,
} from "@nanasa/contracts";
import type { ReporterEventAdmissionResult } from "./provider-reporter-event-admission.js";

interface CycleRow {
  readonly id: string;
  readonly binding_id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly provider_id: string;
  readonly snapshot_digest: string;
  readonly process_incarnation_digest: string;
  readonly reporter_session_id: string;
  readonly root_session_id: string;
  readonly turn_id: string;
  readonly state: ReporterTurnCycleV3["state"];
  readonly open_tool_count: number;
  readonly open_wait_count: number;
  readonly completion_revision: number;
  readonly opened_at: string;
  readonly settled_at: string | null;
  readonly closed_at: string | null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function fromRow(row: CycleRow): ReporterTurnCycleV3 {
  return ReporterTurnCycleV3Schema.parse({
    id: row.id,
    fence: {
      bindingId: row.binding_id,
      runId: row.run_id,
      generation: row.generation,
      providerId: row.provider_id,
      snapshotDigest: row.snapshot_digest,
      processIncarnationDigest: row.process_incarnation_digest,
    },
    reporterSessionId: row.reporter_session_id,
    rootSessionId: row.root_session_id,
    turnId: row.turn_id,
    state: row.state,
    openToolCount: row.open_tool_count,
    openWaitCount: row.open_wait_count,
    completionRevision: row.completion_revision,
    openedAt: row.opened_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  });
}

export class ProviderTurnCycleRepository {
  readonly #database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.#database = database;
  }

  public apply(
    binding: RunProviderBinding,
    admission: ReporterEventAdmissionResult,
  ): ReporterTurnCycleV3 | undefined {
    const event = admission.event;
    if (admission.duplicate) return this.#currentForEvent(binding, event);
    if (event.event === "session.ended") {
      this.#database
        .prepare(
          `UPDATE reporter_turn_cycles SET state = 'abandoned', closed_at = ?
           WHERE binding_id = ? AND reporter_session_id = ?
             AND state IN ('open','waiting','settling')`,
        )
        .run(event.occurredAt ?? new Date().toISOString(), binding.id, event.reporterSessionId);
      return undefined;
    }
    if (
      !event.event.startsWith("turn.") &&
      !event.event.startsWith("tool.") &&
      !event.event.startsWith("wait.")
    ) {
      return undefined;
    }
    if (event.rootSessionId === undefined || event.turnId === undefined) {
      throw new Error("Reporter turn-cycle event requires root session and turn identity");
    }
    if (event.event === "turn.started") {
      const openedAt = event.occurredAt ?? new Date().toISOString();
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database
          .prepare(
            `UPDATE reporter_turn_cycles SET state = 'abandoned', closed_at = ?
             WHERE binding_id = ? AND reporter_session_id = ? AND root_session_id = ?
               AND turn_id <> ? AND state IN ('open','waiting','settling')`,
          )
          .run(openedAt, binding.id, event.reporterSessionId, event.rootSessionId, event.turnId);
        const existing = this.#currentForEvent(binding, event);
        if (existing === undefined) {
          const completionRevision = (
            this.#database
              .prepare(
                "SELECT coalesce(max(completion_revision), 0) AS value FROM reporter_turn_cycles WHERE binding_id = ?",
              )
              .get(binding.id) as { value: number }
          ).value;
          this.#database
            .prepare(
              `INSERT INTO reporter_turn_cycles
                (id,binding_id,run_id,generation,snapshot_digest,process_incarnation_digest,
                 reporter_session_id,root_session_id,turn_id,state,open_tool_count,
                 open_wait_count,completion_revision,opened_at)
               VALUES (?,?,?,?,?,?,?,?,?,'open',0,0,?,?)`,
            )
            .run(
              `turn-cycle-${digest({ bindingId: binding.id, reporterSessionId: event.reporterSessionId, rootSessionId: event.rootSessionId, turnId: event.turnId }).slice(0, 48)}`,
              binding.id,
              binding.runId,
              binding.generation,
              binding.snapshotDigest,
              event.processIncarnationDigest,
              event.reporterSessionId,
              event.rootSessionId,
              event.turnId,
              completionRevision,
              openedAt,
            );
        }
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
      return this.#currentForEvent(binding, event);
    }
    const cycle = this.#currentForEvent(binding, event);
    if (cycle === undefined || ["closed", "abandoned"].includes(cycle.state)) {
      throw new Error("Reporter event has no open root turn cycle");
    }
    let openTools = cycle.openToolCount;
    let openWaits = cycle.openWaitCount;
    let state = cycle.state;
    const occurredAt = event.occurredAt ?? new Date().toISOString();
    if (event.event === "tool.started") {
      const inserted = this.#database
        .prepare(
          "INSERT OR IGNORE INTO reporter_turn_open_tools (cycle_id,operation_id,opened_at) VALUES (?,?,?)",
        )
        .run(cycle.id, event.operationId!, occurredAt);
      if (inserted.changes !== 1) throw new Error("Reporter tool identity is already open");
      openTools += 1;
    } else if (event.event === "tool.finished" || event.event === "tool.failed") {
      const deleted = this.#database
        .prepare("DELETE FROM reporter_turn_open_tools WHERE cycle_id = ? AND operation_id = ?")
        .run(cycle.id, event.operationId!);
      if (deleted.changes !== 1) throw new Error("Reporter tool closure does not match open work");
      openTools = Math.max(0, openTools - 1);
    } else if (event.event === "wait.opened") {
      const inserted = this.#database
        .prepare(
          "INSERT OR IGNORE INTO reporter_turn_open_waits (cycle_id,request_id,opened_at) VALUES (?,?,?)",
        )
        .run(cycle.id, event.requestId!, occurredAt);
      if (inserted.changes !== 1) throw new Error("Reporter wait identity is already open");
      openWaits += 1;
      state = "waiting";
    } else if (event.event === "wait.closed") {
      const deleted = this.#database
        .prepare("DELETE FROM reporter_turn_open_waits WHERE cycle_id = ? AND request_id = ?")
        .run(cycle.id, event.requestId!);
      if (deleted.changes !== 1)
        throw new Error("Reporter wait closure does not match an open wait");
      openWaits = Math.max(0, openWaits - 1);
      if (state === "waiting" && openWaits === 0) state = "open";
    } else if (event.event === "turn.waiting") state = "waiting";
    else if (event.event === "turn.settled") state = "settling";
    const closes = state === "settling" && openTools === 0 && openWaits === 0;
    const updated = this.#database
      .prepare(
        `UPDATE reporter_turn_cycles SET state = ?, open_tool_count = ?, open_wait_count = ?,
           completion_revision = completion_revision + ?, settled_at = ?, closed_at = ?
         WHERE id = ? AND state IN ('open','waiting','settling')`,
      )
      .run(
        closes ? "closed" : state,
        openTools,
        openWaits,
        closes ? 1 : 0,
        event.event === "turn.settled" ? occurredAt : (cycle.settledAt ?? null),
        closes ? occurredAt : null,
        cycle.id,
      );
    if (updated.changes !== 1) {
      throw new Error("Reporter turn cycle changed before the event could be applied");
    }
    return this.get(cycle.id);
  }

  public get(cycleId: string): ReporterTurnCycleV3 | undefined {
    const row = this.#database
      .prepare(
        `SELECT cycle.*, binding.provider_id
         FROM reporter_turn_cycles AS cycle
         JOIN run_provider_bindings AS binding ON binding.id = cycle.binding_id
         WHERE cycle.id = ?`,
      )
      .get(cycleId) as CycleRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  #currentForEvent(
    binding: RunProviderBinding,
    event: ReporterEventAdmissionResult["event"],
  ): ReporterTurnCycleV3 | undefined {
    if (event.rootSessionId === undefined || event.turnId === undefined) return undefined;
    const row = this.#database
      .prepare(
        `SELECT cycle.*, binding.provider_id
         FROM reporter_turn_cycles AS cycle
         JOIN run_provider_bindings AS binding ON binding.id = cycle.binding_id
         WHERE cycle.binding_id = ? AND cycle.reporter_session_id = ?
           AND cycle.root_session_id = ? AND cycle.turn_id = ?`,
      )
      .get(binding.id, event.reporterSessionId, event.rootSessionId, event.turnId) as
      | CycleRow
      | undefined;
    return row === undefined ? undefined : fromRow(row);
  }
}
