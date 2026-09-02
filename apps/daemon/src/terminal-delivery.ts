import type { AgentRun } from "@nanasa/contracts";

import type { RuntimeObservation } from "./runtime-observation.js";
import type { DeliveryClaim } from "./store.js";
import type { TerminalInputArbiter } from "./terminal/terminal-input-arbiter.js";

interface TerminalDeliveryRuntime {
  readonly serverName: string;
  observeRun(run: AgentRun): Promise<RuntimeObservation>;
  pasteToRun(run: AgentRun, text: string): Promise<void>;
}

export function formatTerminalDelivery(claim: DeliveryClaim): string {
  const sender =
    claim.message.sender.kind === "agent"
      ? `${claim.senderAlias} | Member: ${claim.message.sender.memberId}`
      : "Human";
  return `[From: ${sender} | Message: ${claim.message.id} | Conversation: ${claim.message.conversationId} | Reply-To: ${claim.message.replyTo ?? "none"} | Intent: ${claim.message.intent}]\n${claim.message.body.text}`;
}

export class TmuxTerminalDelivery {
  readonly #runtime: TerminalDeliveryRuntime;
  readonly #arbiter: TerminalInputArbiter;

  public constructor(runtime: TerminalDeliveryRuntime, arbiter: TerminalInputArbiter) {
    this.#runtime = runtime;
    this.#arbiter = arbiter;
  }

  public async isAvailable(run: AgentRun): Promise<boolean> {
    return (
      run.status === "running" &&
      run.terminal?.serverName === this.#runtime.serverName &&
      (await this.#runtime.observeRun(run)).state === "present"
    );
  }

  public async deliver(claim: DeliveryClaim): Promise<void> {
    if (claim.run === undefined || !(await this.isAvailable(claim.run))) {
      throw new Error("terminal_run_unavailable");
    }
    await this.#arbiter.dispatchAutomated(claim.run.id, () =>
      this.#runtime.pasteToRun(claim.run as AgentRun, formatTerminalDelivery(claim)),
    );
  }
}
