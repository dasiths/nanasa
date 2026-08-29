import type {
  ClearMessageHistoryResult,
  GroupMessageState,
  MessagePage,
  MessageSubmissionResult,
  SubmitMessageCommand,
} from "@nanasa/contracts";
import type { NanasaStore } from "./store.js";

export class MessageRepository {
  public constructor(private readonly store: NanasaStore) {}

  public submit(
    groupId: string,
    command: SubmitMessageCommand,
    idempotencyKey?: string,
  ): MessageSubmissionResult {
    return this.store.submitMessage(groupId, command, idempotencyKey);
  }

  public state(groupId: string): GroupMessageState {
    return this.store.getGroupMessageState(groupId);
  }

  public page(
    groupId: string,
    options: { limit?: number; before?: number; after?: number } = {},
  ): MessagePage {
    return this.store.listMessagePage(groupId, options);
  }

  public clear(groupId: string, idempotencyKey?: string): ClearMessageHistoryResult {
    return this.store.clearMessageHistory(groupId, idempotencyKey);
  }
}
