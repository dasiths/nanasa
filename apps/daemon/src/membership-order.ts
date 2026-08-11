import type { ConfiguredAgent } from "@nanasa/contracts";

export function orderedAgentEntries(
  agents: Readonly<Record<string, ConfiguredAgent>>,
): Array<[string, ConfiguredAgent]> {
  return Object.entries(agents)
    .map(([agentId, agent], sourceIndex) => ({
      agentId,
      agent,
      sourceIndex,
    }))
    .sort((left, right) => {
      const leftOrder = left.agent.order;
      const rightOrder = right.agent.order;
      if (leftOrder !== undefined && rightOrder !== undefined) {
        return (
          leftOrder - rightOrder ||
          left.sourceIndex - right.sourceIndex ||
          left.agentId.localeCompare(right.agentId)
        );
      }
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return left.sourceIndex - right.sourceIndex || left.agentId.localeCompare(right.agentId);
    })
    .map(({ agentId, agent }) => [agentId, agent]);
}

export function normalizeAgentOrder(
  agents: Readonly<Record<string, ConfiguredAgent>>,
): Record<string, ConfiguredAgent> {
  return Object.fromEntries(
    orderedAgentEntries(agents).map(([agentId, agent], order) => [agentId, { ...agent, order }]),
  );
}
