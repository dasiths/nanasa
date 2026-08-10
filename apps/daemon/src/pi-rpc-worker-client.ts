import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";

import { JsonlFramer, JsonlProtocolError, parseJsonRecord, writeJsonLine } from "./pi-jsonl.js";
import type {
  WorkerEvent,
  WorkerRequest,
  WorkerResponse,
  WorkerSnapshot,
} from "./pi-rpc-worker-protocol.js";

export interface PiWorkerClientOptions {
  socketPath: string;
  runId: string;
  generation: number;
  connectTimeoutMs?: number;
  retryIntervalMs?: number;
}

interface PendingRequest {
  command: WorkerRequest["type"];
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JsonlProtocolError("pi_worker_record_must_be_object");
  }
  return value as Record<string, unknown>;
}

export class PiRpcWorkerClient extends EventEmitter {
  readonly #options: PiWorkerClientOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #socket: Socket | undefined;
  #requestSequence = 0;
  #requestLane: Promise<void> = Promise.resolve();
  #failure: Error | undefined;

  public constructor(options: PiWorkerClientOptions) {
    super();
    this.#options = options;
  }

  public async connect(): Promise<WorkerSnapshot> {
    if (this.#socket !== undefined) throw new Error("pi_worker_already_connected");
    const deadline = Date.now() + (this.#options.connectTimeoutMs ?? 5_000);
    let lastError: Error | undefined;
    do {
      try {
        this.#socket = await this.#connectOnce();
        this.#attach(this.#socket);
        return (await this.request("hello", {})) as WorkerSnapshot;
      } catch (error) {
        this.#socket?.destroy();
        this.#socket = undefined;
        lastError = error instanceof Error ? error : new Error("pi_worker_connect_failed");
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, this.#options.retryIntervalMs ?? 25));
      }
    } while (Date.now() < deadline);
    throw new Error(`pi_worker_unavailable:${lastError?.message ?? "connect_failed"}`);
  }

  public request(type: WorkerRequest["type"], data: Record<string, unknown>): Promise<unknown> {
    const operation = this.#requestLane.then(() => this.#send(type, data));
    this.#requestLane = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  public disconnect(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#fail(new Error("pi_worker_disconnected"), false);
  }

  async #send(type: WorkerRequest["type"], data: Record<string, unknown>): Promise<unknown> {
    if (this.#failure !== undefined) throw this.#failure;
    const socket = this.#socket;
    if (socket === undefined) throw new Error("pi_worker_not_connected");
    const id = `daemon-${++this.#requestSequence}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { command: type, resolve, reject });
      void writeJsonLine(socket, {
        ...data,
        id,
        type,
        runId: this.#options.runId,
        generation: this.#options.generation,
      }).catch((error: unknown) => {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("pi_worker_write_failed"));
      });
    });
  }

  #attach(socket: Socket): void {
    const framer = new JsonlFramer({ onRecord: (record) => this.#handleRecord(record) });
    socket.on("data", (chunk) => {
      try {
        framer.write(chunk);
      } catch (error) {
        this.#fail(error);
      }
    });
    socket.once("end", () => {
      try {
        framer.end();
      } catch (error) {
        this.#fail(error);
      }
    });
    socket.once("error", (error) => this.#fail(error));
    socket.once("close", () => this.#fail(new Error("pi_worker_connection_closed"), false));
  }

  #handleRecord(record: string): void {
    const value = asObject(parseJsonRecord(record));
    if (value.type !== "response") {
      this.emit("event", value as unknown as WorkerEvent);
      return;
    }
    if (typeof value.id !== "string") throw new JsonlProtocolError("pi_worker_response_id_missing");
    const pending = this.#pending.get(value.id);
    if (pending === undefined) throw new JsonlProtocolError("pi_worker_response_id_unknown");
    this.#pending.delete(value.id);
    const response = value as unknown as WorkerResponse;
    if (response.command !== pending.command) {
      pending.reject(new JsonlProtocolError("pi_worker_response_command_mismatch"));
    } else if (!response.success) {
      pending.reject(new Error(response.error ?? `pi_worker_${response.command}_failed`));
    } else {
      pending.resolve(response.data);
    }
  }

  #connectOnce(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.#options.socketPath });
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(socket);
      });
    });
  }

  #fail(error: unknown, destroy = true): void {
    if (this.#failure !== undefined) return;
    this.#failure = error instanceof Error ? error : new Error("pi_worker_protocol_failed");
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
    this.emit("failure", this.#failure);
    if (destroy) this.#socket?.destroy();
  }
}
