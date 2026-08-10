import type { AdapterKind, DeliveryMode } from "@nanasa/contracts";

import type {
  AdapterDelivery,
  AdapterDeliveryResult,
  AdapterLifecycleState,
  AdapterSettlement,
  AdapterStartContext,
  AgentAdapter,
} from "./agent-adapter.js";
import { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type {
  WorkerEvent,
  WorkerSettlementEvent,
  WorkerSnapshot,
} from "./pi-rpc-worker-protocol.js";
import { validateSessionFile } from "./pi-rpc-worker-protocol.js";

interface DeferredSettlement {
  promise: Promise<AdapterSettlement>;
  resolve(value: AdapterSettlement): void;
  reject(error: Error): void;
}

export interface PiRpcAdapterOptions {
  socketPath: string;
  sessionDirectory: string;
  createClient?: () => PiRpcWorkerClient;
  persistSession(session: { adapterSessionId: string; sessionFile: string }): void;
  settleDeliveries(adapterMessageIds: readonly string[]): void;
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
    throw new Error("pi_worker_response_invalid");
  }
  return value as Record<string, unknown>;
}

export class PiRpcAdapter implements AgentAdapter {
  public readonly kind: AdapterKind = "pi-rpc";
  public readonly capabilities: ReadonlySet<DeliveryMode> = new Set(["queue", "steer"]);
  public state: AdapterLifecycleState = { readiness: "starting" };
  readonly #options: PiRpcAdapterOptions;
  readonly #settlements = new Map<string, DeferredSettlement>();
  #context: AdapterStartContext;
  #client: PiRpcWorkerClient | undefined;

  public constructor(context: AdapterStartContext, options: PiRpcAdapterOptions) {
    this.#context = context;
    this.#options = options;
  }

  public async start(context: AdapterStartContext): Promise<void> {
    this.#context = context;
    this.#validateContext(context);
    const client =
      this.#options.createClient?.() ??
      new PiRpcWorkerClient({
        socketPath: this.#options.socketPath,
        runId: context.run.id,
        generation: context.run.generation,
      });
    this.#client = client;
    client.on("event", (event: WorkerEvent) => this.#handleEvent(event));
    client.on("failure", (error: Error) => {
      if (this.state.readiness !== "closed") {
        this.state = { readiness: "unavailable", reason: error.message };
        for (const settlement of this.#settlements.values()) settlement.reject(error);
        this.#settlements.clear();
      }
    });
    await client.connect();
    const snapshot = asObject(
      await client.request("initialize", {
        command: context.profile.command,
        args: context.profile.args,
        cwd: context.profile.workingDirectory ?? process.cwd(),
        environment: context.profile.environment,
      }),
    ) as unknown as WorkerSnapshot;
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
    const settlement = deferredSettlement();
    this.#settlements.set(delivery.message.id, settlement);
    try {
      const data = asObject(
        await this.#client!.request("deliver", {
          deliveryId: delivery.message.id,
          mode: delivery.mode,
          message: delivery.message.body.text,
        }),
      );
      const session = asObject(data.session);
      const adapterSessionId = this.#persistSession(session);
      if (data.settled === true) {
        settlement.resolve({ status: "processed" });
        this.#settlements.delete(delivery.message.id);
      }
      return {
        appliedMode: delivery.mode,
        adapterSessionId,
        adapterMessageId: delivery.message.id,
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

  #applySnapshot(snapshot: WorkerSnapshot): void {
    for (const settlement of snapshot.settlements) this.#handleSettlement(settlement);
    if (!snapshot.initialized || snapshot.state === undefined) {
      throw new Error("pi_worker_initialization_failed");
    }
    this.#persistSession(snapshot.state);
    if (snapshot.readinessReason !== undefined) {
      this.state = { readiness: "unavailable", reason: snapshot.readinessReason };
      return;
    }
    this.state = { readiness: "ready" };
  }

  #persistSession(session: Record<string, unknown>): string {
    if (typeof session.sessionId !== "string" || session.sessionId.length === 0) {
      throw new Error("pi_session_id_invalid");
    }
    const sessionFile = validateSessionFile(this.#options.sessionDirectory, session.sessionFile);
    this.#options.persistSession({ adapterSessionId: session.sessionId, sessionFile });
    return session.sessionId;
  }

  #handleEvent(event: WorkerEvent): void {
    if (event.type === "delivery_settled") this.#handleSettlement(event);
  }

  #handleSettlement(event: WorkerSettlementEvent): void {
    this.#options.settleDeliveries(event.deliveryIds);
    for (const deliveryId of event.deliveryIds) {
      this.#settlements.get(deliveryId)?.resolve({ status: "processed" });
      this.#settlements.delete(deliveryId);
    }
  }

  #validateContext(context: AdapterStartContext): void {
    if (
      context.profile.adapter !== "pi-rpc" ||
      context.run.status !== "running" ||
      context.run.terminal === undefined
    ) {
      throw new Error("pi_rpc_run_unavailable");
    }
  }

  #assertCurrent(runId: string, generation: number): void {
    if (
      this.state.readiness !== "ready" ||
      this.#client === undefined ||
      this.#context.run.id !== runId ||
      this.#context.run.generation !== generation
    ) {
      throw new Error(this.state.reason ?? "pi_rpc_adapter_generation_unavailable");
    }
  }
}
