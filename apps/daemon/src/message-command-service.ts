import type { MessageSubmissionResult, SubmitMessageCommand } from "@nanasa/contracts";

import { MessageRepository } from "./message-repository.js";

export class MessageCommandService {
  public constructor(
    private readonly messages: MessageRepository,
    private readonly authorize?: (groupId: string, command: SubmitMessageCommand) => void,
  ) {}

  public submit(
    groupId: string,
    command: SubmitMessageCommand,
    idempotencyKey?: string,
  ): MessageSubmissionResult {
    this.authorize?.(groupId, command);
    return this.messages.submit(groupId, command, idempotencyKey);
  }
}
