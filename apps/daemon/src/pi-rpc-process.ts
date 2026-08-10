import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  BoundedByteCapture,
  JsonlFramer,
  JsonlProtocolError,
  parseJsonRecord,
  writeJsonLine,
} from "./pi-jsonl.js";

export interface PiRpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface PiRpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiRpcState {
  model?: { id?: string; provider?: string } | null;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile?: string;
  sessionId: string;
  pendingMessageCount: number;
  [key: string]: unknown;
}

export interface PiRpcProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxRecordBytes?: number;
  maxStderrBytes?: number;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; shell: false },
  ) => ChildProcessWithoutNullStreams;
}

interface PendingCommand {
  command: string;
  resolve(response: PiRpcResponse): void;
  reject(error: Error): void;
}

function asProtocolObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JsonlProtocolError("pi_rpc_record_must_be_object");
  }
  return value as Record<string, unknown>;
}

export class PiRpcProcess extends EventEmitter {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stderr: BoundedByteCapture;
  readonly #pending = new Map<string, PendingCommand>();
  #commandSequence = 0;
  #commandLane: Promise<void> = Promise.resolve();
  #failure: Error | undefined;

  public constructor(options: PiRpcProcessOptions) {
    super();
    const spawnProcess = options.spawnProcess ?? spawn;
    this.#stderr = new BoundedByteCapture(options.maxStderrBytes ?? 64 * 1024);
    this.#child = spawnProcess(options.command, options.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      shell: false,
    });
    const framer = new JsonlFramer({
      ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
      onRecord: (record) => this.#handleRecord(record),
    });
    this.#child.stdout.on("data", (chunk: Buffer) => {
      try {
        framer.write(chunk);
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#child.stdout.once("end", () => {
      try {
        framer.end();
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#child.stderr.on("data", (chunk: Buffer) => this.#stderr.append(chunk));
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("close", (code, signal) => {
      this.#fail(
        new Error(`pi_rpc_process_exited:${code ?? "null"}:${signal ?? "none"}:${this.stderrTail}`),
      );
    });
  }

  public get stderrTail(): string {
    return this.#stderr.toString();
  }

  public get pid(): number | undefined {
    return this.#child.pid;
  }

  public async handshake(): Promise<PiRpcState> {
    const response = await this.command({ type: "get_state" });
    const data = asProtocolObject(response.data);
    if (
      typeof data.sessionId !== "string" ||
      data.sessionId.length === 0 ||
      typeof data.isStreaming !== "boolean" ||
      typeof data.isCompacting !== "boolean" ||
      typeof data.pendingMessageCount !== "number"
    ) {
      throw new JsonlProtocolError("pi_rpc_invalid_state");
    }
    return data as PiRpcState;
  }

  public command(command: PiRpcCommand): Promise<PiRpcResponse> {
    const result = this.#commandLane.then(() => this.#send(command));
    this.#commandLane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public close(): void {
    if (!this.#child.killed) this.#child.kill("SIGTERM");
  }

  async #send(command: PiRpcCommand): Promise<PiRpcResponse> {
    if (this.#failure !== undefined) throw this.#failure;
    const id = `nanasa-${++this.#commandSequence}`;
    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.#pending.set(id, { command: command.type, resolve, reject });
      void writeJsonLine(this.#child.stdin, { ...command, id }).catch((error: unknown) => {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("pi_rpc_write_failed"));
      });
    });
  }

  #handleRecord(record: string): void {
    const value = asProtocolObject(parseJsonRecord(record));
    if (value.type !== "response") {
      if (typeof value.type !== "string") {
        throw new JsonlProtocolError("pi_rpc_event_type_missing");
      }
      this.emit("event", value);
      return;
    }
    if (typeof value.id !== "string") {
      throw new JsonlProtocolError("pi_rpc_response_id_missing");
    }
    const pending = this.#pending.get(value.id);
    if (pending === undefined) {
      throw new JsonlProtocolError("pi_rpc_response_id_unknown");
    }
    this.#pending.delete(value.id);
    if (typeof value.command !== "string" || value.command !== pending.command) {
      pending.reject(new JsonlProtocolError("pi_rpc_response_command_mismatch"));
      return;
    }
    if (typeof value.success !== "boolean") {
      pending.reject(new JsonlProtocolError("pi_rpc_response_success_missing"));
      return;
    }
    const response = value as unknown as PiRpcResponse;
    if (!response.success) {
      pending.reject(new Error(response.error ?? `pi_rpc_${response.command}_failed`));
      return;
    }
    pending.resolve(response);
  }

  #fail(error: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure = error instanceof Error ? error : new Error("pi_rpc_protocol_failed");
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
    this.emit("failure", this.#failure);
    if (!this.#child.killed) this.#child.kill("SIGTERM");
  }
}

export function validatePiReadiness(state: PiRpcState, stderrTail = ""): string | undefined {
  const provider = state.model?.provider?.trim();
  const model = state.model?.id?.trim();
  if (
    provider === undefined ||
    provider.length === 0 ||
    provider.toLowerCase() === "unknown" ||
    model === undefined ||
    model.length === 0 ||
    model.toLowerCase() === "unknown"
  ) {
    return "pi_model_unavailable";
  }
  if (/api key|auth(?:entication|orization)?|credential/i.test(stderrTail)) {
    return "pi_authentication_unavailable";
  }
  return undefined;
}
