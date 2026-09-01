import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  type ReporterEventV3,
  ReporterEventV3Schema,
  type RunProviderBinding,
} from "@nanasa/contracts";
import type { ResolvedProviderAdapter } from "./resolved-provider-adapter.js";

export interface ReporterEventAdmissionResult {
  readonly event: ReporterEventV3;
  readonly duplicate: boolean;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class ProviderReporterEventAdmission {
  readonly #database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.#database = database;
  }

  public admit(
    binding: RunProviderBinding,
    snapshot: ResolvedProviderAdapter,
    input: unknown,
    acceptedAt = new Date().toISOString(),
  ): ReporterEventAdmissionResult {
    const event = ReporterEventV3Schema.parse(input);
    if (
      event.runId !== binding.runId ||
      event.generation !== binding.generation ||
      event.integrationId !== binding.integrationId ||
      event.providerId !== binding.providerId ||
      event.adapterId !== binding.adapterId ||
      event.snapshotDigest !== binding.snapshotDigest ||
      snapshot.digest !== binding.snapshotDigest
    ) {
      throw new Error("Reporter event does not match the immutable run binding");
    }
    const reporter = snapshot.body.capabilities.find((capability) => capability.id === "reporter")
      ?.payload as
      | {
          driverId?: string;
          sourceId?: string;
          events?: string[];
          rootSessionPolicy?: "single" | "qualified-root" | "none";
        }
      | undefined;
    if (
      reporter === undefined ||
      reporter.driverId !== event.reporterId ||
      reporter.sourceId !== event.source ||
      reporter.events?.includes(event.event) !== true
    ) {
      throw new Error("Reporter event is not admitted by the pinned reporter capability");
    }
    if (
      reporter.rootSessionPolicy === "qualified-root" &&
      !["reporter.ready", "heartbeat"].includes(event.event) &&
      event.rootSessionId === undefined
    ) {
      throw new Error("Reporter event requires a qualified root session");
    }
    const process = this.#database
      .prepare(
        `SELECT 1 FROM provider_process_incarnations
         WHERE digest = ? AND binding_id = ? AND run_id = ? AND generation = ?
           AND snapshot_digest = ? AND ended_at IS NULL`,
      )
      .get(
        event.processIncarnationDigest,
        binding.id,
        binding.runId,
        binding.generation,
        binding.snapshotDigest,
      );
    if (process === undefined) throw new Error("Reporter process incarnation is not authoritative");
    const reporterAuthority = this.#database
      .prepare(
        `SELECT 1 FROM provider_authority_fences
         WHERE record_type = 'reporter-session' AND record_id = ? AND binding_id = ?
           AND run_id = ? AND generation = ? AND snapshot_digest = ?
           AND process_incarnation_digest = ?`,
      )
      .get(
        event.reporterSessionId,
        binding.id,
        binding.runId,
        binding.generation,
        binding.snapshotDigest,
        event.processIncarnationDigest,
      );
    if (reporterAuthority === undefined) {
      throw new Error("Reporter session is not authoritative for the run binding");
    }
    const session = this.#database
      .prepare(
        `SELECT root_session_id FROM provider_reporter_sessions
         WHERE id = ? AND binding_id = ? AND run_id = ? AND generation = ?
           AND snapshot_digest = ? AND process_incarnation_digest = ?
           AND reporter_id = ? AND source_id = ? AND reporter_epoch = ? AND state = 'active'`,
      )
      .get(
        event.reporterSessionId,
        binding.id,
        binding.runId,
        binding.generation,
        binding.snapshotDigest,
        event.processIncarnationDigest,
        event.reporterId,
        event.source,
        event.reporterEpoch,
      ) as { root_session_id: string | null } | undefined;
    if (session === undefined) throw new Error("Reporter session identity or epoch is not active");
    if (reporter.rootSessionPolicy === "qualified-root" && session.root_session_id === null) {
      throw new Error("Qualified reporter session has no admitted root identity");
    }
    if (event.rootSessionId !== undefined && event.rootSessionId !== session.root_session_id) {
      throw new Error("Reporter event root session does not match its admitted session");
    }
    const payloadDigest = digest(event);
    const existing = this.#database
      .prepare(`SELECT payload_digest FROM provider_reporter_event_receipts WHERE event_id = ?`)
      .get(event.eventId) as { payload_digest: string } | undefined;
    if (existing !== undefined) {
      if (existing.payload_digest !== payloadDigest) {
        throw new Error("Reporter event ID was reused with a different payload");
      }
      return Object.freeze({ event, duplicate: true });
    }
    const latest = this.#database
      .prepare(
        `SELECT max(source_sequence) AS sequence FROM provider_reporter_event_receipts
         WHERE binding_id = ? AND reporter_session_id = ? AND reporter_epoch = ?`,
      )
      .get(binding.id, event.reporterSessionId, event.reporterEpoch) as {
      sequence: number | null;
    };
    if (latest.sequence !== null && event.sourceSequence <= latest.sequence) {
      throw new Error("Reporter event source sequence is reordered");
    }
    this.#database
      .prepare(
        `INSERT INTO provider_reporter_event_receipts
          (event_id,binding_id,run_id,generation,snapshot_digest,process_incarnation_digest,
           reporter_session_id,reporter_epoch,source_sequence,event_kind,payload_digest,accepted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.eventId,
        binding.id,
        binding.runId,
        binding.generation,
        binding.snapshotDigest,
        event.processIncarnationDigest,
        event.reporterSessionId,
        event.reporterEpoch,
        event.sourceSequence,
        event.event,
        payloadDigest,
        acceptedAt,
      );
    return Object.freeze({ event, duplicate: false });
  }
}
