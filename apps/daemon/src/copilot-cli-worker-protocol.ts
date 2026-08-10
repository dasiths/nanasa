import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentRun } from "@nanasa/contracts";

export interface CopilotCliWorkerRequest {
  id: string;
  type: "hello" | "initialize" | "deliver" | "abort" | "shutdown";
  runId: string;
  generation: number;
  [key: string]: unknown;
}

export interface CopilotCliWorkerResponse {
  id: string;
  type: "response";
  command: CopilotCliWorkerRequest["type"];
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface CopilotCliWorkerSettledDelivery {
  deliveryId: string;
  adapterMessageId: string;
}

export interface CopilotCliWorkerSettlementEvent {
  type: "delivery_settled";
  sequence: number;
  deliveries: CopilotCliWorkerSettledDelivery[];
  status: "processed" | "failed";
  reason?: string;
}

export interface CopilotCliWorkerStateEvent {
  type: "worker_state";
  readiness: "ready" | "unavailable";
  reason?: string;
}

export type CopilotCliWorkerEvent = CopilotCliWorkerSettlementEvent | CopilotCliWorkerStateEvent;

export interface CopilotCliWorkerCompatibility {
  protocolVersion: number;
  agentName?: string;
  agentVersion?: string;
  loadSession: boolean;
}

export interface CopilotCliWorkerRecovery {
  status: "created" | "loaded" | "restarted";
  reason?: "copilot_session_load_failed" | "copilot_session_load_unsupported";
}

export interface CopilotCliWorkerSnapshot {
  initialized: boolean;
  busy: boolean;
  sessionId?: string;
  readinessReason?: string;
  compatibility?: CopilotCliWorkerCompatibility;
  recovery?: CopilotCliWorkerRecovery;
  settlementSequence: number;
  settlements: CopilotCliWorkerSettlementEvent[];
}

function pathKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function copilotCliWorkerSocketPath(
  runtimePath: string,
  run: Pick<AgentRun, "id" | "generation">,
): string {
  const socketPath = join(runtimePath, "copilot", `${pathKey(run.id)}-${run.generation}.sock`);
  if (Buffer.byteLength(socketPath) >= 104) {
    throw new Error("copilot_cli_worker_socket_path_too_long");
  }
  return socketPath;
}

export function copilotCliSessionDirectory(statePath: string, memberId: string): string {
  return join(statePath, "copilot", pathKey(memberId));
}
