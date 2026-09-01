import type { AgentStatusEventKind, AgentStatusSource } from "@nanasa/contracts";

export interface ProviderReporterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly source: AgentStatusSource;
  readonly readinessEvents: readonly ["session.ready", ...string[]];
  readonly events: readonly AgentStatusEventKind[];
  readonly coverage: Readonly<{
    session: boolean;
    turns: boolean;
    tools: boolean;
    waits: boolean;
    effectiveModel: boolean;
    heartbeat: boolean;
    actionCorrelation: boolean;
  }>;
}

export function freezeReporterDescriptor(
  descriptor: ProviderReporterDescriptor,
): ProviderReporterDescriptor {
  const events = new Set(descriptor.events);
  if (events.size !== descriptor.events.length) {
    throw new Error("Provider reporter event coverage must not contain duplicates");
  }
  if (descriptor.readinessEvents.some((event) => !events.has(event as AgentStatusEventKind))) {
    throw new Error("Provider reporter readiness must name a declared event");
  }
  const expectedCoverage = {
    session: events.has("session.ready") && events.has("session.ended"),
    turns: events.has("turn.started") && events.has("turn.settled"),
    tools: events.has("tool.started") && events.has("tool.finished") && events.has("tool.failed"),
    waits: events.has("wait.opened") && events.has("wait.closed"),
    heartbeat: events.has("heartbeat"),
  };
  for (const [name, expected] of Object.entries(expectedCoverage)) {
    if (descriptor.coverage[name as keyof typeof expectedCoverage] !== expected) {
      throw new Error(`Provider reporter ${name} coverage must match declared events`);
    }
  }
  return Object.freeze({
    ...descriptor,
    readinessEvents: Object.freeze([...descriptor.readinessEvents]) as unknown as readonly [
      "session.ready",
      ...string[],
    ],
    events: Object.freeze([...descriptor.events]),
    coverage: Object.freeze({ ...descriptor.coverage }),
  });
}
