import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type AgentRun,
  AgentStatusSourceSchema,
  type ProcessIdentityObservation,
  REPORTER_LEASE_MS,
  type ReporterReadinessCoverage,
  type ReporterSession,
  STATUS_PROTOCOL_VERSION,
} from "@nanasa/contracts";
import type { AgentRuntimeProvisioner } from "./agent-runtime-provisioner.js";
import { DomainError, NanasaStore } from "./store.js";

export interface ReporterRegistryOptions {
  runtimeDirectory: string;
  authority: Pick<AgentRuntimeProvisioner, "reporterPolicy">;
  now?: () => Date;
}

function coverageFor(values: {
  session: boolean;
  turns: boolean;
  tools: boolean;
  waits: boolean;
}): ReporterReadinessCoverage {
  if (!values.session) return "session_only";
  return values.turns && values.tools && values.waits ? "full" : "partial";
}

export class ReporterRegistry {
  readonly #store: NanasaStore;
  readonly #runtimeDirectory: string;
  readonly #authority: ReporterRegistryOptions["authority"];
  readonly #now: () => Date;

  public constructor(store: NanasaStore, options: ReporterRegistryOptions) {
    this.#store = store;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#authority = options.authority;
    this.#now = options.now ?? (() => new Date());
  }

  public async open(run: AgentRun): Promise<ReporterSession> {
    const current = this.#store.getCurrentReporterSession(run.id, run.generation);
    if (current !== undefined) return current;
    const reporter = await this.#authority.reporterPolicy(run);
    const openedAt = this.#now();
    const session: ReporterSession = {
      id: `reporter_${randomUUID()}`,
      providerId: reporter.integrationId,
      adapterId: reporter.adapterId,
      reporterId: reporter.reporterId,
      source: AgentStatusSourceSchema.parse(reporter.source),
      protocolVersion: STATUS_PROTOCOL_VERSION,
      reporterVersion: reporter.reporterVersion,
      runId: run.id,
      generation: run.generation,
      reporterEpoch: `epoch_${randomUUID()}`,
      readinessCoverage: coverageFor({
        session: reporter.events.some((event) => event.startsWith("session.")),
        turns: reporter.events.some((event) => event.startsWith("turn.")),
        tools: reporter.events.some((event) => event.startsWith("tool.")),
        waits: reporter.events.some((event) => event.startsWith("wait.")),
      }),
      sourceSequence: 0,
      openedAt: openedAt.toISOString(),
      leaseExpiresAt: new Date(openedAt.getTime() + REPORTER_LEASE_MS).toISOString(),
    };
    return this.#store.registerReporterSession(session);
  }

  public async environment(run: AgentRun): Promise<Readonly<Record<string, string>>> {
    const session = await this.open(run);
    return Object.freeze({
      NANASA_REPORTER_PROVIDER_ID: session.providerId,
      NANASA_REPORTER_ADAPTER_ID: session.adapterId,
      NANASA_REPORTER_ID: session.reporterId,
      NANASA_REPORTER_SOURCE: session.source,
      NANASA_REPORTER_PROTOCOL_VERSION: String(session.protocolVersion),
      NANASA_REPORTER_VERSION: session.reporterVersion,
      NANASA_REPORTER_RUN_ID: session.runId,
      NANASA_REPORTER_GENERATION: String(session.generation),
      NANASA_REPORTER_EPOCH: session.reporterEpoch,
      NANASA_REPORTER_SEQUENCE_FILE: join(
        this.#runtimeDirectory,
        "reporters",
        run.id,
        `${session.reporterEpoch}.sequence.json`,
      ),
    });
  }

  public async observeProcess(run: AgentRun, process: ProcessIdentityObservation): Promise<void> {
    if (process.expectedProviderMatch !== "match") {
      this.#store.revokeReporterAuthority(run.id, run.generation, "provider_process_mismatch");
      throw new DomainError(
        "status_process_provider_mismatch",
        "The foreground process does not match the configured provider adapter",
        409,
      );
    }
    this.#store.bindReporterProcess(run.id, run.generation, process);
    const reporter = await this.#authority.reporterPolicy(run);
    if (!reporter.events.includes("heartbeat")) {
      this.#store.refreshReporterLease(
        run.id,
        run.generation,
        new Date(this.#now().getTime() + REPORTER_LEASE_MS).toISOString(),
      );
    }
  }

  public revoke(run: AgentRun, reason: string): void {
    this.#store.revokeReporterAuthority(run.id, run.generation, reason);
  }
}
