import type { AgentReplyChannel, AgentWaitKind, OpenWaitReply } from "@nanasa/contracts";

export interface ProviderControlStrategy {
  readonly waitReplyChannels: readonly AgentReplyChannel[];
  readonly supportsPromptAcknowledgement: boolean;
  readonly supportsCancellation: boolean;
  readonly terminalSubmitSequence: string;
  waitReplyInput(kind: AgentWaitKind, reply: OpenWaitReply): string;
}

export function closedTerminalWaitReplyInput(_kind: AgentWaitKind, reply: OpenWaitReply): string {
  switch (reply.kind) {
    case "answer":
      return reply.text;
    case "select":
      return reply.option;
    case "allow-once":
    case "approve-plan":
      return "y";
    case "deny":
    case "reject-plan":
      return "n";
  }
}

export function freezeControlStrategy(strategy: ProviderControlStrategy): ProviderControlStrategy {
  return Object.freeze({
    ...strategy,
    waitReplyChannels: Object.freeze([...strategy.waitReplyChannels]),
  });
}
