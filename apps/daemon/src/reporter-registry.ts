import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type AgentRun,
  type ProcessIdentityObservation,
  REPORTER_LEASE_MS,
  type ReporterReadinessCoverage,
  type ReporterSession,
  STATUS_PROTOCOL_VERSION,
} from "@nanasa/contracts";
import { ProviderAdapterRegistry } from "./providers/provider-adapter-registry.js";
import { DomainError, NanasaStore } from "./store.js";

export interface ReporterRegistryOptions {
  runtimeDirectory: string;
  adapters?: ProviderAdapterRegistry;
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
  readonly #adapters: ProviderAdapterRegistry;
  readonly #now: () => Date;

  public constructor(store: NanasaStore, options: ReporterRegistryOptions) {
    this.#store = store;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#adapters = options.adapters ?? ProviderAdapterRegistry.builtIn();
    this.#now = options.now ?? (() => new Date());
  }

  public open(run: AgentRun): ReporterSession {
    const current = this.#store.getCurrentReporterSession(run.id, run.generation);
    if (current !== undefined) return current;
    const profile = this.#store.getAgentProfile(run.agentProfileId);
    const adapter = this.#adapters.get(profile.kind);
    const openedAt = this.#now();
    const session: ReporterSession = {
      id: `reporter_${randomUUID()}`,
      providerId: profile.agentType,
      adapterId: adapter.id,
      reporterId: adapter.reporter.id,
      source: adapter.reporter.source,
      protocolVersion: STATUS_PROTOCOL_VERSION,
      reporterVersion: adapter.reporter.version,
      runId: run.id,
      generation: run.generation,
      reporterEpoch: `epoch_${randomUUID()}`,
      readinessCoverage: coverageFor(adapter.reporter.coverage),
      sourceSequence: 0,
      openedAt: openedAt.toISOString(),
      leaseExpiresAt: new Date(openedAt.getTime() + REPORTER_LEASE_MS).toISOString(),
    };
    return this.#store.registerReporterSession(session);
  }

  public environment(run: AgentRun): Readonly<Record<string, string>> {
    const session = this.open(run);
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

  public observeProcess(run: AgentRun, process: ProcessIdentityObservation): void {
    if (process.expectedProviderMatch !== "match") {
      this.#store.revokeReporterAuthority(run.id, run.generation, "provider_process_mismatch");
      throw new DomainError(
        "status_process_provider_mismatch",
        "The foreground process does not match the configured provider adapter",
        409,
      );
    }
    this.#store.bindReporterProcess(run.id, run.generation, process);
    const profile = this.#store.getAgentProfile(run.agentProfileId);
    const adapter = this.#adapters.get(profile.kind);
    if (!adapter.reporter.coverage.heartbeat) {
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
