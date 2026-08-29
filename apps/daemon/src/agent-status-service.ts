import type {
  AgentStatusEventInput,
  RuntimeStatusObservation,
  ScreenObservation,
} from "@nanasa/contracts";
import { ReporterRegistry } from "./reporter-registry.js";
import { DomainError, type AgentStatusIdentity, NanasaStore } from "./store.js";

export class AgentStatusService {
  readonly #store: NanasaStore;
  readonly #reporters: ReporterRegistry;
  readonly #lastProcessEvidence = new Map<string, string>();

  public constructor(store: NanasaStore, reporters: ReporterRegistry) {
    this.#store = store;
    this.#reporters = reporters;
  }

  public ingestReporter(identity: AgentStatusIdentity, event: AgentStatusEventInput) {
    try {
      return this.#store.ingestAgentStatusEvent(identity, event);
    } catch (error) {
      this.#store.recordReporterRejection(
        event,
        error instanceof DomainError ? error.code : "status_reporter_rejected",
      );
      throw error;
    }
  }

  public observeRuntime(observation: RuntimeStatusObservation): void {
    const run = this.#store.getRun(observation.runId);
    if (run.generation !== observation.generation) return;
    const evidence = `${observation.state}:${observation.process?.processFingerprint ?? "none"}:${observation.exitCode ?? ""}:${observation.signal ?? ""}`;
    if (this.#lastProcessEvidence.get(run.id) === evidence) return;
    this.#lastProcessEvidence.set(run.id, evidence);
    if (observation.state === "present") {
      if (observation.process === undefined) {
        this.#store.recordProcessStatus(run.id, {
          event: "process.indeterminate",
          eventId: observation.id,
          observedAt: observation.observedAt,
        });
        return;
      }
      try {
        this.#reporters.observeProcess(run, observation.process);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "status_process_provider_mismatch")) {
          throw error;
        }
      }
      this.#store.recordProcessStatus(run.id, {
        event: "process.alive",
        eventId: observation.id,
        observedAt: observation.observedAt,
        process: observation.process,
      });
      return;
    }
    if (observation.state === "indeterminate") {
      this.#store.recordProcessStatus(run.id, {
        event: "process.indeterminate",
        eventId: observation.id,
        observedAt: observation.observedAt,
      });
      return;
    }
    this.#reporters.revoke(run, `process_${observation.state}`);
    if (observation.state === "dead") {
      this.#store.recordProcessStatus(run.id, {
        event: "process.exited",
        eventId: observation.id,
        observedAt: observation.observedAt,
        ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
        ...(observation.signal === undefined ? {} : { signal: observation.signal }),
        operatorStopped: run.desiredState !== "running",
      });
    } else {
      this.#store.recordProcessStatus(run.id, {
        event: "process.missing",
        eventId: observation.id,
        observedAt: observation.observedAt,
      });
    }
  }

  public observeScreen(observation: ScreenObservation) {
    return this.#store.recordScreenObservation(observation.runId, observation);
  }
}
