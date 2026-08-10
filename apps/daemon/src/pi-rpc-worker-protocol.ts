import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentRun } from "@nanasa/contracts";

export interface WorkerRequest {
  id: string;
  type: "hello" | "initialize" | "deliver" | "abort" | "shutdown";
  runId: string;
  generation: number;
  [key: string]: unknown;
}

export interface WorkerResponse {
  id: string;
  type: "response";
  command: WorkerRequest["type"];
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface WorkerSettlementEvent {
  type: "delivery_settled";
  sequence: number;
  deliveryIds: string[];
}

export interface WorkerPiEvent {
  type: "pi_event";
  event: Record<string, unknown>;
}

export type WorkerEvent = WorkerSettlementEvent | WorkerPiEvent;

export interface WorkerSnapshot {
  initialized: boolean;
  busy: boolean;
  state?: Record<string, unknown>;
  readinessReason?: string;
  settlementSequence: number;
  settlements: WorkerSettlementEvent[];
}

function pathKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function piWorkerSocketPath(runtimePath: string, run: Pick<AgentRun, "id" | "generation">) {
  const name = `${pathKey(run.id)}-${run.generation}.sock`;
  const socketPath = join(runtimePath, "pi", name);
  if (Buffer.byteLength(socketPath) >= 104) {
    throw new Error("pi_worker_socket_path_too_long");
  }
  return socketPath;
}

export function piSessionDirectory(statePath: string, memberId: string): string {
  return join(statePath, "pi", pathKey(memberId));
}

export function validateSessionFile(sessionDirectory: string, sessionFile: unknown): string {
  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile)) {
    throw new Error("pi_session_file_invalid");
  }
  const root = resolve(sessionDirectory);
  const candidate = resolve(sessionFile);
  const remainder = relative(root, candidate);
  if (remainder.startsWith("..") || isAbsolute(remainder)) {
    throw new Error("pi_session_file_outside_state");
  }
  return candidate;
}
