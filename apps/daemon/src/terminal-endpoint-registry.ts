import { createHash } from "node:crypto";
import type {
  AgentRun,
  TerminalBinding,
  TerminalEndpointState,
  TerminalEndpointStatus,
} from "@nanasa/contracts";

import { DomainError, NanasaStore } from "./store.js";

export interface ReadyTerminalEndpoint {
  runId: string;
  endpointKey: string;
  basePath: string;
  upstream: string;
  generation: number;
}

interface EndpointRecord {
  runId: string;
  endpointKey: string;
  basePath: string;
  bindingFingerprint: string;
  state: TerminalEndpointState;
  generation: number;
  detached: boolean;
  upstream?: string;
  retryAfterMs?: number;
  error?: { code: string; message: string };
}

export function terminalEndpointKey(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 32);
}

export function terminalBasePath(endpointKey: string): string {
  if (!/^[0-9a-f]{32}$/.test(endpointKey)) {
    throw new Error("Terminal endpoint key must be 32 lowercase hexadecimal characters");
  }
  return `/terminals/${endpointKey}`;
}

export function terminalBindingFingerprint(binding: TerminalBinding): string {
  return [binding.serverName, binding.sessionId, binding.windowId, binding.paneId].join("\u0000");
}

export class TerminalEndpointRegistry {
  readonly #store: NanasaStore;
  readonly #byRun = new Map<string, EndpointRecord>();
  readonly #runByKey = new Map<string, string>();
  readonly #writers = new Map<string, number>();

  public constructor(store: NanasaStore) {
    this.#store = store;
  }

  public begin(run: AgentRun, generation: number, detached = false): EndpointRecord {
    if (run.terminal === undefined) {
      throw new Error("Cannot register a terminal endpoint without a tmux binding");
    }
    const endpointKey = terminalEndpointKey(run.id);
    const collision = this.#runByKey.get(endpointKey);
    if (collision !== undefined && collision !== run.id) {
      throw new Error(`Terminal endpoint key collision for ${run.id}`);
    }
    const record: EndpointRecord = {
      runId: run.id,
      endpointKey,
      basePath: terminalBasePath(endpointKey),
      bindingFingerprint: terminalBindingFingerprint(run.terminal),
      state: "starting",
      generation,
      detached,
    };
    this.#byRun.set(run.id, record);
    this.#runByKey.set(endpointKey, run.id);
    return record;
  }

  public publishReady(runId: string, generation: number, port: number): boolean {
    const record = this.#current(runId, generation);
    if (record === undefined) {
      return false;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("ttyd port must be an integer between 1 and 65535");
    }
    record.state = "ready";
    record.upstream = `http://127.0.0.1:${port}`;
    delete record.retryAfterMs;
    delete record.error;
    return true;
  }

  public publishBackoff(
    runId: string,
    generation: number,
    retryAfterMs: number,
    error: { code: string; message: string },
  ): boolean {
    const record = this.#current(runId, generation);
    if (record === undefined) {
      return false;
    }
    record.state = "backoff";
    delete record.upstream;
    record.retryAfterMs = retryAfterMs;
    record.error = error;
    return true;
  }

  public publishUnavailable(
    runId: string,
    generation: number,
    error: { code: string; message: string },
  ): boolean {
    const record = this.#current(runId, generation);
    if (record === undefined) {
      return false;
    }
    record.state = "unavailable";
    delete record.upstream;
    delete record.retryAfterMs;
    record.error = error;
    return true;
  }

  public stop(runId: string): void {
    const record = this.#byRun.get(runId);
    if (record === undefined) {
      return;
    }
    record.state = "stopped";
    record.generation += 1;
    delete record.upstream;
    delete record.retryAfterMs;
  }

  public remove(runId: string): void {
    const record = this.#byRun.get(runId);
    if (record !== undefined) {
      this.#runByKey.delete(record.endpointKey);
      this.#byRun.delete(runId);
      this.#writers.delete(runId);
    }
  }

  public beginWriter(runId: string, generation: number): () => void {
    if (this.#current(runId, generation) === undefined) {
      throw new DomainError("terminal_endpoint_inactive", "Terminal endpoint is inactive", 409);
    }
    this.#writers.set(runId, (this.#writers.get(runId) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (this.#writers.get(runId) ?? 1) - 1;
      if (remaining === 0) this.#writers.delete(runId);
      else this.#writers.set(runId, remaining);
    };
  }

  public hasWriter(runId: string): boolean {
    return (this.#writers.get(runId) ?? 0) > 0;
  }

  public status(runId: string): TerminalEndpointStatus {
    const record = this.#byRun.get(runId);
    if (record === undefined) {
      const run = this.#store.getRun(runId);
      return {
        runId,
        provider: "ttyd",
        state: run.status === "stopped" || run.status === "failed" ? "stopped" : "unavailable",
      };
    }
    if (!record.detached && !this.#matchesActiveRun(record, this.#store.getRun(runId))) {
      return { runId, provider: "ttyd", state: "stopped" };
    }
    if (record.state === "ready") {
      return {
        runId,
        provider: "ttyd",
        state: "ready",
        url: `${record.basePath}/`,
      };
    }
    return {
      runId,
      provider: "ttyd",
      state: record.state,
      ...(record.retryAfterMs === undefined ? {} : { retryAfterMs: record.retryAfterMs }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }

  public statusByKey(endpointKey: string): TerminalEndpointStatus {
    if (!/^[0-9a-f]{32}$/.test(endpointKey)) {
      throw new DomainError("terminal_endpoint_not_found", "Terminal endpoint not found", 404);
    }
    const runId = this.#runByKey.get(endpointKey);
    if (runId === undefined) {
      throw new DomainError("terminal_endpoint_not_found", "Terminal endpoint not found", 404);
    }
    return this.status(runId);
  }

  public resolve(endpointKey: string): ReadyTerminalEndpoint {
    if (!/^[0-9a-f]{32}$/.test(endpointKey)) {
      throw new DomainError("terminal_endpoint_not_found", "Terminal endpoint not found", 404);
    }
    const runId = this.#runByKey.get(endpointKey);
    if (runId === undefined) {
      throw new DomainError("terminal_endpoint_not_found", "Terminal endpoint not found", 404);
    }
    const record = this.#byRun.get(runId);
    if (record === undefined) {
      throw new DomainError("terminal_endpoint_not_found", "Terminal endpoint not found", 404);
    }
    if (!record.detached && !this.#matchesActiveRun(record, this.#store.getRun(runId))) {
      throw new DomainError("terminal_endpoint_inactive", "Terminal endpoint is inactive", 409);
    }
    if (record.state !== "ready" || record.upstream === undefined) {
      throw new DomainError(
        "terminal_endpoint_unavailable",
        `Terminal endpoint is ${record.state}`,
        503,
      );
    }
    return {
      runId,
      endpointKey,
      basePath: record.basePath,
      upstream: record.upstream,
      generation: record.generation,
    };
  }

  #current(runId: string, generation: number): EndpointRecord | undefined {
    const record = this.#byRun.get(runId);
    return record?.generation === generation ? record : undefined;
  }

  #matchesActiveRun(record: EndpointRecord, run: AgentRun): boolean {
    return (
      (run.status === "starting" || run.status === "running") &&
      run.terminal !== undefined &&
      terminalBindingFingerprint(run.terminal) === record.bindingFingerprint
    );
  }
}
