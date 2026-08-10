import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  BoundedByteCapture,
  JsonlFramer,
  JsonlProtocolError,
  parseJsonRecord,
  writeJsonLine,
} from "./pi-jsonl.js";

export const COPILOT_ACP_PROTOCOL_VERSION = 1;

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    [key: string]: unknown;
  };
  agentInfo?: {
    name?: string;
    version?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AcpPromptResult {
  stopReason: string;
  [key: string]: unknown;
}

export interface AcpStartedRequest<T> {
  id: number;
  response: Promise<T>;
}

export interface CopilotAcpProcessOptions {
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

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function asObject(value: unknown, reason: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JsonlProtocolError(reason);
  }
  return value as Record<string, unknown>;
}

function errorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "copilot_acp_request_failed";
  }
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : "copilot_acp_request_failed";
}

export class CopilotAcpProcess extends EventEmitter {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stderr: BoundedByteCapture;
  readonly #pending = new Map<number, PendingRequest>();
  #requestSequence = 0;
  #writeLane: Promise<void> = Promise.resolve();
  #recordLane: Promise<void> = Promise.resolve();
  #failure: Error | undefined;

  public constructor(options: CopilotAcpProcessOptions) {
    super();
    if (options.args.some((argument) => argument === "--acp" || argument === "--stdio")) {
      throw new Error("copilot_acp_reserved_argument");
    }
    const spawnProcess = options.spawnProcess ?? spawn;
    this.#stderr = new BoundedByteCapture(options.maxStderrBytes ?? 64 * 1024);
    this.#child = spawnProcess(options.command, [...options.args, "--acp", "--stdio"], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      shell: false,
    });
    const framer = new JsonlFramer({
      ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
      onRecord: (record) => {
        this.#recordLane = this.#recordLane.then(() => this.#handleRecord(record));
        void this.#recordLane.catch((error: unknown) => this.#fail(error));
      },
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
        new Error(
          `copilot_acp_process_exited:${code ?? "null"}:${signal ?? "none"}:${this.stderrTail}`,
        ),
      );
    });
  }

  public get stderrTail(): string {
    return this.#stderr.toString();
  }

  public get pid(): number | undefined {
    return this.#child.pid;
  }

  public async initialize(): Promise<AcpInitializeResult> {
    const result = asObject(
      await this.request("initialize", {
        protocolVersion: COPILOT_ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "nanasa", title: "Nanasa", version: "0.0.0" },
      }),
      "copilot_acp_initialize_result_invalid",
    );
    if (result.protocolVersion !== COPILOT_ACP_PROTOCOL_VERSION) {
      throw new JsonlProtocolError("copilot_acp_protocol_unsupported");
    }
    return result as unknown as AcpInitializeResult;
  }

  public async newSession(cwd: string): Promise<string> {
    const result = asObject(
      await this.request("session/new", { cwd, mcpServers: [] }),
      "copilot_acp_new_session_result_invalid",
    );
    if (typeof result.sessionId !== "string" || result.sessionId.length === 0) {
      throw new JsonlProtocolError("copilot_acp_session_id_invalid");
    }
    return result.sessionId;
  }

  public async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  public startPrompt(sessionId: string, text: string): Promise<AcpStartedRequest<AcpPromptResult>> {
    return this.startRequest<AcpPromptResult>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  public cancel(sessionId: string): Promise<void> {
    return this.notify("session/cancel", { sessionId });
  }

  public async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const started = await this.startRequest(method, params);
    return started.response;
  }

  public async startRequest<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<AcpStartedRequest<T>> {
    if (this.#failure !== undefined) throw this.#failure;
    const id = ++this.#requestSequence;
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<unknown>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    this.#pending.set(id, { method, resolve, reject });
    try {
      await this.#write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return { id, response: response as Promise<T> };
  }

  public notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    return this.#write({ jsonrpc: "2.0", method, params });
  }

  public close(): void {
    if (!this.#child.killed) this.#child.kill("SIGTERM");
  }

  async #handleRecord(record: string): Promise<void> {
    const value = asObject(parseJsonRecord(record), "copilot_acp_record_must_be_object");
    if (value.jsonrpc !== "2.0") {
      throw new JsonlProtocolError("copilot_acp_jsonrpc_version_invalid");
    }
    if (value.id !== undefined && value.method === undefined) {
      if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) {
        throw new JsonlProtocolError("copilot_acp_response_id_invalid");
      }
      const pending = this.#pending.get(value.id);
      if (pending === undefined) {
        throw new JsonlProtocolError("copilot_acp_response_id_unknown");
      }
      this.#pending.delete(value.id);
      if (value.error !== undefined) pending.reject(new Error(errorMessage(value.error)));
      else if (!("result" in value)) {
        pending.reject(new JsonlProtocolError("copilot_acp_response_result_missing"));
      } else pending.resolve(value.result);
      return;
    }
    if (typeof value.method !== "string" || value.method.length === 0) {
      throw new JsonlProtocolError("copilot_acp_method_missing");
    }
    if (value.id === undefined) {
      this.emit("notification", { method: value.method, params: value.params });
      return;
    }
    if (typeof value.id !== "number" && typeof value.id !== "string") {
      throw new JsonlProtocolError("copilot_acp_request_id_invalid");
    }
    if (value.method === "session/request_permission") {
      await this.#write({
        jsonrpc: "2.0",
        id: value.id,
        result: { outcome: { outcome: "cancelled" } },
      });
      this.emit("permission_cancelled", value.params);
      return;
    }
    await this.#write({
      jsonrpc: "2.0",
      id: value.id,
      error: { code: -32601, message: `Unsupported client method: ${value.method}` },
    });
    this.emit("unsupported_request", { method: value.method, params: value.params });
  }

  #write(value: unknown): Promise<void> {
    const operation = this.#writeLane.then(() => writeJsonLine(this.#child.stdin, value));
    this.#writeLane = operation.catch(() => undefined);
    return operation;
  }

  #fail(error: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure = error instanceof Error ? error : new Error("copilot_acp_protocol_failed");
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
    this.emit("failure", this.#failure);
    if (!this.#child.killed) this.#child.kill("SIGTERM");
  }
}
