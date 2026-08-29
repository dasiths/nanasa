import type { DomainEvent } from "@nanasa/contracts";
import type { DomainEventListener, NanasaStore } from "./store.js";

export interface EventBounds {
  earliestAvailable: number;
  highWater: number;
}

export class EventLog {
  public constructor(private readonly store: NanasaStore) {}

  public bounds(): EventBounds {
    return this.store.eventBounds();
  }

  public page(afterSequence: number, throughSequence: number, limit: number): DomainEvent[] {
    return this.store.listEventPage(afterSequence, throughSequence, limit);
  }

  public subscribe(listener: DomainEventListener): () => void {
    return this.store.onEvent(listener);
  }
}
