import type { AgentRun } from "@nanasa/contracts";

import type { DeliveryClaim } from "./store.js";

interface TerminalDeliveryRuntime {
  readonly serverName: string;
  isCurrentRun(run: AgentRun): Promise<boolean>;
  pasteToRun(run: AgentRun, text: string): Promise<void>;
}

interface TerminalWriterRegistry {
  hasWriter(runId: string): boolean;
}

export class TmuxTerminalDelivery {
  readonly #runtime: TerminalDeliveryRuntime;
  readonly #endpoints: TerminalWriterRegistry;

  public constructor(runtime: TerminalDeliveryRuntime, endpoints: TerminalWriterRegistry) {
    this.#runtime = runtime;
    this.#endpoints = endpoints;
  }

  public async isAvailable(run: AgentRun): Promise<boolean> {
    return (
      run.status === "running" &&
      run.terminal?.serverName === this.#runtime.serverName &&
      (await this.#runtime.isCurrentRun(run))
    );
  }

  public async deliver(claim: DeliveryClaim): Promise<void> {
    if (claim.run === undefined || !(await this.isAvailable(claim.run))) {
      throw new Error("terminal_run_unavailable");
    }
    if (this.#endpoints.hasWriter(claim.run.id)) {
      throw new Error("terminal_writer_conflict");
    }
    await this.#runtime.pasteToRun(claim.run, claim.message.body.text);
  }
}
