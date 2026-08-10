import type { AdapterKind, DeliveryMode } from "@nanasa/contracts";

import type {
  AdapterDelivery,
  AdapterDeliveryResult,
  AdapterLifecycleState,
  AdapterSettlement,
  AdapterStartContext,
  AgentAdapter,
} from "./agent-adapter.js";
import { CopilotCliWorkerClient } from "./copilot-cli-worker-client.js";
import type {
  CopilotCliWorkerEvent,
  CopilotCliWorkerSettlementEvent,
  CopilotCliWorkerSnapshot,
  CopilotCliWorkerStateEvent,
} from "./copilot-cli-worker-protocol.js";

interface DeferredSettlement {
  promise: Promise<AdapterSettlement>;
  resolve(value: AdapterSettlement): void;
  reject(error: Error): void;
}

export interface CopilotCliAdapterOptions {
  socketPath: string;
  createClient?: () => CopilotCliWorkerClient;
  persistSession(adapterSessionId: string): void;
  settleDeliveries(
    adapterMessageIds: readonly string[],
    settlement: { status: "processed" | "failed"; reason?: string },
  ): void;
}

function deferredSettlement(): DeferredSettlement {
  let resolve!: (value: AdapterSettlement) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AdapterSettlement>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("copilot_cli_worker_response_invalid");
  }
  return value as Record<string, unknown>;
}

export class CopilotCliAdapter implements AgentAdapter {
  public readonly kind: AdapterKind = "copilot-cli";
  public readonly capabilities: ReadonlySet<DeliveryMode> = new Set(["queue"]);
  public state: AdapterLifecycleState = { readiness: "starting" };
  readonly #options: CopilotCliAdapterOptions;
  readonly #settlements = new Map<string, DeferredSettlement>();
  #context: AdapterStartContext;
  #client: CopilotCliWorkerClient | undefined;

  public constructor(context: AdapterStartContext, options: CopilotCliAdapterOptions) {
    this.#context = context;
    this.#options = options;
  }

  public async start(context: AdapterStartContext): Promise<void> {
    this.#context = context;
    this.#validateContext(context);
    const client =
      this.#options.createClient?.() ??
      new CopilotCliWorkerClient({
        socketPath: this.#options.socketPath,
        runId: context.run.id,
        generation: context.run.generation,
      });
    this.#client = client;
    client.on("event", (event: CopilotCliWorkerEvent) => this.#handleEvent(event));
    client.on("failure", (error: Error) => {
      if (this.state.readiness !== "closed") {
        this.state = { readiness: "unavailable", reason: error.message };
        for (const settlement of this.#settlements.values()) settlement.reject(error);
        this.#settlements.clear();
      }
    });
    const connected = await client.connect();
    this.#applySnapshot(connected);
    const snapshot = asObject(
      await client.request("initialize", {
        command: context.profile.command,
        args: context.profile.args,
        cwd: context.profile.workingDirectory ?? process.cwd(),
        environment: context.profile.environment,
        adapterSessionId: context.run.adapterSessionId,
        recoveryPolicy: "resume-or-restart",
      }),
    ) as unknown as CopilotCliWorkerSnapshot;
    this.#applySnapshot(snapshot);
  }

  public async reconcile(context: AdapterStartContext): Promise<void> {
    if (
      this.#client !== undefined &&
      this.#context.run.id === context.run.id &&
      this.#context.run.generation === context.run.generation
    ) {
      this.#context = context;
      return;
    }
    await this.close();
    await this.start(context);
  }

  public async deliver(delivery: AdapterDelivery): Promise<AdapterDeliveryResult> {
    this.#assertCurrent(delivery.run.id, delivery.run.generation);
    if (delivery.mode !== "queue") throw new Error("copilot_cli_queue_only");
    const settlement = deferredSettlement();
    this.#settlements.set(delivery.message.id, settlement);
    try {
      const data = asObject(
        await this.#client!.request("deliver", {
          deliveryId: delivery.message.id,
          mode: "queue",
          message: delivery.message.body.text,
        }),
      );
      if (typeof data.sessionId !== "string" || data.sessionId.length === 0) {
        throw new Error("copilot_acp_session_id_invalid");
      }
      if (typeof data.adapterMessageId !== "string" || data.adapterMessageId.length === 0) {
        throw new Error("copilot_acp_message_id_invalid");
      }
      this.#options.persistSession(data.sessionId);
      if (data.settled === true) {
        settlement.resolve({ status: "processed" });
        this.#settlements.delete(delivery.message.id);
      }
      return {
        appliedMode: "queue",
        adapterSessionId: data.sessionId,
        adapterMessageId: data.adapterMessageId,
        settlement: settlement.promise,
      };
    } catch (error) {
      this.#settlements.delete(delivery.message.id);
      throw error;
    }
  }

  public async interrupt(): Promise<void> {
    this.#assertCurrent(this.#context.run.id, this.#context.run.generation);
    await this.#client!.request("abort", {});
  }

  public async shutdown(): Promise<void> {
    if (this.#client !== undefined) {
      await this.#client.request("shutdown", {}).catch(() => undefined);
    }
    this.state = { readiness: "closed" };
  }

  public async close(): Promise<void> {
    this.state = { readiness: "closed" };
    this.#client?.disconnect();
    this.#client = undefined;
    this.#settlements.clear();
  }

  #applySnapshot(snapshot: CopilotCliWorkerSnapshot): void {
    for (const settlement of snapshot.settlements) this.#handleSettlement(settlement);
    if (snapshot.sessionId !== undefined) this.#options.persistSession(snapshot.sessionId);
    if (snapshot.readinessReason !== undefined) {
      this.state = { readiness: "unavailable", reason: snapshot.readinessReason };
      return;
    }
    if (!snapshot.initialized) return;
    if (snapshot.sessionId === undefined)
      throw new Error("copilot_cli_worker_initialization_failed");
    this.state = { readiness: "ready" };
  }

  #handleEvent(event: CopilotCliWorkerEvent): void {
    if (event.type === "delivery_settled") this.#handleSettlement(event);
    else this.#handleState(event);
  }

  #handleSettlement(event: CopilotCliWorkerSettlementEvent): void {
    const settlement: AdapterSettlement = {
      status: event.status,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
    this.#options.settleDeliveries(
      event.deliveries.map((delivery) => delivery.adapterMessageId),
      settlement,
    );
    for (const delivery of event.deliveries) {
      this.#settlements.get(delivery.deliveryId)?.resolve(settlement);
      this.#settlements.delete(delivery.deliveryId);
    }
  }

  #handleState(event: CopilotCliWorkerStateEvent): void {
    if (this.state.readiness === "closed") return;
    this.state =
      event.readiness === "ready"
        ? { readiness: "ready" }
        : { readiness: "unavailable", reason: event.reason ?? "copilot_cli_worker_unavailable" };
  }

  #validateContext(context: AdapterStartContext): void {
    if (
      context.profile.adapter !== "copilot-cli" ||
      context.run.status !== "running" ||
      context.run.terminal === undefined
    ) {
      throw new Error("copilot_cli_run_unavailable");
    }
  }

  #assertCurrent(runId: string, generation: number): void {
    if (
      this.state.readiness !== "ready" ||
      this.#client === undefined ||
      this.#context.run.id !== runId ||
      this.#context.run.generation !== generation
    ) {
      throw new Error(this.state.reason ?? "copilot_cli_adapter_generation_unavailable");
    }
  }
}
