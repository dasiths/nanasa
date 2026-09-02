import type { DeliveryOutcome } from "@nanasa/contracts";
import type {
  ClaimDeliveriesOptions,
  DeliveryAttemptResult,
  DeliveryClaim,
  NanasaStore,
} from "./store.js";

export class DeliveryRepository {
  public constructor(private readonly store: NanasaStore) {}

  public list(messageId?: string): DeliveryOutcome[] {
    return this.store.listDeliveries(messageId);
  }

  public claim(options: ClaimDeliveriesOptions): DeliveryClaim[] {
    return this.store.claimDeliveries(options);
  }

  public begin(claim: DeliveryClaim, owner: string): boolean {
    return this.store.beginDelivery(claim, owner);
  }

  public markTerminalInjected(claim: DeliveryClaim, owner: string): boolean {
    return this.store.markDeliveryTerminalInjected(claim, owner);
  }

  public fail(
    claim: DeliveryClaim,
    owner: string,
    reason: string,
    options: { maxAttempts: number; retryAt: Date },
  ): DeliveryAttemptResult {
    return this.store.failDeliveryAttempt(claim, owner, reason, options);
  }

  public revoke(claim: DeliveryClaim, owner: string, reason: string): boolean {
    return this.store.revokeClaim(claim, owner, reason);
  }

  public reject(claim: DeliveryClaim, owner: string, reason: string): boolean {
    return this.store.rejectClaim(claim, owner, reason);
  }
}
