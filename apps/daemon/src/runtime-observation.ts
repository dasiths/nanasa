import { randomUUID } from "node:crypto";
import type {
  AgentRun,
  ProcessIdentityObservation,
  RuntimeStatusObservation,
} from "@nanasa/contracts";

export type RuntimeObservationKind = "present" | "dead" | "missing" | "indeterminate";
export type RuntimeObservation = RuntimeStatusObservation;

export function runtimeObservation(
  run: AgentRun,
  state: RuntimeObservationKind,
  options: {
    observedAt?: string;
    trigger?: RuntimeObservation["trigger"];
    evidenceCode: string;
    process?: ProcessIdentityObservation;
    exitCode?: number;
    signal?: string;
  },
): RuntimeObservation {
  return {
    id: `runtime_${randomUUID()}`,
    state,
    runId: run.id,
    generation: run.generation,
    observedAt: options.observedAt ?? new Date().toISOString(),
    trigger: options.trigger ?? "poll",
    evidenceCode: options.evidenceCode,
    ...(options.process === undefined ? {} : { process: options.process }),
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}
