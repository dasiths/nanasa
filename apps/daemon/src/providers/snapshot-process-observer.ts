import type { ProviderProcessIncarnation } from "@nanasa/contracts";
import { ProcessIdentityObserver } from "../process-identity-observer.js";
import { ProviderProcessIncarnationRepository } from "./provider-process-incarnation-repository.js";
import { ProviderReporterDriverRegistry } from "./provider-reporter-driver-registry.js";
import { ProviderRunBindingRepository } from "./provider-run-binding-repository.js";
import { ProviderSnapshotEvaluator } from "./provider-snapshot-evaluator.js";

export interface SnapshotProcessObservationRequest {
  readonly runId: string;
  readonly generation: number;
  readonly paneId: string;
  readonly panePid: number;
  readonly observedAt?: string;
}

export class SnapshotProcessObserver {
  readonly #bindings: ProviderRunBindingRepository;
  readonly #incarnations: ProviderProcessIncarnationRepository;
  readonly #processes: ProcessIdentityObserver;
  readonly #maximumConcurrency: number;

  public constructor(
    bindings: ProviderRunBindingRepository,
    incarnations: ProviderProcessIncarnationRepository,
    processes = new ProcessIdentityObserver(),
    maximumConcurrency = 16,
  ) {
    if (
      !Number.isInteger(maximumConcurrency) ||
      maximumConcurrency < 1 ||
      maximumConcurrency > 64
    ) {
      throw new Error("Snapshot process observation concurrency must be between 1 and 64");
    }
    this.#bindings = bindings;
    this.#incarnations = incarnations;
    this.#processes = processes;
    this.#maximumConcurrency = maximumConcurrency;
  }

  public async observeBatch(
    requests: readonly SnapshotProcessObservationRequest[],
  ): Promise<readonly ProviderProcessIncarnation[]> {
    const results = new Array<ProviderProcessIncarnation>(requests.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < requests.length) {
        const index = nextIndex;
        nextIndex += 1;
        const request = requests[index]!;
        const recovered = await this.#bindings.requireForRecovery(
          request.runId,
          request.generation,
        );
        const evaluator = new ProviderSnapshotEvaluator(
          recovered.snapshot,
          ProviderReporterDriverRegistry.fromSnapshot(recovered.snapshot),
        );
        const observation = await this.#processes.observe(request.panePid, {
          recognizeCommand: (command) => evaluator.matchesObservedProcess(command),
        });
        results[index] = this.#incarnations.record(
          recovered.binding,
          request.paneId,
          observation,
          request.observedAt,
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#maximumConcurrency, requests.length) }, async () =>
        worker(),
      ),
    );
    return Object.freeze(results);
  }
}
