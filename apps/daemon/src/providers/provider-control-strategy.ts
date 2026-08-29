import type { AgentReplyChannel } from "@nanasa/contracts";

export interface ProviderControlStrategy {
  readonly waitReplyChannels: readonly AgentReplyChannel[];
  readonly supportsPromptAcknowledgement: boolean;
  readonly supportsCancellation: boolean;
  readonly terminalSubmitSequence: string;
}

export function freezeControlStrategy(strategy: ProviderControlStrategy): ProviderControlStrategy {
  return Object.freeze({
    ...strategy,
    waitReplyChannels: Object.freeze([...strategy.waitReplyChannels]),
  });
}
