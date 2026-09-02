import type {
  ConfiguredGroup,
  NanasaConfig,
  ReorderGroupAgentsCommand,
  ReorderGroupAgentsResult,
  ReorderGroupsCommand,
  ReorderGroupsResult,
  ReparentGroupAgentCommand,
  ReparentGroupAgentResult,
} from "@nanasa/contracts";
import { ConfigRepository } from "./config-repository.js";
import { normalizeAgentOrder } from "./membership-order.js";
import { DomainError, NanasaStore } from "./store.js";

export function orderedGroupEntries(
  groups: Readonly<Record<string, ConfiguredGroup>>,
): Array<[string, ConfiguredGroup]> {
  return Object.entries(groups)
    .map(([groupId, group], sourceIndex) => ({ groupId, group, sourceIndex }))
    .sort(
      (left, right) =>
        (left.group.order ?? left.sourceIndex) - (right.group.order ?? right.sourceIndex) ||
        left.sourceIndex - right.sourceIndex ||
        left.groupId.localeCompare(right.groupId),
    )
    .map(({ groupId, group }) => [groupId, group]);
}

export function normalizeGroupOrder(
  groups: Readonly<Record<string, ConfiguredGroup>>,
): Record<string, ConfiguredGroup> {
  return Object.fromEntries(
    orderedGroupEntries(groups).map(([groupId, group], order) => [
      groupId,
      { ...group, order, agents: normalizeAgentOrder(group.agents) },
    ]),
  );
}

export class TopologyOrderService {
  public constructor(
    private readonly repository: ConfigRepository,
    private readonly store: NanasaStore,
  ) {}

  public async reorderGroups(command: ReorderGroupsCommand): Promise<ReorderGroupsResult> {
    this.#assertRevision(command.expectedOrderRevision);
    const mutation = await this.repository.mutate((config) => {
      if (
        command.groupIds.length !== Object.keys(config.groups).length ||
        command.groupIds.some((groupId) => config.groups[groupId] === undefined)
      ) {
        throw new DomainError("topology_order_stale", "Groups changed; refresh and retry", 409);
      }
      const groups = Object.fromEntries(
        command.groupIds.map((groupId, order) => [groupId, { ...config.groups[groupId]!, order }]),
      );
      return { config: { ...config, groups }, result: command.groupIds };
    });
    this.store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    const result = { groupIds: mutation.result, orderRevision: this.store.getOrderRevision() };
    this.store.recordRuntimeEvent("group.reordered", "topology", "groups", result);
    return result;
  }

  public async reorderAgents(
    groupId: string,
    command: ReorderGroupAgentsCommand,
  ): Promise<ReorderGroupAgentsResult> {
    this.#assertRevision(command.expectedOrderRevision);
    const mutation = await this.repository.mutate((config) => {
      const group = config.groups[groupId];
      if (
        group === undefined ||
        command.agentIds.length !== Object.keys(group.agents).length ||
        command.agentIds.some((agentId) => group.agents[agentId] === undefined)
      ) {
        throw new DomainError("topology_order_stale", "Agents changed; refresh and retry", 409);
      }
      const agents = Object.fromEntries(
        command.agentIds.map((agentId, order) => [agentId, { ...group.agents[agentId]!, order }]),
      );
      return {
        config: {
          ...config,
          groups: { ...config.groups, [groupId]: { ...group, agents } },
        },
        result: command.agentIds,
      };
    });
    this.store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    const result = {
      groupId,
      agentIds: mutation.result,
      orderRevision: this.store.getOrderRevision(),
    };
    this.store.recordRuntimeEvent("agent.reordered", "group", groupId, result);
    return result;
  }

  public async reparentAgent(
    sourceGroupId: string,
    agentId: string,
    command: ReparentGroupAgentCommand,
  ): Promise<ReparentGroupAgentResult> {
    this.#assertRevision(command.expectedOrderRevision);
    const membership = this.store
      .listActiveMemberships(sourceGroupId)
      .find((candidate) => candidate.id === agentId);
    if (membership === undefined) throw new DomainError("agent_not_found", "Agent not found", 404);
    const latest = this.store.getLatestRunForMembership(sourceGroupId, membership.memberId);
    if (
      this.store.getActiveRun(sourceGroupId, membership.memberId) !== undefined ||
      latest?.desiredState === "running"
    ) {
      throw new DomainError(
        "active_run_reparent_refused",
        "Stop the agent before moving it to another group",
        409,
      );
    }
    if (sourceGroupId === command.targetGroupId) {
      throw new DomainError(
        "agent_already_in_group",
        "Agent already belongs to the target group",
        409,
      );
    }
    const mutation = await this.repository.mutate((config) => {
      const source = config.groups[sourceGroupId];
      const target = config.groups[command.targetGroupId];
      const agent = source?.agents[agentId];
      if (source === undefined || target === undefined || agent === undefined) {
        throw new DomainError("topology_order_stale", "Topology changed; refresh and retry", 409);
      }
      if (Object.values(target.agents).some((candidate) => candidate.memberId === agent.memberId)) {
        throw new DomainError(
          "target_member_id_conflict",
          "The target group already contains this member ID",
          409,
        );
      }
      const sourceAgents = { ...source.agents };
      delete sourceAgents[agentId];
      const targetAgents = normalizeAgentOrder({
        ...target.agents,
        [agentId]: { ...agent, order: Object.keys(target.agents).length },
      });
      const groups = normalizeGroupOrder({
        ...config.groups,
        [sourceGroupId]: { ...source, agents: normalizeAgentOrder(sourceAgents) },
        [command.targetGroupId]: { ...target, agents: targetAgents },
      });
      return { config: { ...config, groups }, result: agent.memberId };
    });
    this.store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    const result = {
      agentId,
      memberId: mutation.result,
      sourceGroupId,
      targetGroupId: command.targetGroupId,
      orderRevision: this.store.getOrderRevision(),
    };
    this.store.recordRuntimeEvent("agent.reparented", "membership", agentId, result);
    return result;
  }

  public async assignCheckout(groupId: string, agentId: string, checkoutId: string): Promise<void> {
    await this.assignCheckoutToAgents([{ groupId, agentId }], checkoutId);
  }

  public assertAgentsStopped(
    agentIds: readonly string[],
  ): Array<{ groupId: string; agentId: string }> {
    const config = this.repository.load().config;
    return agentIds.map((agentId) => {
      const groupId = Object.entries(config.groups).find(
        ([, group]) => group.agents[agentId] !== undefined,
      )?.[0];
      if (groupId === undefined)
        throw new DomainError("agent_not_found", `Agent ${agentId} not found`, 404);
      this.#assertAgentStopped(groupId, agentId);
      return { groupId, agentId };
    });
  }

  public async assignCheckoutToAgents(
    agents: readonly { groupId: string; agentId: string }[],
    checkoutId: string,
  ): Promise<void> {
    for (const { groupId, agentId } of agents) this.#assertAgentStopped(groupId, agentId);
    const checkout = this.store.getCheckout(checkoutId);
    if (checkout.kind === "bare") {
      throw new DomainError("bare_checkout_cannot_run", "Agents cannot use a bare checkout", 409);
    }
    const mutation = await this.repository.mutate((config: NanasaConfig) => {
      const groups = { ...config.groups };
      for (const { groupId, agentId } of agents) {
        const group = groups[groupId];
        const agent = group?.agents[agentId];
        if (group === undefined || agent === undefined) {
          throw new DomainError("agent_not_found", "Agent not found", 404);
        }
        groups[groupId] = {
          ...group,
          agents: { ...group.agents, [agentId]: { ...agent, checkoutId } },
        };
      }
      return { config: { ...config, groups }, result: checkoutId };
    });
    this.store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    for (const { groupId, agentId } of agents) {
      this.store.recordRuntimeEvent("membership.checkout-assigned", "membership", agentId, {
        groupId,
        agentId,
        checkoutId,
      });
    }
  }

  #assertAgentStopped(groupId: string, agentId: string): void {
    const membership = this.store
      .listActiveMemberships(groupId)
      .find((candidate) => candidate.id === agentId);
    if (membership === undefined) throw new DomainError("agent_not_found", "Agent not found", 404);
    const latest = this.store.getLatestRunForMembership(groupId, membership.memberId);
    if (
      this.store.getActiveRun(groupId, membership.memberId) !== undefined ||
      latest?.desiredState === "running"
    ) {
      throw new DomainError(
        "active_run_checkout_change_refused",
        "Stop the agent before assigning another checkout",
        409,
      );
    }
  }

  #assertRevision(expected: number): void {
    if (this.store.getOrderRevision() !== expected) {
      throw new DomainError(
        "topology_order_stale",
        "Topology order changed; refresh and retry",
        409,
      );
    }
  }
}
