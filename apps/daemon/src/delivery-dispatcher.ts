import { randomUUID } from "node:crypto";
import type { DeliveryMode } from "@nanasa/contracts";

import type { AdapterDeliveryResult } from "./agent-adapter.js";
import { type DeliveryClaim, NanasaStore } from "./store.js";

export interface DeliveryTarget {
  capabilities(claim: DeliveryClaim): ReadonlySet<DeliveryMode>;
  deliver(claim: DeliveryClaim, mode: DeliveryMode): Promise<AdapterDeliveryResult>;
}

export interface DeliveryDispatcherOptions {
  owner?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
}

export class DeliveryDispatcher {
  readonly #store: NanasaStore;
  readonly #target: DeliveryTarget;
  readonly #owner: string;
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;
  readonly #batchSize: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #pending: Promise<void> | undefined;
  #closing = false;

  public constructor(
    store: NanasaStore,
    target: DeliveryTarget,
    options: DeliveryDispatcherOptions = {},
  ) {
    this.#store = store;
    this.#target = target;
    this.#owner = options.owner ?? `dispatcher_${randomUUID()}`;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#batchSize = options.batchSize ?? 32;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#retryBaseMs = options.retryBaseMs ?? 250;
    this.#retryMaxMs = options.retryMaxMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
  }

  public start(): void {
    if (this.#timer !== undefined || this.#closing) return;
    this.#unsubscribe = this.#store.onEvent((event) => {
      if (event.type === "message.submitted" || event.type === "run.status-changed") {
        void this.tick();
      }
    });
    this.#timer = setInterval(() => void this.tick(), this.#pollIntervalMs);
    this.#timer.unref();
    void this.tick();
  }

  public tick(): Promise<void> {
    if (this.#closing) return Promise.resolve();
    if (this.#pending !== undefined) return this.#pending;
    const operation = this.#dispatch();
    const pending = operation.finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }

  public async close(): Promise<void> {
    this.#closing = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#unsubscribe?.();
    await this.#pending;
  }

  async #dispatch(): Promise<void> {
    const claims = this.#store.claimDeliveries({
      owner: this.#owner,
      now: this.#now(),
      leaseMs: this.#leaseMs,
      limit: this.#batchSize,
    });
    await Promise.all(claims.map((claim) => this.#deliver(claim)));
  }

  async #deliver(claim: DeliveryClaim): Promise<void> {
    if (!claim.recipientActive) {
      this.#store.revokeClaim(claim, this.#owner, "membership_removed");
      return;
    }
    if (
      claim.message.delivery.expiresAt !== undefined &&
      new Date(claim.message.delivery.expiresAt).getTime() <= this.#now().getTime()
    ) {
      this.#store.rejectClaim(claim, this.#owner, "delivery_expired");
      return;
    }
    if (claim.run === undefined || claim.run.status !== "running") {
      this.#retry(claim, "active_run_unavailable");
      return;
    }

    try {
      const requestedMode = claim.delivery.requestedMode;
      const capabilities = this.#target.capabilities(claim);
      const appliedMode =
        requestedMode === "terminal"
          ? "terminal"
          : capabilities.has(requestedMode)
            ? requestedMode
            : "queue";
      if (!capabilities.has(appliedMode)) {
        this.#store.rejectClaim(claim, this.#owner, "adapter_capability_unsupported");
        return;
      }
      const fallbackApplied = appliedMode !== requestedMode;
      if (!this.#store.beginDelivery(claim, this.#owner, appliedMode, fallbackApplied)) return;
      const result = await this.#target.deliver(claim, appliedMode);
      if (result.appliedMode !== appliedMode) {
        throw new Error("adapter_applied_mode_mismatch");
      }
      if (!this.#store.markDeliveryConsumed(claim, this.#owner, result)) return;
      if (result.settlement !== undefined) {
        void result.settlement.then(
          (settlement) => this.#store.settleDelivery(claim, settlement.status, settlement.reason),
          (error: unknown) =>
            this.#store.settleDelivery(
              claim,
              "failed",
              error instanceof Error ? error.message : "adapter_settlement_failed",
            ),
        );
      }
    } catch (error) {
      this.#retry(claim, error instanceof Error ? error.message : "adapter_delivery_failed");
    }
  }

  #retry(claim: DeliveryClaim, reason: string): void {
    const exponent = Math.max(0, claim.delivery.attempts - 1);
    const delay = Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** exponent);
    this.#store.failDeliveryAttempt(claim, this.#owner, reason, {
      maxAttempts: this.#maxAttempts,
      retryAt: new Date(this.#now().getTime() + delay),
    });
  }
}
