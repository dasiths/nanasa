import type { AgentStatusSource } from "@nanasa/contracts";

export interface ProviderReporterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly source: AgentStatusSource;
  readonly readinessEvents: readonly ["session.ready", ...string[]];
  readonly coverage: Readonly<{
    session: boolean;
    turns: boolean;
    tools: boolean;
    waits: boolean;
    effectiveModel: boolean;
    heartbeat: boolean;
  }>;
}

export function freezeReporterDescriptor(
  descriptor: ProviderReporterDescriptor,
): ProviderReporterDescriptor {
  return Object.freeze({
    ...descriptor,
    readinessEvents: Object.freeze([...descriptor.readinessEvents]) as unknown as readonly [
      "session.ready",
      ...string[],
    ],
    coverage: Object.freeze({ ...descriptor.coverage }),
  });
}
