import type { AdapterKind, AgentRun, DeliveryMode } from "@nanasa/contracts";

import type {
  AdapterDelivery,
  AdapterDeliveryResult,
  AdapterLifecycleState,
  AdapterStartContext,
  AgentAdapter,
} from "./agent-adapter.js";

interface TerminalDeliveryRuntime {
  readonly serverName: string;
  interruptRun(run: AgentRun): Promise<void>;
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

  public supports(run: AgentRun | undefined): run is AgentRun {
    return (
      run?.status === "running" &&
      run.terminal !== undefined &&
      run.terminal.serverName === this.#runtime.serverName
    );
  }

  public async isAvailable(run: AgentRun): Promise<boolean> {
    return this.supports(run) && (await this.#runtime.isCurrentRun(run));
  }

  public async deliver(delivery: AdapterDelivery): Promise<AdapterDeliveryResult> {
    if (delivery.mode !== "queue" && delivery.mode !== "terminal") {
      throw new Error("terminal_steer_not_supported");
    }
    if (!this.supports(delivery.run)) throw new Error("terminal_run_unavailable");
    if (this.#endpoints.hasWriter(delivery.run.id)) throw new Error("terminal_writer_conflict");
    await this.#runtime.pasteToRun(delivery.run, delivery.message.body.text);
    return {
      appliedMode: delivery.mode,
      adapterMessageId: delivery.message.id,
    };
  }

  public async interrupt(run: AgentRun): Promise<void> {
    if (!this.supports(run)) throw new Error("terminal_run_unavailable");
    await this.#runtime.interruptRun(run);
  }
}

export class TerminalAdapter implements AgentAdapter {
  public readonly kind: AdapterKind = "terminal";
  public readonly capabilities: ReadonlySet<DeliveryMode> = new Set(["queue"]);
  public state: AdapterLifecycleState = { readiness: "starting" };
  readonly #delivery: TmuxTerminalDelivery;
  #context: AdapterStartContext;

  public constructor(context: AdapterStartContext, delivery: TmuxTerminalDelivery) {
    this.#context = context;
    this.#delivery = delivery;
  }

  public async start(context: AdapterStartContext): Promise<void> {
    this.#context = context;
    this.#validateContext(context);
    this.state = { readiness: "ready" };
  }

  public async reconcile(context: AdapterStartContext): Promise<void> {
    this.#context = context;
    this.#validateContext(context);
    this.state = { readiness: "ready" };
  }

  public async deliver(delivery: AdapterDelivery): Promise<AdapterDeliveryResult> {
    if (delivery.mode !== "queue") throw new Error("terminal_delivery_mode_not_supported");
    this.#assertCurrent(delivery.run.id, delivery.run.generation);
    return this.#delivery.deliver(delivery);
  }

  public async interrupt(): Promise<void> {
    this.#assertCurrent(this.#context.run.id, this.#context.run.generation);
    await this.#delivery.interrupt(this.#context.run);
  }

  public async shutdown(): Promise<void> {
    this.state = { readiness: "closed" };
  }

  public async close(): Promise<void> {
    this.state = { readiness: "closed" };
  }

  #validateContext(context: AdapterStartContext): void {
    if (context.profile.adapter !== "terminal" || !this.#delivery.supports(context.run)) {
      this.state = { readiness: "unavailable", reason: "terminal_run_unavailable" };
      throw new Error("terminal_run_unavailable");
    }
  }

  #assertCurrent(runId: string, generation: number): void {
    if (
      this.state.readiness !== "ready" ||
      this.#context.run.id !== runId ||
      this.#context.run.generation !== generation
    ) {
      throw new Error("terminal_adapter_generation_unavailable");
    }
  }
}
