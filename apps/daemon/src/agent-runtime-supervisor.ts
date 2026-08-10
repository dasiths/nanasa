import type {
  AdapterKind,
  AgentAdapterStatus,
  AgentProfile,
  AgentRun,
  DeliveryMode,
} from "@nanasa/contracts";

import type { AdapterDeliveryResult, AgentAdapter, AgentAdapterFactory } from "./agent-adapter.js";
import type { DeliveryTarget } from "./delivery-dispatcher.js";
import type { DeliveryClaim } from "./store.js";
import type { TmuxTerminalDelivery } from "./terminal-adapter.js";

interface AdapterRecord {
  run: AgentRun;
  profile: AgentProfile;
  adapter: AgentAdapter;
}

export type AgentAdapterFactories = Partial<Record<AdapterKind, AgentAdapterFactory>>;

export class AdapterRegistry {
  readonly #records = new Map<string, AdapterRecord>();

  public get(runId: string): AdapterRecord | undefined {
    return this.#records.get(runId);
  }

  public set(record: AdapterRecord): void {
    this.#records.set(record.run.id, record);
  }

  public delete(runId: string): AdapterRecord | undefined {
    const record = this.#records.get(runId);
    this.#records.delete(runId);
    return record;
  }

  public values(): AdapterRecord[] {
    return [...this.#records.values()];
  }
}

export class AgentRuntimeSupervisor implements DeliveryTarget {
  readonly #factories: AgentAdapterFactories;
  readonly #terminalDelivery: TmuxTerminalDelivery | undefined;
  readonly #registry: AdapterRegistry;
  readonly #lanes = new Map<string, Promise<void>>();
  readonly #failures = new Map<string, string>();
  #closing = false;

  public constructor(
    factories: AgentAdapterFactories,
    terminalDelivery?: TmuxTerminalDelivery,
    registry = new AdapterRegistry(),
  ) {
    this.#factories = factories;
    this.#terminalDelivery = terminalDelivery;
    this.#registry = registry;
  }

  public start(run: AgentRun, profile: AgentProfile): Promise<void> {
    return this.#serialize(run.id, () => this.#start(run, profile));
  }

  public reconcile(runs: ReadonlyArray<{ run: AgentRun; profile: AgentProfile }>): Promise<void> {
    const activeRunIds = new Set(runs.map(({ run }) => run.id));
    return Promise.allSettled([
      ...runs.map(({ run, profile }) =>
        this.#serialize(run.id, async () => {
          this.#assertOpen();
          const current = this.#registry.get(run.id);
          if (current === undefined || !this.#matches(current, run, profile)) {
            await this.#start(run, profile);
            return;
          }
          await current.adapter.reconcile({ run, profile });
          current.run = run;
          current.profile = profile;
        }),
      ),
      ...this.#registry
        .values()
        .filter(({ run }) => !activeRunIds.has(run.id))
        .map(({ run }) => this.closeRun(run.id)),
    ]).then(() => undefined);
  }

  public capabilities(claim: DeliveryClaim): ReadonlySet<DeliveryMode> {
    const capabilities = new Set<DeliveryMode>();
    if (this.#terminalDelivery?.supports(claim.run) === true) capabilities.add("terminal");
    const record = claim.run === undefined ? undefined : this.#registry.get(claim.run.id);
    if (record !== undefined && this.#matches(record, claim.run, claim.profile)) {
      for (const mode of record.adapter.capabilities) {
        if (mode !== "terminal" && claim.profile.capabilities.includes(mode)) {
          capabilities.add(mode);
        }
      }
    }
    return capabilities;
  }

  public deliver(claim: DeliveryClaim, mode: DeliveryMode): Promise<AdapterDeliveryResult> {
    const runId = claim.run?.id;
    if (runId === undefined) return Promise.reject(new Error("active_run_unavailable"));
    return this.#serialize(runId, async () => {
      if (mode === "terminal") {
        if (this.#terminalDelivery === undefined) throw new Error("terminal_delivery_unavailable");
        return this.#terminalDelivery.deliver({
          message: claim.message,
          run: claim.run!,
          profile: claim.profile,
          mode,
        });
      }
      const record = this.#requireCurrent(claim);
      if (record.adapter.state.readiness !== "ready") {
        throw new Error(record.adapter.state.reason ?? "adapter_not_ready");
      }
      return record.adapter.deliver({
        message: claim.message,
        run: record.run,
        profile: record.profile,
        mode,
      });
    });
  }

  public terminalAvailable(run: AgentRun): Promise<boolean> {
    return this.#terminalDelivery?.isAvailable(run) ?? Promise.resolve(false);
  }

  public interrupt(run: AgentRun): Promise<void> {
    return this.#serialize(run.id, async () => {
      const record = this.#registry.get(run.id);
      if (record === undefined || record.run.generation !== run.generation) {
        throw new Error("adapter_generation_unavailable");
      }
      await record.adapter.interrupt();
    });
  }

  public status(run: AgentRun, profile: AgentProfile): AgentAdapterStatus {
    const record = this.#registry.get(run.id);
    const matching = this.#matches(record, run, profile) ? record : undefined;
    const capabilities =
      matching === undefined
        ? profile.capabilities
        : profile.capabilities.filter((mode) => matching.adapter.capabilities.has(mode));
    return {
      runId: run.id,
      generation: run.generation,
      adapter: profile.adapter,
      capabilities,
      readiness: matching?.adapter.state.readiness ?? "unavailable",
      ...(matching?.adapter.state.reason === undefined && this.#failures.get(run.id) === undefined
        ? {}
        : { reason: matching?.adapter.state.reason ?? this.#failures.get(run.id) }),
    };
  }

  public closeRun(runId: string): Promise<void> {
    return this.#serialize(runId, async () => {
      const record = this.#registry.delete(runId);
      this.#failures.delete(runId);
      if (record !== undefined) await record.adapter.close();
    });
  }

  public shutdownRun(runId: string): Promise<void> {
    return this.#serialize(runId, async () => {
      const record = this.#registry.delete(runId);
      this.#failures.delete(runId);
      if (record === undefined) return;
      await record.adapter.shutdown();
      await record.adapter.close();
    });
  }

  public async close(): Promise<void> {
    this.#closing = true;
    await Promise.all(this.#registry.values().map(({ run }) => this.closeRun(run.id)));
    await Promise.allSettled(this.#lanes.values());
  }

  #requireCurrent(claim: DeliveryClaim): AdapterRecord {
    const run = claim.run;
    const record = run === undefined ? undefined : this.#registry.get(run.id);
    if (record === undefined || !this.#matches(record, run, claim.profile)) {
      throw new Error("adapter_generation_unavailable");
    }
    return record;
  }

  async #start(run: AgentRun, profile: AgentProfile): Promise<void> {
    this.#assertOpen();
    const current = this.#registry.get(run.id);
    if (this.#matches(current, run, profile)) return;
    if (current !== undefined) {
      this.#registry.delete(run.id);
      await current.adapter.close();
    }
    const factory = this.#factories[profile.adapter];
    if (factory === undefined) {
      const reason = `adapter_factory_unavailable:${profile.adapter}`;
      this.#failures.set(run.id, reason);
      throw new Error(reason);
    }
    const adapter = factory({ run, profile });
    const record = { run, profile, adapter };
    this.#registry.set(record);
    try {
      await adapter.start({ run, profile });
      this.#failures.delete(run.id);
    } catch (error) {
      this.#registry.delete(run.id);
      await adapter.close().catch(() => undefined);
      const reason = error instanceof Error ? error.message : "adapter_start_failed";
      this.#failures.set(run.id, reason);
      throw error;
    }
  }

  #matches(
    record: AdapterRecord | undefined,
    run: AgentRun | undefined,
    profile: AgentProfile,
  ): boolean {
    return (
      record !== undefined &&
      run !== undefined &&
      record.run.generation === run.generation &&
      record.profile.id === profile.id &&
      record.profile.adapter === profile.adapter
    );
  }

  #serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#lanes.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const lane = result.then(
      () => undefined,
      () => undefined,
    );
    this.#lanes.set(runId, lane);
    void lane.finally(() => {
      if (this.#lanes.get(runId) === lane) this.#lanes.delete(runId);
    });
    return result;
  }

  #assertOpen(): void {
    if (this.#closing) throw new Error("adapter_supervisor_closed");
  }
}
