import { randomUUID } from "node:crypto";
import type { AdHocConsoleSession, AgentRun } from "@nanasa/contracts";

import { DomainError } from "./store.js";
import type { TerminalEndpointRegistry } from "./terminal-endpoint-registry.js";
import type { TmuxRuntime } from "./tmux-runtime.js";
import type { TtydSupervisor } from "./ttyd-supervisor.js";

export class AdHocConsoleManager {
  readonly #runtime: TmuxRuntime;
  readonly #supervisor: TtydSupervisor;
  readonly #endpoints: TerminalEndpointRegistry;
  readonly #workingDirectory: string;
  readonly #sessions = new Map<string, AgentRun>();

  public constructor(
    runtime: TmuxRuntime,
    supervisor: TtydSupervisor,
    endpoints: TerminalEndpointRegistry,
    workingDirectory: string,
  ) {
    this.#runtime = runtime;
    this.#supervisor = supervisor;
    this.#endpoints = endpoints;
    this.#workingDirectory = workingDirectory;
  }

  public async create(): Promise<AdHocConsoleSession> {
    const id = `console_${randomUUID()}`;
    let run: AgentRun | undefined;
    try {
      run = await this.#runtime.startConsole(id, this.#workingDirectory, { cols: 120, rows: 36 });
      await this.#runtime.ensureViewSession(run);
      this.#sessions.set(id, run);
      this.#supervisor.startDetached(run);
      return { id, runId: run.id };
    } catch (error) {
      if (run !== undefined) await this.#runtime.stopConsole(run).catch(() => undefined);
      throw error;
    }
  }

  public async remove(id: string): Promise<void> {
    const run = this.#sessions.get(id);
    if (run === undefined) {
      throw new DomainError("console_not_found", "Console not found", 404);
    }
    this.#sessions.delete(id);
    await this.#supervisor.stop(run.id);
    await this.#runtime.removeViewSession(run.id);
    await this.#runtime.stopConsole(run);
    this.#endpoints.remove(run.id);
  }

  public async close(): Promise<void> {
    await Promise.allSettled([...this.#sessions.keys()].map((id) => this.remove(id)));
  }
}
