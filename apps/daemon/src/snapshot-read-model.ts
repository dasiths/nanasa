import type { PortalSnapshot } from "@nanasa/contracts";
import type { NanasaStore } from "./store.js";

export class SnapshotReadModel {
  public constructor(
    private readonly store: NanasaStore,
    private readonly authority: { instanceId: string; daemonEpoch: number },
  ) {}

  public read(operatorId: string): PortalSnapshot {
    return this.store.getSnapshot(this.authority, operatorId);
  }
}
