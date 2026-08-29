import { createHash, randomUUID } from "node:crypto";
import type {
  CreateGroupAgentCommand,
  CreateGroupCommand,
  DeleteGroupResult,
  Group,
  GroupMembership,
  RemoveGroupAgentResult,
  RoleDefinition,
  UpdateGroupAgentCommand,
  UpdateGroupCommand,
  UpdateRolePresentationCommand,
} from "@nanasa/contracts";
import { ConfigRepository } from "./config-repository.js";
import { dockerMemberName, formatMemberId } from "./member-id.js";
import { normalizeAgentOrder } from "./membership-order.js";
import { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
import { DomainError, NanasaStore } from "./store.js";
import { normalizeGroupOrder } from "./topology-order-service.js";

function stableId(prefix: string, scope: string, idempotencyKey?: string): string {
  if (idempotencyKey === undefined) return `${prefix}_${randomUUID()}`;
  return `${prefix}_${createHash("sha256").update(`${scope}:${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

export class TopologyService {
  readonly #repository: ConfigRepository;
  readonly #store: NanasaStore;
  readonly #coordinator: RunRuntimeCoordinator;

  public constructor(
    repository: ConfigRepository,
    store: NanasaStore,
    coordinator: RunRuntimeCoordinator,
  ) {
    this.#repository = repository;
    this.#store = store;
    this.#coordinator = coordinator;
  }

  public async reconcile(): Promise<void> {
    const loaded = this.#repository.load();
    const snapshot = this.#store.getSnapshot();
    const desiredGroupIds = new Set(Object.keys(loaded.config.groups));
    for (const group of snapshot.groups) {
      if (!desiredGroupIds.has(group.id)) {
        await this.#coordinator.deleteGroup(group.id);
        continue;
      }
      const desiredMemberIds = new Set(
        Object.values(loaded.config.groups[group.id]?.agents ?? {}).map((agent) => agent.memberId),
      );
      for (const membership of snapshot.memberships.filter(
        (candidate) => candidate.groupId === group.id,
      )) {
        if (!desiredMemberIds.has(membership.memberId)) {
          await this.#coordinator.removeMembership(group.id, membership.memberId);
        }
      }
    }
    this.#store.reconcileTopology(loaded.config, loaded.status);
  }

  public async createGroup(command: CreateGroupCommand, idempotencyKey?: string): Promise<Group> {
    const groupId = stableId("grp", "group.create", idempotencyKey);
    const mutation = await this.#repository.mutate((config) => ({
      config: {
        ...config,
        groups: normalizeGroupOrder({
          ...config.groups,
          [groupId]: config.groups[groupId] ?? {
            name: command.name.trim(),
            instructions: command.instructions ?? [],
            agents: {},
          },
        }),
      },
      result: groupId,
    }));
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("group.created", "group", groupId, { groupId });
    return this.#store.getGroup(groupId);
  }

  public async updateGroup(groupId: string, command: UpdateGroupCommand): Promise<Group> {
    if (command.instructions !== undefined) {
      const activeMembership = this.#store
        .listActiveMemberships(groupId)
        .find((membership) => this.#store.getActiveRun(groupId, membership.memberId) !== undefined);
      if (activeMembership !== undefined) {
        throw new DomainError(
          "active_run_group_change_requires_restart",
          "Stop agents in this group before changing group instructions",
          409,
        );
      }
    }
    const mutation = await this.#repository.mutate((config) => {
      const group = config.groups[groupId];
      if (group === undefined) throw new DomainError("group_not_found", "Group not found", 404);
      return {
        config: {
          ...config,
          groups: {
            ...config.groups,
            [groupId]: {
              ...group,
              name: command.name?.trim() ?? group.name,
              instructions: command.instructions ?? group.instructions,
            },
          },
        },
        result: groupId,
      };
    });
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("group.updated", "group", groupId, { groupId });
    return this.#store.getGroup(groupId);
  }

  public async updateRolePresentation(
    roleId: string,
    presentation: UpdateRolePresentationCommand,
  ): Promise<RoleDefinition> {
    const mutation = await this.#repository.mutate((config) => {
      const role = config.roles[roleId];
      if (role === undefined) throw new DomainError("role_not_found", "Role not found", 404);
      return {
        config: {
          ...config,
          roles: { ...config.roles, [roleId]: { ...role, presentation } },
        },
        result: roleId,
      };
    });
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("role.presentation.updated", "role", roleId, { roleId });
    return mutation.loaded.config.roles[roleId] as RoleDefinition;
  }

  public async deleteGroup(groupId: string, idempotencyKey?: string): Promise<DeleteGroupResult> {
    await this.#repository.mutate((config) => {
      if (config.groups[groupId] === undefined) {
        const replay = this.#store.getDeleteGroupResult(groupId, idempotencyKey);
        if (replay !== undefined) return { config, result: groupId };
        throw new DomainError("group_not_found", "Group not found", 404);
      }
      const groups = { ...config.groups };
      delete groups[groupId];
      return { config: { ...config, groups: normalizeGroupOrder(groups) }, result: groupId };
    });
    return this.#coordinator.deleteGroup(groupId, idempotencyKey);
  }

  public async createAgent(
    groupId: string,
    command: CreateGroupAgentCommand,
    idempotencyKey?: string,
  ): Promise<GroupMembership> {
    const agentId = stableId("agent", `group.${groupId}.agent.create`, idempotencyKey);
    const mutation = await this.#repository.mutate((config) => {
      const group = config.groups[groupId];
      if (group === undefined) throw new DomainError("group_not_found", "Group not found", 404);
      if (config.integrations[command.integrationId] === undefined) {
        throw new DomainError("integration_not_found", "Integration not found", 400);
      }
      if (command.roleId !== undefined && config.roles[command.roleId] === undefined) {
        throw new DomainError("role_not_found", "Role not found", 404);
      }
      const existing = group.agents[agentId];
      let memberId = existing?.memberId;
      if (memberId === undefined) {
        do {
          memberId = formatMemberId(dockerMemberName());
        } while (Object.values(group.agents).some((agent) => agent.memberId === memberId));
      }
      return {
        config: {
          ...config,
          groups: {
            ...config.groups,
            [groupId]: {
              ...group,
              agents: normalizeAgentOrder({
                ...group.agents,
                [agentId]: existing ?? {
                  memberId,
                  name: command.name.trim(),
                  integrationId: command.integrationId,
                  instructions: command.instructions ?? [],
                  ...(command.roleId === undefined ? {} : { roleId: command.roleId }),
                },
              }),
            },
          },
        },
        result: { agentId, memberId },
      };
    });
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("agent.created", "group", groupId, mutation.result);
    return this.#store
      .listActiveMemberships(groupId)
      .find((membership) => membership.id === mutation.result.agentId) as GroupMembership;
  }

  public async updateAgent(
    groupId: string,
    agentId: string,
    command: UpdateGroupAgentCommand,
  ): Promise<GroupMembership> {
    const current = this.#repository.load().config.groups[groupId]?.agents[agentId];
    if (current === undefined) throw new DomainError("agent_not_found", "Agent not found", 404);
    const roleId = command.roleId === null ? undefined : (command.roleId ?? current.roleId);
    const requiresStoppedRun =
      (command.integrationId !== undefined && command.integrationId !== current.integrationId) ||
      (command.roleId !== undefined && roleId !== current.roleId) ||
      (command.instructions !== undefined &&
        JSON.stringify(command.instructions) !== JSON.stringify(current.instructions));
    if (requiresStoppedRun && this.#store.getActiveRun(groupId, current.memberId) !== undefined) {
      throw new DomainError(
        "active_run_agent_change_requires_restart",
        "Stop the active agent before changing its integration, role, or instructions",
        409,
      );
    }
    const mutation = await this.#repository.mutate((config) => {
      const group = config.groups[groupId];
      if (group === undefined) throw new DomainError("group_not_found", "Group not found", 404);
      const agent = group.agents[agentId];
      if (agent === undefined) throw new DomainError("agent_not_found", "Agent not found", 404);
      const nextIntegrationId = command.integrationId ?? agent.integrationId;
      if (config.integrations[nextIntegrationId] === undefined) {
        throw new DomainError("integration_not_found", "Integration not found", 400);
      }
      if (roleId !== undefined && config.roles[roleId] === undefined) {
        throw new DomainError("role_not_found", "Role not found", 404);
      }
      return {
        config: {
          ...config,
          groups: {
            ...config.groups,
            [groupId]: {
              ...group,
              agents: {
                ...group.agents,
                [agentId]: {
                  ...agent,
                  name: command.name?.trim() ?? agent.name,
                  integrationId: nextIntegrationId,
                  roleId,
                  instructions: command.instructions ?? agent.instructions,
                },
              },
            },
          },
        },
        result: agentId,
      };
    });
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("agent.updated", "group", groupId, { agentId });
    return this.#store
      .listActiveMemberships(groupId)
      .find((membership) => membership.id === agentId) as GroupMembership;
  }

  public async removeAgent(
    groupId: string,
    agentId: string,
    idempotencyKey?: string,
  ): Promise<RemoveGroupAgentResult> {
    const current = this.getAgentMembership(groupId, agentId);
    const revokedDeliveries = this.#store
      .listDeliveries()
      .filter(
        (delivery) =>
          delivery.recipientMemberId === current.memberId &&
          ["queued", "received", "delivering", "retrying"].includes(delivery.status),
      ).length;
    await this.#repository.mutate((config) => {
      const group = config.groups[groupId];
      if (group === undefined) throw new DomainError("group_not_found", "Group not found", 404);
      if (group.agents[agentId] === undefined) {
        throw new DomainError("agent_not_found", "Agent not found", 404);
      }
      const agents = { ...group.agents };
      delete agents[agentId];
      return {
        config: {
          ...config,
          groups: {
            ...config.groups,
            [groupId]: { ...group, agents: normalizeAgentOrder(agents) },
          },
        },
        result: agentId,
      };
    });
    await this.#coordinator.removeMembership(groupId, current.memberId, idempotencyKey);
    return { groupId, agentId, deletedRuns: 0, revokedDeliveries };
  }

  public getAgentMembership(groupId: string, agentId: string): GroupMembership {
    const configured = this.#repository.load().config.groups[groupId]?.agents[agentId];
    if (configured === undefined) throw new DomainError("agent_not_found", "Agent not found", 404);
    const membership = this.#store
      .listActiveMemberships(groupId)
      .find((candidate) => candidate.id === agentId);
    if (membership === undefined) throw new DomainError("agent_not_found", "Agent not found", 404);
    return membership;
  }
}
