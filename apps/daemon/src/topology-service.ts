import { createHash, randomUUID } from "node:crypto";
import type {
  AddGroupMembershipCommand,
  AgentProfile,
  CreateAgentProfileCommand,
  CreateGroupCommand,
  DeleteGroupResult,
  Group,
  GroupMembership,
  ReorderGroupMembershipsCommand,
  ReorderGroupMembershipsResult,
  RoleDefinition,
  UpdateAgentProfileCommand,
  UpdateGroupCommand,
  UpdateGroupMembershipCommand,
  UpdateRolePresentationCommand,
} from "@nanasa/contracts";
import { ConfigRepository } from "./config-repository.js";
import { dockerMemberName, formatMemberId } from "./member-id.js";
import { normalizeMembershipOrder } from "./membership-order.js";
import { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
import { DomainError, NanasaStore } from "./store.js";

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
        Object.values(loaded.config.groups[group.id]?.memberships ?? {}).map(
          (membership) => membership.memberId,
        ),
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
        groups: {
          ...config.groups,
          [groupId]: config.groups[groupId] ?? {
            name: command.name.trim(),
            instructions: command.instructions ?? [],
            memberships: {},
          },
        },
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
      return { config: { ...config, groups }, result: groupId };
    });
    return this.#coordinator.deleteGroup(groupId, idempotencyKey);
  }

  public async createAgentProfile(
    command: CreateAgentProfileCommand,
    idempotencyKey?: string,
  ): Promise<AgentProfile> {
    const profileId = stableId("profile", "agent-profile.create", idempotencyKey);
    const mutation = await this.#repository.mutate((config) => {
      if (config.agentTypes[command.agentType] === undefined) {
        throw new DomainError("agent_type_not_found", "Agent type not found", 400);
      }
      if (
        command.defaultRoleId !== undefined &&
        config.roles[command.defaultRoleId] === undefined
      ) {
        throw new DomainError("role_not_found", "Role not found", 404);
      }
      return {
        config: {
          ...config,
          agentProfiles: {
            ...config.agentProfiles,
            [profileId]: config.agentProfiles[profileId] ?? {
              name: command.name.trim(),
              agentType: command.agentType,
              instructions: command.instructions ?? [],
              ...(command.defaultRoleId === undefined
                ? {}
                : { defaultRoleId: command.defaultRoleId }),
            },
          },
        },
        result: profileId,
      };
    });
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("agent-profile.created", "agent-profile", profileId, {
      profileId,
    });
    return this.#store.getAgentProfile(profileId);
  }

  public async updateAgentProfile(
    profileId: string,
    command: UpdateAgentProfileCommand,
  ): Promise<AgentProfile> {
    const promptChange = command.defaultRoleId !== undefined || command.instructions !== undefined;
    if (promptChange) {
      const activeMembership = this.#store
        .getSnapshot()
        .memberships.find(
          (membership) =>
            membership.agentProfileId === profileId &&
            this.#store.getActiveRun(membership.groupId, membership.memberId) !== undefined,
        );
      if (activeMembership !== undefined) {
        throw new DomainError(
          "active_run_profile_change_requires_restart",
          "Stop agents using this profile before changing its role or instructions",
          409,
        );
      }
    }
    const mutation = await this.#repository.mutate((config) => {
      const profile = config.agentProfiles[profileId];
      if (profile === undefined) {
        throw new DomainError("agent_profile_not_found", "Agent profile not found", 404);
      }
      const defaultRoleId =
        command.defaultRoleId === null
          ? undefined
          : (command.defaultRoleId ?? profile.defaultRoleId);
      if (defaultRoleId !== undefined && config.roles[defaultRoleId] === undefined) {
        throw new DomainError("role_not_found", "Role not found", 404);
      }
      return {
        config: {
          ...config,
          agentProfiles: {
            ...config.agentProfiles,
            [profileId]: {
              ...profile,
              name: command.name?.trim() ?? profile.name,
              defaultRoleId,
              instructions: command.instructions ?? profile.instructions,
            },
          },
        },
        result: profileId,
      };
    });
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("agent-profile.updated", "agent-profile", profileId, {
      profileId,
    });
    return this.#store.getAgentProfile(profileId);
  }

  public async addMembership(
    groupId: string,
    command: AddGroupMembershipCommand,
    idempotencyKey?: string,
  ): Promise<GroupMembership> {
    const membershipId = stableId("membership", `group.${groupId}.membership.add`, idempotencyKey);
    const mutation = await this.#repository.mutate((config) => {
      const group = config.groups[groupId];
      const profile = config.agentProfiles[command.agentProfileId];
      if (group === undefined) throw new DomainError("group_not_found", "Group not found", 404);
      if (profile === undefined) {
        throw new DomainError("agent_profile_not_found", "Agent profile not found", 404);
      }
      if (command.roleId !== undefined && config.roles[command.roleId] === undefined) {
        throw new DomainError("role_not_found", "Role not found", 404);
      }
      let memberId = command.memberId;
      if (memberId === undefined) {
        do {
          memberId = formatMemberId(profile.agentType, dockerMemberName());
        } while (
          Object.values(group.memberships).some((membership) => membership.memberId === memberId)
        );
      }
      if (
        Object.values(group.memberships).some(
          (membership) =>
            membership.memberId === memberId &&
            group.memberships[membershipId]?.memberId !== memberId,
        )
      ) {
        throw new DomainError("membership_exists", "The member is already active", 409);
      }
      return {
        config: {
          ...config,
          groups: {
            ...config.groups,
            [groupId]: {
              ...group,
              memberships: normalizeMembershipOrder({
                ...group.memberships,
                [membershipId]: group.memberships[membershipId] ?? {
                  memberId,
                  agentProfileId: command.agentProfileId,
                  alias: command.alias.trim(),
                  instructions: command.instructions ?? [],
                  ...(command.roleId === undefined ? {} : { roleId: command.roleId }),
                },
              }),
            },
          },
        },
        result: { membershipId, memberId },
      };
    });
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("membership.added", "group", groupId, mutation.result);
    return this.#store
      .listActiveMemberships(groupId)
      .find((membership) => membership.id === mutation.result.membershipId) as GroupMembership;
  }

  public async updateMembership(
    groupId: string,
    memberId: string,
    command: UpdateGroupMembershipCommand,
  ): Promise<GroupMembership> {
    const mutation = await this.#repository.mutate((config) => {
      const group = config.groups[groupId];
      if (group === undefined) throw new DomainError("group_not_found", "Group not found", 404);
      const entry = Object.entries(group.memberships).find(
        ([, membership]) => membership.memberId === memberId,
      );
      if (entry === undefined) {
        throw new DomainError("membership_not_found", "Membership not found", 404);
      }
      const [membershipId, membership] = entry;
      if (
        (command.roleId !== undefined || command.instructions !== undefined) &&
        this.#store.getActiveRun(groupId, memberId) !== undefined
      ) {
        throw new DomainError(
          "active_run_role_change_requires_restart",
          "Stop the active agent before changing its role",
          409,
        );
      }
      const roleId = command.roleId === null ? undefined : (command.roleId ?? membership.roleId);
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
              memberships: {
                ...group.memberships,
                [membershipId]: {
                  ...membership,
                  alias: command.alias?.trim() ?? membership.alias,
                  roleId,
                  instructions: command.instructions ?? membership.instructions,
                },
              },
            },
          },
        },
        result: membershipId,
      };
    });
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("membership.updated", "group", groupId, { memberId });
    return this.#store
      .listActiveMemberships(groupId)
      .find((membership) => membership.memberId === memberId) as GroupMembership;
  }

  public async removeMembership(
    groupId: string,
    memberId: string,
    idempotencyKey?: string,
  ): Promise<GroupMembership> {
    await this.#repository.mutate((config) => {
      const group = config.groups[groupId];
      if (group === undefined) throw new DomainError("group_not_found", "Group not found", 404);
      const entry = Object.entries(group.memberships).find(
        ([, membership]) => membership.memberId === memberId,
      );
      if (entry === undefined) {
        throw new DomainError("membership_not_found", "Membership not found", 404);
      }
      const memberships = { ...group.memberships };
      delete memberships[entry[0]];
      return {
        config: {
          ...config,
          groups: {
            ...config.groups,
            [groupId]: { ...group, memberships: normalizeMembershipOrder(memberships) },
          },
        },
        result: entry[0],
      };
    });
    return this.#coordinator.removeMembership(groupId, memberId, idempotencyKey);
  }

  public async reorderMemberships(
    groupId: string,
    command: ReorderGroupMembershipsCommand,
  ): Promise<ReorderGroupMembershipsResult> {
    const mutation = await this.#repository.mutate((config) => {
      const group = config.groups[groupId];
      if (group === undefined) throw new DomainError("group_not_found", "Group not found", 404);
      const entriesByMemberId = new Map(
        Object.entries(group.memberships).map(([membershipId, membership]) => [
          membership.memberId,
          [membershipId, membership] as const,
        ]),
      );
      if (
        command.memberIds.length !== entriesByMemberId.size ||
        command.memberIds.some((memberId) => !entriesByMemberId.has(memberId))
      ) {
        throw new DomainError(
          "membership_order_stale",
          "Memberships changed while preparing the new order; refresh and retry",
          409,
        );
      }
      const memberships = Object.fromEntries(
        command.memberIds.map((memberId, order) => {
          const [membershipId, membership] = entriesByMemberId.get(memberId) as readonly [
            string,
            (typeof group.memberships)[string],
          ];
          return [membershipId, { ...membership, order }];
        }),
      );
      return {
        config: {
          ...config,
          groups: { ...config.groups, [groupId]: { ...group, memberships } },
        },
        result: { groupId, memberIds: command.memberIds },
      };
    });
    this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status);
    this.#store.recordRuntimeEvent("membership.reordered", "group", groupId, mutation.result);
    return mutation.result;
  }
}
