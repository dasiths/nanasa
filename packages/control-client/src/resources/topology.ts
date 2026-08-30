import {
  GroupMembershipSchema,
  GroupSchema,
  RemoveGroupAgentResultSchema,
  ReorderGroupAgentsResultSchema,
  ReorderGroupsResultSchema,
  ReparentGroupAgentResultSchema,
  RoleDefinitionSchema,
  type AssignAgentCheckoutCommand,
  type CreateGroupAgentCommand,
  type CreateGroupCommand,
  type Group,
  type GroupMembership,
  type RemoveGroupAgentResult,
  type ReorderGroupAgentsCommand,
  type ReorderGroupAgentsResult,
  type ReorderGroupsCommand,
  type ReorderGroupsResult,
  type ReparentGroupAgentCommand,
  type ReparentGroupAgentResult,
  type RoleDefinition,
  type UpdateGroupAgentCommand,
  type UpdateGroupCommand,
  type UpdateRolePresentationCommand,
} from "@nanasa/contracts";
import type { NanasaControlClient } from "../index.js";
import { commandInit, path, request } from "./common.js";

const RolesSchema = {
  parse(value: unknown): Record<string, RoleDefinition> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Expected a role map");
    }
    return Object.fromEntries(
      Object.entries(value).map(([id, role]) => [id, RoleDefinitionSchema.parse(role)]),
    );
  },
};

export class TopologyResource {
  public constructor(private readonly client: NanasaControlClient) {}

  public listGroups(): Promise<Group[]> {
    return request(this.client, path("groups"), GroupSchema.array());
  }

  public getGroup(groupId: string): Promise<Group> {
    return request(this.client, path("groups", groupId), GroupSchema);
  }

  public createGroup(command: CreateGroupCommand, key?: string): Promise<Group> {
    return request(this.client, path("groups"), GroupSchema, commandInit("POST", command, key));
  }

  public updateGroup(groupId: string, command: UpdateGroupCommand, key?: string): Promise<Group> {
    return request(
      this.client,
      path("groups", groupId),
      GroupSchema,
      commandInit("PATCH", command, key),
    );
  }

  public deleteGroup(groupId: string, key?: string): Promise<unknown> {
    return this.client.request(
      path("groups", groupId),
      { parse: (value) => value },
      {
        init: commandInit("DELETE", {}, key),
      },
    );
  }

  public reorderGroups(command: ReorderGroupsCommand, key?: string): Promise<ReorderGroupsResult> {
    return request(
      this.client,
      path("group-order"),
      ReorderGroupsResultSchema,
      commandInit("PUT", command, key),
    );
  }

  public listAgents(groupId: string): Promise<GroupMembership[]> {
    return request(this.client, path("groups", groupId, "agents"), GroupMembershipSchema.array());
  }

  public getAgent(groupId: string, agentId: string): Promise<GroupMembership> {
    return request(this.client, path("groups", groupId, "agents", agentId), GroupMembershipSchema);
  }

  public createAgent(
    groupId: string,
    command: CreateGroupAgentCommand,
    key?: string,
  ): Promise<GroupMembership> {
    return request(
      this.client,
      path("groups", groupId, "agents"),
      GroupMembershipSchema,
      commandInit("POST", command, key),
    );
  }

  public updateAgent(
    groupId: string,
    agentId: string,
    command: UpdateGroupAgentCommand,
    key?: string,
  ): Promise<GroupMembership> {
    return request(
      this.client,
      path("groups", groupId, "agents", agentId),
      GroupMembershipSchema,
      commandInit("PATCH", command, key),
    );
  }

  public deleteAgent(
    groupId: string,
    agentId: string,
    key?: string,
  ): Promise<RemoveGroupAgentResult> {
    return request(
      this.client,
      path("groups", groupId, "agents", agentId),
      RemoveGroupAgentResultSchema,
      commandInit("DELETE", {}, key),
    );
  }

  public reorderAgents(
    groupId: string,
    command: ReorderGroupAgentsCommand,
    key?: string,
  ): Promise<ReorderGroupAgentsResult> {
    return request(
      this.client,
      path("groups", groupId, "agent-order"),
      ReorderGroupAgentsResultSchema,
      commandInit("PUT", command, key),
    );
  }

  public reparentAgent(
    groupId: string,
    agentId: string,
    command: ReparentGroupAgentCommand,
    key?: string,
  ): Promise<ReparentGroupAgentResult> {
    return request(
      this.client,
      path("groups", groupId, "agents", agentId, "reparent"),
      ReparentGroupAgentResultSchema,
      commandInit("POST", command, key),
    );
  }

  public assignCheckout(
    groupId: string,
    agentId: string,
    command: AssignAgentCheckoutCommand,
    key?: string,
  ): Promise<void> {
    return this.client.requestVoid(
      path("groups", groupId, "agents", agentId, "checkout"),
      commandInit("PUT", command, key),
    );
  }

  public listRoles(): Promise<Record<string, RoleDefinition>> {
    return request(this.client, path("roles"), RolesSchema);
  }

  public getRole(roleId: string): Promise<RoleDefinition> {
    return request(this.client, path("roles", roleId), RoleDefinitionSchema);
  }

  public updateRolePresentation(
    roleId: string,
    command: UpdateRolePresentationCommand,
    key?: string,
  ): Promise<RoleDefinition> {
    return request(
      this.client,
      path("roles", roleId, "presentation"),
      RoleDefinitionSchema,
      commandInit("PATCH", command, key),
    );
  }
}
