import type { MessageSubmissionResult, SubmitMessageCommand } from "@nanasa/contracts";

import { MessageRepository } from "./message-repository.js";

export class MessageCommandService {
  public constructor(private readonly messages: MessageRepository) {}

  public submit(
    groupId: string,
    command: SubmitMessageCommand,
    idempotencyKey?: string,
  ): MessageSubmissionResult {
    return this.messages.submit(groupId, command, idempotencyKey);
  }
}
