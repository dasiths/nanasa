import type { MessageSubmissionResult, SubmitMessageCommand } from "@nanasa/contracts";

import { NanasaStore } from "./store.js";

export class MessageCommandService {
  readonly #store: NanasaStore;

  public constructor(store: NanasaStore) {
    this.#store = store;
  }

  public submit(
    groupId: string,
    command: SubmitMessageCommand,
    idempotencyKey?: string,
  ): MessageSubmissionResult {
    return this.#store.submitMessage(groupId, command, idempotencyKey);
  }
}
