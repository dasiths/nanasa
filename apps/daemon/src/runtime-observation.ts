import type { AgentRun } from "@nanasa/contracts";

export type RuntimeObservationKind = "present" | "dead" | "missing" | "indeterminate";

export interface RuntimeObservation {
  kind: RuntimeObservationKind;
  runId: string;
  generation: number;
  observedAt: string;
  evidence?: string;
  exitCode?: number;
  signal?: string;
}

export function runtimeObservation(
  run: AgentRun,
  kind: RuntimeObservationKind,
  options: Omit<RuntimeObservation, "kind" | "runId" | "generation" | "observedAt"> & {
    observedAt?: string;
  } = {},
): RuntimeObservation {
  return {
    kind,
    runId: run.id,
    generation: run.generation,
    observedAt: options.observedAt ?? new Date().toISOString(),
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}
