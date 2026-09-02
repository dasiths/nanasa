import { AgentStatusDetailSchema, AgentStatusSummarySchema } from "@nanasa/contracts";
import { NanasaStore } from "./store.js";

export class AgentStatusQueryService {
  readonly #store: NanasaStore;

  public constructor(store: NanasaStore) {
    this.#store = store;
  }

  public list(groupId: string, operatorId: string) {
    return this.#store
      .listAgentStatuses(groupId, operatorId)
      .map((status) => AgentStatusSummarySchema.parse(status));
  }

  public get(groupId: string, memberId: string, operatorId: string) {
    return AgentStatusDetailSchema.parse(this.#store.getAgentStatus(groupId, memberId, operatorId));
  }

  public acknowledgeCompletion(groupId: string, memberId: string, operatorId: string) {
    const status = this.#store.getAgentStatus(groupId, memberId, operatorId);
    if (status.runId === undefined) return status;
    this.#store.acknowledgeCompletion(operatorId, status.runId);
    return this.get(groupId, memberId, operatorId);
  }
}
