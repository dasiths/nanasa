import type { AgentRun, TerminalBinding } from "@nanasa/contracts";
import type { RuntimeObservation } from "../runtime-observation.js";

export interface RuntimeLaunchRequest {
  readonly run: AgentRun;
  readonly argv: readonly string[];
  readonly workingDirectory?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly size: Readonly<{ cols: number; rows: number }>;
}

export interface RuntimeBackend {
  launch(request: RuntimeLaunchRequest): Promise<TerminalBinding>;
  observe(run: AgentRun): Promise<RuntimeObservation>;
  terminate(run: AgentRun): Promise<void>;
}
