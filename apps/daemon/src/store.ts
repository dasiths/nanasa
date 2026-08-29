import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  type AgentProfile,
  AgentProfileSchema,
  type AgentProgressReportCommand,
  AgentProgressReportCommandSchema,
  type AgentRun,
  AgentRunSchema,
  type AgentStatusDetail,
  AgentStatusDetailSchema,
  type AgentStatusEventInput,
  AgentStatusEventInputSchema,
  type AgentStatusSummary,
  AgentStatusSummarySchema,
  type ClearMessageHistoryResult,
  ClearMessageHistoryResultSchema,
  type ConfigStatus,
  type CreateGroupCommand,
  CreateGroupCommandSchema,
  DEFAULT_MESSAGE_PAGE_SIZE,
  type DeleteGroupResult,
  DeleteGroupResultSchema,
  type DeliveryOutcome,
  DeliveryOutcomeSchema,
  type DeliveryStatus,
  type DomainEvent,
  DomainEventSchema,
  type Group,
  type GroupMembership,
  GroupMembershipSchema,
  type GroupMessageState,
  GroupMessageStateSchema,
  GroupSchema,
  type InternalCreateAgentProfileCommand,
  InternalCreateAgentProfileCommandSchema,
  MAX_MESSAGE_PAGE_SIZE,
  type Message,
  type MessagePage,
  MessagePageSchema,
  MessageSchema,
  type MessageSubmissionResult,
  MessageSubmissionResultSchema,
  type NanasaConfig,
  type PortalSnapshot,
  PortalSnapshotSchema,
  type RecoveryPhase,
  type RunStatus,
  type StartGroupRunsResult,
  StartGroupRunsResultSchema,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
  type TerminalBinding,
  type TerminalCheckpoint,
  TerminalCheckpointSchema,
  type UpdateGroupCommand,
  UpdateGroupCommandSchema,
} from "@nanasa/contracts";

import {
  type AgentStatusReducerState,
  createAgentStatusReducerState,
  type ProcessStatusObservation,
  reduceAgentStatus,
} from "./agent-status-reducer.js";
import { dockerMemberName, formatMemberId, type MemberNameGenerator } from "./member-id.js";
import { orderedAgentEntries } from "./membership-order.js";
import { openNanasaDatabase } from "./persistence/database.js";

interface AddMembershipInput {
  memberId?: string;
  agentProfileId: string;
  alias: string;
  roleId?: string;
}

interface UpdateMembershipInput {
  alias?: string;
  roleId?: string | null;
}

interface Parser<T> {
  parse(value: unknown): T;
}

interface CommandResult<T> {
  result: T;
  event: DomainEvent;
}

interface EventRow {
  sequence: number;
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  payload_json: string;
}

interface GroupRow {
  id: string;
  name: string;
  membership_revision: number;
  created_at: string;
  updated_at: string;
}

interface AgentProfileRow {
  id: string;
  name: string;
  agent_type: string | null;
  kind: string;
  command: string;
  args_json: string;
  working_directory: string | null;
  environment_json: string;
  created_at: string;
  updated_at: string;
}

interface MembershipRow {
  id: string;
  group_id: string;
  member_id: string;
  agent_profile_id: string;
  alias: string;
  role_id: string | null;
  state: string;
  joined_at: string;
  removed_at: string | null;
}

interface RunRow {
  id: string;
  group_id: string;
  member_id: string;
  agent_profile_id: string;
  generation: number;
  status: string;
  desired_state: string | null;
  recovery_phase: string | null;
  recovery_attempts: number | null;
  recovery_not_before: string | null;
  recovery_reason: string | null;
  terminal_json: string | null;
  started_at: string;
  stopped_at: string | null;
}

interface MessageRow {
  id: string;
  group_id: string;
  group_seq: number;
  conversation_id: string;
  intent: string;
  sender_json: string;
  audience_json: string;
  body_json: string;
  delivery_json: string;
  reply_to: string | null;
  root_id: string | null;
  causation_id: string | null;
  hop: number;
  created_at: string;
}

interface DeliveryRow {
  message_id: string;
  recipient_member_id: string;
  reason: string | null;
  status: string;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  run_id: string | null;
  run_generation: number | null;
  updated_at: string;
}

interface AgentStatusCurrentRow {
  reducer_state_json: string;
}

export interface AgentStatusIdentity {
  groupId: string;
  memberId: string;
  runId: string;
  generation: number;
}

export interface AgentStatusIngestResult {
  accepted: true;
  duplicate: boolean;
  observedAt: string;
  status: AgentStatusDetail;
}

export interface DeliveryClaim {
  delivery: DeliveryOutcome;
  message: Message;
  senderAlias: string;
  profile: AgentProfile;
  run?: AgentRun;
  recipientActive: boolean;
}

export interface ClaimDeliveriesOptions {
  owner: string;
  now: Date;
  leaseMs: number;
  limit: number;
}

export interface DeliveryAttemptResult {
  status: DeliveryStatus;
  reason?: string;
  nextAttemptAt?: string;
}

export interface NanasaStoreOptions {
  config?: NanasaConfig;
  configStatus?: ConfigStatus;
  memberNameGenerator?: MemberNameGenerator;
}

export class DomainError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export type DomainEventListener = (event: DomainEvent) => void;

function agentStatusSummary(detail: AgentStatusDetail): AgentStatusSummary {
  return AgentStatusSummarySchema.parse({
    groupId: detail.groupId,
    memberId: detail.memberId,
    alias: detail.alias,
    agentType: detail.agentType,
    roleId: detail.roleId,
    roleName: detail.roleName,
    runId: detail.runId,
    generation: detail.generation,
    runStatus: detail.runStatus,
    state: detail.state,
    phase: detail.phase,
    outcome: detail.outcome,
    confidence: detail.confidence,
    attention: detail.attention,
    observedAt: detail.observedAt,
    stateChangedAt: detail.stateChangedAt,
    lastActivityAt: detail.lastActivityAt,
    lastActivityKind: detail.lastActivityKind,
    lastProgressSummary: detail.lastProgressSummary,
    progressStage: detail.progressStage,
    nextStep: detail.nextStep,
    blocker: detail.blocker,
  });
}

export class NanasaStore {
  readonly #database: DatabaseSync;
  readonly #listeners = new Set<DomainEventListener>();
  #config: NanasaConfig | undefined;
  #configStatus: ConfigStatus | undefined;
  #messageRetentionPerGroup: number;
  readonly #memberNameGenerator: MemberNameGenerator;

  public constructor(path: string, options: NanasaStoreOptions = {}) {
    this.#database = openNanasaDatabase(path);
    this.#config = options.config;
    this.#configStatus = options.configStatus;
    this.#messageRetentionPerGroup = options.config?.messages.retentionPerGroup ?? 1_000;
    this.#memberNameGenerator = options.memberNameGenerator ?? dockerMemberName;
  }

  public close(): void {
    this.#database.close();
  }

  public onEvent(listener: DomainEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public reconcileTopology(config: NanasaConfig, configStatus?: ConfigStatus): void {
    const timestamp = new Date().toISOString();
    this.#transaction(() => {
      for (const [roleId, definition] of Object.entries(config.roles)) {
        this.#database
          .prepare(
            `INSERT INTO roles (id, definition_json, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               definition_json = excluded.definition_json,
               updated_at = excluded.updated_at`,
          )
          .run(roleId, JSON.stringify(definition), timestamp, timestamp);
      }
      for (const configuredGroup of Object.values(config.groups)) {
        for (const [agentId, configuredAgent] of Object.entries(configuredGroup.agents)) {
          const integration = config.integrations[configuredAgent.integrationId];
          if (integration === undefined) {
            throw new DomainError(
              "configured_integration_not_found",
              `Integration ${configuredAgent.integrationId} is not configured`,
              409,
            );
          }
          this.#database
            .prepare(
              `INSERT INTO agent_profiles
                 (id, name, agent_type, kind, command, args_json,
                  working_directory, environment_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 agent_type = excluded.agent_type,
                 kind = excluded.kind,
                 command = excluded.command,
                 args_json = excluded.args_json,
                 working_directory = excluded.working_directory,
                 environment_json = excluded.environment_json,
                 updated_at = excluded.updated_at`,
            )
            .run(
              agentId,
              configuredAgent.name,
              integration.id,
              integration.kind,
              integration.command[0] as string,
              JSON.stringify(integration.command.slice(1)),
              integration.cwd ?? null,
              JSON.stringify(integration.environment),
              timestamp,
              timestamp,
            );
        }
      }

      const desiredGroupIds = new Set(Object.keys(config.groups));
      for (const [groupId, configuredGroup] of Object.entries(config.groups)) {
        const existingGroup = this.#database
          .prepare("SELECT * FROM groups WHERE id = ?")
          .get(groupId) as unknown as GroupRow | undefined;
        const existingMemberships = this.#database
          .prepare("SELECT * FROM memberships WHERE group_id = ? AND state = 'active'")
          .all(groupId) as unknown as MembershipRow[];
        const desiredMemberships = Object.entries(configuredGroup.agents);
        const existingIdentity = existingMemberships
          .map(
            (membership) =>
              `${membership.id}:${membership.member_id}:${membership.agent_profile_id}`,
          )
          .sort();
        const desiredIdentity = desiredMemberships
          .map(([agentId, agent]) => `${agentId}:${agent.memberId}:${agentId}`)
          .sort();
        const membershipChanged =
          JSON.stringify(existingIdentity) !== JSON.stringify(desiredIdentity);
        const membershipRevision =
          (existingGroup?.membership_revision ?? 0) + (membershipChanged ? 1 : 0);
        const groupUpdatedAt =
          existingGroup !== undefined &&
          existingGroup.name === configuredGroup.name &&
          existingGroup.membership_revision === membershipRevision
            ? existingGroup.updated_at
            : timestamp;
        this.#database
          .prepare(
            `INSERT INTO groups (id, name, membership_revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               membership_revision = excluded.membership_revision,
               updated_at = excluded.updated_at`,
          )
          .run(
            groupId,
            configuredGroup.name,
            membershipRevision,
            existingGroup?.created_at ?? timestamp,
            groupUpdatedAt,
          );

        const desiredMembershipIds = new Set(
          desiredMemberships.map(([membershipId]) => membershipId),
        );
        for (const [agentId, agent] of desiredMemberships) {
          this.#database
            .prepare(
              `INSERT INTO memberships
                 (id, group_id, member_id, agent_profile_id, alias, role_id, state, joined_at, removed_at)
               VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)
               ON CONFLICT(id) DO UPDATE SET
                 group_id = excluded.group_id,
                 member_id = excluded.member_id,
                 agent_profile_id = excluded.agent_profile_id,
                 alias = excluded.alias,
                 role_id = excluded.role_id,
                 state = 'active',
                 removed_at = NULL`,
            )
            .run(
              agentId,
              groupId,
              agent.memberId,
              agentId,
              agent.name,
              agent.roleId ?? null,
              timestamp,
            );
        }
        for (const existing of existingMemberships) {
          if (desiredMembershipIds.has(existing.id)) continue;
          this.#database
            .prepare("UPDATE memberships SET state = 'removed', removed_at = ? WHERE id = ?")
            .run(timestamp, existing.id);
          this.#database
            .prepare(
              `UPDATE deliveries SET status = 'revoked', reason = 'membership_removed',
                 lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE recipient_member_id = ?
                 AND status IN ('queued', 'received', 'delivering', 'retrying')
                 AND message_id IN (SELECT id FROM messages WHERE group_id = ?)`,
            )
            .run(timestamp, existing.member_id, groupId);
        }
      }

      const persistedGroups = this.#database.prepare("SELECT id FROM groups").all() as Array<{
        id: string;
      }>;
      for (const persisted of persistedGroups) {
        if (desiredGroupIds.has(persisted.id)) continue;
        this.#database
          .prepare(
            "UPDATE memberships SET state = 'removed', removed_at = ? WHERE group_id = ? AND state = 'active'",
          )
          .run(timestamp, persisted.id);
      }
    });
    this.#config = config;
    this.#configStatus = configStatus;
    this.#messageRetentionPerGroup = config.messages.retentionPerGroup;
  }

  public createGroup(command: CreateGroupCommand, idempotencyKey?: string): Group {
    const input = CreateGroupCommandSchema.parse(command);
    return this.#executeIdempotent("group.create", idempotencyKey, GroupSchema, () => {
      const timestamp = new Date().toISOString();
      const group = GroupSchema.parse({
        id: `grp_${randomUUID()}`,
        name: input.name,
        membershipRevision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      this.#database
        .prepare(
          `INSERT INTO groups (id, name, membership_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(group.id, group.name, group.membershipRevision, group.createdAt, group.updatedAt);
      return {
        result: group,
        event: this.#appendEvent("group.created", "group", group.id, { group }),
      };
    });
  }

  public updateGroup(groupId: string, command: UpdateGroupCommand, idempotencyKey?: string): Group {
    const input = UpdateGroupCommandSchema.parse(command);
    return this.#executeIdempotent(`group.${groupId}.update`, idempotencyKey, GroupSchema, () => {
      const existing = this.#requireGroup(groupId);
      const timestamp = new Date().toISOString();
      const name = input.name ?? existing.name;
      this.#database
        .prepare("UPDATE groups SET name = ?, updated_at = ? WHERE id = ?")
        .run(name, timestamp, groupId);
      const group = GroupSchema.parse({
        ...existing,
        name,
        updatedAt: timestamp,
      });
      return {
        result: group,
        event: this.#appendEvent("group.updated", "group", groupId, {
          group,
          previousName: existing.name,
        }),
      };
    });
  }

  public getDeleteGroupResult(
    groupId: string,
    idempotencyKey: string | undefined,
  ): DeleteGroupResult | undefined {
    if (idempotencyKey === undefined) return undefined;
    const existing = this.#database
      .prepare("SELECT response_json FROM idempotency_keys WHERE scope = ? AND key = ?")
      .get(`group.${groupId}.delete`, idempotencyKey) as { response_json: string } | undefined;
    return existing === undefined
      ? undefined
      : DeleteGroupResultSchema.parse(JSON.parse(existing.response_json));
  }

  public deleteGroup(groupId: string, idempotencyKey?: string): DeleteGroupResult {
    return this.#executeIdempotent(
      `group.${groupId}.delete`,
      idempotencyKey,
      DeleteGroupResultSchema,
      () => {
        this.#requireGroup(groupId);
        for (const column of ["reply_to", "root_id", "causation_id"] as const) {
          this.#database
            .prepare(
              `UPDATE messages SET ${column} = NULL
               WHERE group_id <> ?
                 AND ${column} IN (SELECT id FROM messages WHERE group_id = ?)`,
            )
            .run(groupId, groupId);
        }
        const deletedDeliveries = this.#database
          .prepare(
            "DELETE FROM deliveries WHERE message_id IN (SELECT id FROM messages WHERE group_id = ?)",
          )
          .run(groupId);
        const deletedMessages = this.#database
          .prepare("DELETE FROM messages WHERE group_id = ?")
          .run(groupId);
        this.#database
          .prepare(
            "DELETE FROM status_progress_reports WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?)",
          )
          .run(groupId);
        this.#database
          .prepare(
            "DELETE FROM runtime_observations WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?)",
          )
          .run(groupId);
        this.#database
          .prepare(
            "DELETE FROM status_revisions WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?)",
          )
          .run(groupId);
        const deletedRuns = this.#database
          .prepare("DELETE FROM runs WHERE group_id = ?")
          .run(groupId);
        const deletedMemberships = this.#database
          .prepare("DELETE FROM memberships WHERE group_id = ?")
          .run(groupId);
        const escapedScopePrefix = `group.${groupId}.`.replace(/[\\%_]/g, "\\$&");
        this.#database
          .prepare("DELETE FROM idempotency_keys WHERE scope LIKE ? ESCAPE '\\'")
          .run(`${escapedScopePrefix}%`);
        this.#database.prepare("DELETE FROM groups WHERE id = ?").run(groupId);
        const result = DeleteGroupResultSchema.parse({
          groupId,
          deletedMemberships: Number(deletedMemberships.changes),
          deletedRuns: Number(deletedRuns.changes),
          deletedMessages: Number(deletedMessages.changes),
          deletedDeliveries: Number(deletedDeliveries.changes),
        });
        return {
          result,
          event: this.#appendEvent("group.deleted", "group", groupId, result),
        };
      },
    );
  }

  public createInternalAgentProfile(
    command: InternalCreateAgentProfileCommand,
    idempotencyKey?: string,
  ): AgentProfile {
    return this.#createAgentProfile(
      InternalCreateAgentProfileCommandSchema.parse(command),
      idempotencyKey,
    );
  }

  #createAgentProfile(
    input: InternalCreateAgentProfileCommand,
    idempotencyKey?: string,
  ): AgentProfile {
    return this.#executeIdempotent(
      "agent-profile.create",
      idempotencyKey,
      AgentProfileSchema,
      () => {
        const timestamp = new Date().toISOString();
        const profile = AgentProfileSchema.parse({
          ...input,
          id: `profile_${randomUUID()}`,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        this.#database
          .prepare(
            `INSERT INTO agent_profiles
              (id, name, agent_type, kind, command, args_json,
               working_directory, environment_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            profile.id,
            profile.name,
            profile.agentType,
            profile.kind,
            profile.command,
            JSON.stringify(profile.args),
            profile.workingDirectory ?? null,
            JSON.stringify(profile.environment),
            profile.createdAt,
            profile.updatedAt,
          );
        return {
          result: profile,
          event: this.#appendEvent("agent-profile.created", "agent-profile", profile.id, {
            agentProfile: profile,
          }),
        };
      },
    );
  }

  public addMembership(
    groupId: string,
    command: AddMembershipInput,
    idempotencyKey?: string,
  ): GroupMembership {
    const input = command;
    const scope = `group.${groupId}.membership.add`;
    return this.#executeIdempotent(scope, idempotencyKey, GroupMembershipSchema, () => {
      this.#requireGroup(groupId);
      this.#requireAgentProfile(input.agentProfileId);
      const memberId = input.memberId ?? this.#generateMemberId(groupId);
      const existing = this.#getMembershipRow(groupId, memberId);
      if (existing?.state === "active") {
        throw new DomainError("membership_exists", "The member is already active", 409);
      }

      const timestamp = new Date().toISOString();
      const membership = GroupMembershipSchema.parse({
        id: existing?.id ?? `membership_${randomUUID()}`,
        groupId,
        memberId,
        agentProfileId: input.agentProfileId,
        alias: input.alias,
        roleId: input.roleId,
        state: "active",
        joinedAt: timestamp,
      });

      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO memberships
               (id, group_id, member_id, agent_profile_id, alias, role_id, state, joined_at, removed_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
          )
          .run(
            membership.id,
            membership.groupId,
            membership.memberId,
            membership.agentProfileId,
            membership.alias,
            membership.roleId ?? null,
            membership.joinedAt,
          );
      } else {
        this.#database
          .prepare(
            `UPDATE memberships
             SET agent_profile_id = ?, alias = ?, role_id = ?, state = 'active', joined_at = ?, removed_at = NULL
             WHERE id = ?`,
          )
          .run(
            membership.agentProfileId,
            membership.alias,
            membership.roleId ?? null,
            membership.joinedAt,
            membership.id,
          );
      }
      const revision = this.#incrementMembershipRevision(groupId, timestamp);
      return {
        result: membership,
        event: this.#appendEvent("membership.added", "group", groupId, {
          membership,
          membershipRevision: revision,
        }),
      };
    });
  }

  public updateMembership(
    groupId: string,
    memberId: string,
    command: UpdateMembershipInput,
    idempotencyKey?: string,
  ): GroupMembership {
    const input = command;
    const scope = `group.${groupId}.membership.${memberId}.update`;
    return this.#executeIdempotent(scope, idempotencyKey, GroupMembershipSchema, () => {
      this.#requireGroup(groupId);
      const existing = this.#getMembershipRow(groupId, memberId);
      if (existing === undefined || existing.state !== "active") {
        throw new DomainError("membership_not_active", "The member is not active", 404);
      }

      const alias = input.alias ?? existing.alias;
      const roleId = input.roleId === undefined ? existing.role_id : input.roleId;
      this.#database
        .prepare("UPDATE memberships SET alias = ?, role_id = ? WHERE id = ?")
        .run(alias, roleId, existing.id);
      const membership = GroupMembershipSchema.parse({
        id: existing.id,
        groupId: existing.group_id,
        memberId: existing.member_id,
        agentProfileId: existing.agent_profile_id,
        alias,
        roleId: roleId ?? undefined,
        state: existing.state,
        joinedAt: existing.joined_at,
      });
      return {
        result: membership,
        event: this.#appendEvent("membership.updated", "group", groupId, {
          membership,
          previousAlias: existing.alias,
        }),
      };
    });
  }

  public removeMembership(
    groupId: string,
    memberId: string,
    idempotencyKey?: string,
  ): GroupMembership {
    const scope = `group.${groupId}.membership.${memberId}.remove`;
    return this.#executeIdempotent(scope, idempotencyKey, GroupMembershipSchema, () => {
      this.#requireGroup(groupId);
      const existing = this.#getMembershipRow(groupId, memberId);
      if (existing === undefined || existing.state !== "active") {
        throw new DomainError("membership_not_active", "The member is not active", 404);
      }

      const timestamp = new Date().toISOString();
      this.#database
        .prepare("UPDATE memberships SET state = 'removed', removed_at = ? WHERE id = ?")
        .run(timestamp, existing.id);
      const revoked = this.#database
        .prepare(
          `UPDATE deliveries
           SET status = 'revoked', reason = 'membership_removed', lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE recipient_member_id = ?
             AND status IN ('queued', 'retrying', 'received', 'delivering')
             AND message_id IN (SELECT id FROM messages WHERE group_id = ?)`,
        )
        .run(timestamp, memberId, groupId);
      const revision = this.#incrementMembershipRevision(groupId, timestamp);
      const membership = GroupMembershipSchema.parse({
        id: existing.id,
        groupId: existing.group_id,
        memberId: existing.member_id,
        agentProfileId: existing.agent_profile_id,
        alias: existing.alias,
        state: "removed",
        joinedAt: existing.joined_at,
        removedAt: timestamp,
      });
      return {
        result: membership,
        event: this.#appendEvent("membership.removed", "group", groupId, {
          membership,
          membershipRevision: revision,
          revokedDeliveries: Number(revoked.changes),
        }),
      };
    });
  }

  public createRun(run: AgentRun): AgentRun {
    const input = AgentRunSchema.parse(run);
    const { result, event } = this.#transaction(() => {
      const membership = this.#getMembershipRow(input.groupId, input.memberId);
      if (
        membership === undefined ||
        membership.state !== "active" ||
        membership.agent_profile_id !== input.agentProfileId
      ) {
        throw new DomainError("invalid_run_membership", "Run member is not active", 409);
      }

      this.#database
        .prepare(
          `INSERT INTO runs
             (id, group_id, member_id, agent_profile_id, generation, status,
            desired_state, recovery_phase, recovery_attempts, recovery_not_before,
            recovery_reason, terminal_json, started_at, stopped_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.groupId,
          input.memberId,
          input.agentProfileId,
          input.generation,
          input.status,
          input.desiredState,
          input.recoveryPhase,
          input.recoveryAttempts,
          input.recoveryNotBefore ?? null,
          input.recoveryReason ?? null,
          input.terminal === undefined ? null : JSON.stringify(input.terminal),
          input.startedAt,
          input.stoppedAt ?? null,
        );
      this.#upsertAgentStatusState(
        input,
        createAgentStatusReducerState(input.id, input.generation, input.startedAt),
      );
      return {
        result: input,
        event: this.#appendEvent("run.created", "run", input.id, { run: input }),
      };
    });
    this.#publish(event);
    return result;
  }

  public createRunForMembership(
    groupId: string,
    memberId: string,
    options: {
      recoveryFrom?: AgentRun;
    } = {},
  ): {
    run: AgentRun;
    profile: AgentProfile;
    membership: GroupMembership;
  } {
    this.#requireGroup(groupId);
    const membership = this.#getMembershipRow(groupId, memberId);
    if (membership === undefined || membership.state !== "active") {
      throw new DomainError("membership_not_active", "The member is not active", 404);
    }
    const active = this.getActiveRun(groupId, memberId);
    if (active !== undefined) {
      throw new DomainError("run_already_active", "The member already has an active run", 409);
    }
    const generationRow = this.#database
      .prepare(
        `SELECT COALESCE(MAX(generation), 0) + 1 AS generation
         FROM runs WHERE group_id = ? AND member_id = ?`,
      )
      .get(groupId, memberId) as unknown as { generation: number };
    const run = this.createRun({
      id: `run_${randomUUID()}`,
      groupId,
      memberId,
      agentProfileId: membership.agent_profile_id,
      generation: generationRow.generation,
      status: "starting",
      desiredState: "running",
      recoveryPhase: options.recoveryFrom === undefined ? "idle" : "restarting",
      recoveryAttempts: options.recoveryFrom?.recoveryAttempts ?? 0,
      recoveryNotBefore: options.recoveryFrom?.recoveryNotBefore,
      recoveryReason: options.recoveryFrom?.recoveryReason,
      startedAt: new Date().toISOString(),
    });
    return {
      run,
      profile: this.#requireAgentProfile(membership.agent_profile_id),
      membership: this.#hydrateMembership(membership),
    };
  }

  public getRun(runId: string): AgentRun {
    const row = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as unknown as
      | RunRow
      | undefined;
    if (row === undefined) {
      throw new DomainError("run_not_found", "Run not found", 404);
    }
    return this.#hydrateRun(row);
  }

  public getAgentProfile(profileId: string): AgentProfile {
    return this.#requireAgentProfile(profileId);
  }

  public getGroup(groupId: string): Group {
    return this.#requireGroup(groupId);
  }

  public listAgentStatuses(groupId: string): AgentStatusSummary[] {
    this.#requireGroup(groupId);
    return this.listActiveMemberships(groupId)
      .sort((left, right) => left.memberId.localeCompare(right.memberId))
      .map((membership) =>
        agentStatusSummary(this.#getAgentStatusDetail(groupId, membership.memberId)),
      );
  }

  public getAgentStatus(groupId: string, memberId: string): AgentStatusDetail {
    this.#requireGroup(groupId);
    return this.#getAgentStatusDetail(groupId, memberId);
  }

  public getActiveRun(groupId: string, memberId: string): AgentRun | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM runs
         WHERE group_id = ? AND member_id = ?
           AND status IN ('starting', 'running', 'stopping')
         ORDER BY generation DESC LIMIT 1`,
      )
      .get(groupId, memberId) as unknown as RunRow | undefined;
    return row === undefined ? undefined : this.#hydrateRun(row);
  }

  public getLatestRunForMembership(groupId: string, memberId: string): AgentRun | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM runs
         WHERE group_id = ? AND member_id = ?
         ORDER BY generation DESC LIMIT 1`,
      )
      .get(groupId, memberId) as unknown as RunRow | undefined;
    return row === undefined ? undefined : this.#hydrateRun(row);
  }

  public listActiveRuns(): AgentRun[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM runs WHERE status IN ('starting', 'running', 'stopping')
         ORDER BY started_at, id`,
      )
      .all() as unknown as RunRow[];
    return rows.map((row) => this.#hydrateRun(row));
  }

  public listDesiredRunningRuns(): AgentRun[] {
    const rows = this.#database
      .prepare(
        `SELECT r.* FROM runs r
         JOIN memberships m ON m.group_id = r.group_id AND m.member_id = r.member_id
         WHERE r.desired_state = 'running' AND m.state = 'active'
           AND r.generation = (
             SELECT MAX(newer.generation) FROM runs newer
             WHERE newer.group_id = r.group_id AND newer.member_id = r.member_id
           )
         ORDER BY r.started_at, r.id`,
      )
      .all() as unknown as RunRow[];
    return rows.map((row) => this.#hydrateRun(row));
  }

  public listGroupRunsRequiringStop(groupId: string): AgentRun[] {
    this.#requireGroup(groupId);
    const rows = this.#database
      .prepare(
        `SELECT r.* FROM runs r
         WHERE r.group_id = ?
           AND (r.status IN ('starting', 'running', 'stopping') OR r.desired_state = 'running')
           AND r.generation = (
             SELECT MAX(newer.generation) FROM runs newer
             WHERE newer.group_id = r.group_id AND newer.member_id = r.member_id
           )
         ORDER BY r.started_at, r.id`,
      )
      .all(groupId) as unknown as RunRow[];
    return rows.map((row) => this.#hydrateRun(row));
  }

  public listActiveMemberships(groupId: string): GroupMembership[] {
    this.#requireGroup(groupId);
    const rows = this.#database
      .prepare(
        `SELECT * FROM memberships
         WHERE group_id = ? AND state = 'active'
         ORDER BY member_id, id`,
      )
      .all(groupId) as unknown as MembershipRow[];
    return rows.map((row) => this.#hydrateMembership(row));
  }

  public updateRunStatus(
    runId: string,
    status: RunStatus,
    options: { terminal?: TerminalBinding; reason?: string } = {},
  ): AgentRun {
    const current = this.getRun(runId);
    const allowed: Record<RunStatus, readonly RunStatus[]> = {
      starting: ["starting", "running", "stopping", "failed"],
      running: ["running", "stopping", "stopped", "failed"],
      stopping: ["stopping", "stopped", "failed"],
      stopped: ["stopped"],
      failed: ["failed"],
    };
    if (!allowed[current.status].includes(status)) {
      throw new DomainError(
        "invalid_run_transition",
        `Cannot transition run from ${current.status} to ${status}`,
        409,
      );
    }

    const terminal = options.terminal ?? current.terminal;
    const stoppedAt = status === "stopped" || status === "failed" ? new Date().toISOString() : null;
    const { result, event } = this.#transaction(() => {
      const desiredState =
        status === "stopping" || status === "stopped" ? "stopped" : current.desiredState;
      this.#database
        .prepare(
          `UPDATE runs
           SET status = ?, desired_state = ?, terminal_json = ?, stopped_at = ?,
               recovery_phase = CASE WHEN ? = 'stopped' THEN 'idle' ELSE recovery_phase END,
               recovery_not_before = CASE WHEN ? = 'stopped' THEN NULL ELSE recovery_not_before END,
               recovery_reason = CASE WHEN ? = 'stopped' THEN ? ELSE recovery_reason END
           WHERE id = ?`,
        )
        .run(
          status,
          desiredState,
          terminal === undefined ? null : JSON.stringify(terminal),
          stoppedAt,
          desiredState,
          desiredState,
          desiredState,
          options.reason ?? "operator_stopped",
          runId,
        );
      const updated = this.getRun(runId);
      return {
        result: updated,
        event: this.#appendEvent("run.status-changed", "run", runId, {
          run: updated,
          previousStatus: current.status,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        }),
      };
    });
    this.#publish(event);
    if (status === "running") {
      this.recordProcessStatus(runId, {
        event: "process.alive",
        eventId: `process-alive-${current.generation}`,
        observedAt: new Date().toISOString(),
      });
    } else if (status === "stopped" || status === "failed") {
      this.recordProcessStatus(runId, {
        event: "process.exited",
        eventId: `process-exited-${current.generation}-${status}`,
        observedAt: new Date().toISOString(),
        operatorStopped: status === "stopped",
      });
    }
    return result;
  }

  public ingestAgentStatusEvent(
    identity: AgentStatusIdentity,
    event: AgentStatusEventInput,
  ): AgentStatusIngestResult {
    const input = AgentStatusEventInputSchema.parse(event);
    const observedAt = new Date().toISOString();
    const completed = this.#transaction(() => {
      const run = this.#requireCurrentAgentStatusRun(identity);
      const duplicate = this.#database
        .prepare(
          `SELECT 1 FROM runtime_observations
           WHERE run_id = ? AND generation = ? AND event_id = ?`,
        )
        .get(run.id, run.generation, input.eventId);
      if (duplicate !== undefined) {
        return {
          status: this.#getAgentStatusDetail(run.groupId, run.memberId),
          duplicate: true,
          domainEvents: [] as DomainEvent[],
        };
      }
      const previous = this.#agentStatusState(run);
      const next = reduceAgentStatus(previous, {
        event: "reporter.event",
        observedAt,
        input,
      });
      this.#insertAgentStatusEvent(
        run,
        input.eventId,
        input.source,
        input.event,
        observedAt,
        input,
      );
      this.#upsertAgentStatusState(run, next);
      this.#trimAgentStatusEvents(run.id, run.generation);
      return {
        status: this.#getAgentStatusDetail(run.groupId, run.memberId),
        duplicate: false,
        domainEvents: this.#appendAgentStatusDomainEvents(run, previous, next),
      };
    });
    for (const domainEvent of completed.domainEvents) this.#publish(domainEvent);
    return {
      accepted: true,
      duplicate: completed.duplicate,
      observedAt,
      status: completed.status,
    };
  }

  public reportAgentProgress(
    identity: AgentStatusIdentity,
    report: AgentProgressReportCommand,
  ): AgentStatusDetail {
    const input = AgentProgressReportCommandSchema.parse(report);
    const observedAt = new Date().toISOString();
    const completed = this.#transaction(() => {
      const run = this.#requireCurrentAgentStatusRun(identity);
      const eventId = `progress_${randomUUID()}`;
      this.#database
        .prepare(
          `INSERT INTO status_progress_reports
             (id, run_id, generation, stage, summary, next_step, blocker, outcome, reported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          run.id,
          run.generation,
          input.stage,
          input.summary,
          input.nextStep ?? null,
          input.blocker ?? null,
          input.outcome ?? null,
          observedAt,
        );
      const previous = this.#agentStatusState(run);
      const next = reduceAgentStatus(previous, {
        event: "progress.reported",
        eventId,
        observedAt,
        report: input,
      });
      this.#insertAgentStatusEvent(
        run,
        eventId,
        "status_api",
        "progress.reported",
        observedAt,
        input,
      );
      this.#upsertAgentStatusState(run, next);
      this.#trimAgentStatusEvents(run.id, run.generation);
      return {
        status: this.#getAgentStatusDetail(run.groupId, run.memberId),
        domainEvents: this.#appendAgentStatusDomainEvents(run, previous, next),
      };
    });
    for (const domainEvent of completed.domainEvents) this.#publish(domainEvent);
    return completed.status;
  }

  public recordProcessStatus(
    runId: string,
    observation: ProcessStatusObservation,
  ): AgentStatusDetail {
    const completed = this.#transaction(() => {
      const run = this.getRun(runId);
      const duplicate = this.#database
        .prepare(
          `SELECT 1 FROM runtime_observations
           WHERE run_id = ? AND generation = ? AND event_id = ?`,
        )
        .get(run.id, run.generation, observation.eventId);
      if (duplicate !== undefined) {
        return {
          status: this.#getAgentStatusDetail(run.groupId, run.memberId),
          domainEvents: [] as DomainEvent[],
        };
      }
      const previous = this.#agentStatusState(run);
      const next = reduceAgentStatus(previous, observation);
      this.#insertAgentStatusEvent(
        run,
        observation.eventId,
        "process",
        observation.event,
        observation.observedAt,
        observation,
      );
      this.#upsertAgentStatusState(run, next);
      this.#trimAgentStatusEvents(run.id, run.generation);
      return {
        status: this.#getAgentStatusDetail(run.groupId, run.memberId),
        domainEvents: this.#appendAgentStatusDomainEvents(run, previous, next),
      };
    });
    for (const domainEvent of completed.domainEvents) this.#publish(domainEvent);
    return completed.status;
  }

  public transitionRunRecovery(
    runId: string,
    generation: number,
    phase: RecoveryPhase,
    options: {
      incrementAttempt?: boolean;
      recoveryNotBefore?: string;
      reason?: string;
    } = {},
  ): AgentRun {
    const current = this.getRun(runId);
    if (current.generation !== generation || current.desiredState !== "running") {
      throw new DomainError(
        "recovery_generation_fenced",
        "The run recovery generation is no longer authoritative",
        409,
      );
    }
    const recoveryAttempts = current.recoveryAttempts + (options.incrementAttempt === true ? 1 : 0);
    const recoveryNotBefore = options.recoveryNotBefore ?? current.recoveryNotBefore;
    const recoveryReason = options.reason ?? current.recoveryReason;
    const { result, event } = this.#transaction(() => {
      const updated = this.#database
        .prepare(
          `UPDATE runs
           SET recovery_phase = ?, recovery_attempts = ?, recovery_not_before = ?,
               recovery_reason = ?
           WHERE id = ? AND generation = ? AND desired_state = 'running'`,
        )
        .run(
          phase,
          recoveryAttempts,
          recoveryNotBefore ?? null,
          recoveryReason ?? null,
          runId,
          generation,
        );
      if (Number(updated.changes) !== 1) {
        throw new DomainError(
          "recovery_generation_fenced",
          "The run recovery generation is no longer authoritative",
          409,
        );
      }
      const run = this.getRun(runId);
      return {
        result: run,
        event: this.#appendEvent("run.recovery-changed", "run", runId, {
          run,
          previousPhase: current.recoveryPhase,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        }),
      };
    });
    this.#publish(event);
    return result;
  }

  public stopDesiredRun(runId: string, generation: number, reason = "operator_stopped"): AgentRun {
    const current = this.getRun(runId);
    if (current.generation !== generation) {
      throw new DomainError(
        "recovery_generation_fenced",
        "The run generation is no longer authoritative",
        409,
      );
    }
    if (current.desiredState === "stopped") return current;
    const { result, event } = this.#transaction(() => {
      const updated = this.#database
        .prepare(
          `UPDATE runs
           SET desired_state = 'stopped', recovery_phase = 'idle', recovery_not_before = NULL,
               recovery_reason = ?
           WHERE id = ? AND generation = ? AND desired_state = 'running'`,
        )
        .run(reason, runId, generation);
      if (Number(updated.changes) !== 1) {
        throw new DomainError(
          "recovery_generation_fenced",
          "The run generation is no longer authoritative",
          409,
        );
      }
      const run = this.getRun(runId);
      return {
        result: run,
        event: this.#appendEvent("run.desired-state-changed", "run", runId, {
          run,
          previousDesiredState: current.desiredState,
          reason,
        }),
      };
    });
    this.#publish(event);
    return result;
  }

  public submitMessage(
    groupId: string,
    command: SubmitMessageCommand,
    idempotencyKey?: string,
  ): MessageSubmissionResult {
    const input = SubmitMessageCommandSchema.parse(command);
    const scope = `group.${groupId}.message.submit`;
    return this.#executeIdempotent(scope, idempotencyKey, MessageSubmissionResultSchema, () => {
      const group = this.#requireGroup(groupId);
      this.#validateSender(groupId, input.sender);
      const recipients = this.#resolveRecipients(group, input);
      if (recipients.length === 0) {
        throw new DomainError("empty_audience", "The message has no eligible recipients", 409);
      }

      this.#database
        .prepare("UPDATE groups SET message_sequence = message_sequence + 1 WHERE id = ?")
        .run(groupId);
      const sequenceRow = this.#database
        .prepare("SELECT message_sequence AS next_seq FROM groups WHERE id = ?")
        .get(groupId) as unknown as { next_seq: number };
      const timestamp = new Date().toISOString();
      const messageId = `msg_${randomUUID()}`;
      const message = MessageSchema.parse({
        ...input,
        id: messageId,
        groupId,
        groupSeq: sequenceRow.next_seq,
        conversationId: input.conversationId ?? `conv_${randomUUID()}`,
        createdAt: timestamp,
      });

      this.#database
        .prepare(
          `INSERT INTO messages
             (id, group_id, group_seq, conversation_id, intent, sender_json, audience_json,
              body_json, delivery_json, reply_to, root_id, causation_id, hop, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.groupId,
          message.groupSeq,
          message.conversationId,
          message.intent,
          JSON.stringify(message.sender),
          JSON.stringify(message.audience),
          JSON.stringify(message.body),
          JSON.stringify(message.delivery),
          message.replyTo ?? null,
          message.rootId ?? null,
          message.causationId ?? null,
          message.hop,
          message.createdAt,
        );

      const deliveryOutcomes = recipients.map((recipientMemberId) => {
        const outcome = this.#resolveDelivery(message, recipientMemberId, timestamp);
        this.#insertDelivery(outcome);
        return outcome;
      });
      this.#pruneGroupMessages(groupId, this.#messageRetentionPerGroup, timestamp);
      const result = MessageSubmissionResultSchema.parse({ message, deliveryOutcomes });
      return {
        result,
        event: this.#appendEvent("message.submitted", "message", message.id, {
          groupId,
          groupSeq: message.groupSeq,
          state: this.getGroupMessageState(groupId),
        }),
      };
    });
  }

  public getGroupMessageState(groupId: string): GroupMessageState {
    this.#requireGroup(groupId);
    const row = this.#database
      .prepare(
        `SELECT g.message_sequence AS latest_group_seq,
                COUNT(DISTINCT m.id) AS retained_message_count,
                MIN(m.group_seq) AS oldest_retained_group_seq,
                COUNT(DISTINCT CASE WHEN d.status IN ('queued','received','delivering','retrying')
                  THEN d.message_id || ':' || d.recipient_member_id END) AS active_delivery_count
         FROM groups g
         LEFT JOIN messages m ON m.group_id = g.id
         LEFT JOIN deliveries d ON d.message_id = m.id
         WHERE g.id = ? GROUP BY g.id`,
      )
      .get(groupId) as unknown as {
      latest_group_seq: number;
      retained_message_count: number;
      oldest_retained_group_seq: number | null;
      active_delivery_count: number;
    };
    const failedRows = this.#database
      .prepare(
        `SELECT DISTINCT d.recipient_member_id
         FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE m.group_id = ? AND d.status IN ('failed','dead-letter','rejected')
         ORDER BY d.recipient_member_id`,
      )
      .all(groupId) as Array<{ recipient_member_id: string }>;
    return GroupMessageStateSchema.parse({
      groupId,
      latestGroupSeq: row.latest_group_seq,
      ...(row.oldest_retained_group_seq === null
        ? {}
        : { oldestRetainedGroupSeq: row.oldest_retained_group_seq }),
      retainedMessageCount: row.retained_message_count,
      activeDeliveryCount: row.active_delivery_count,
      failedRecipientMemberIds: failedRows.map((failed) => failed.recipient_member_id),
    });
  }

  public listMessagePage(
    groupId: string,
    options: { limit?: number; before?: number; after?: number } = {},
  ): MessagePage {
    this.#requireGroup(groupId);
    const limit = options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE_SIZE) {
      throw new DomainError(
        "invalid_message_limit",
        `Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_SIZE}`,
        400,
      );
    }
    if (options.before !== undefined && options.after !== undefined) {
      throw new DomainError(
        "invalid_message_cursor",
        "before and after message cursors are mutually exclusive",
        400,
      );
    }
    const cursor = options.before ?? options.after;
    if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 1)) {
      throw new DomainError("invalid_message_cursor", "Message cursor must be positive", 400);
    }
    const direction = options.after === undefined ? "DESC" : "ASC";
    const comparison =
      options.before !== undefined
        ? "AND group_seq < ?"
        : options.after !== undefined
          ? "AND group_seq > ?"
          : "";
    const parameters = cursor === undefined ? [groupId, limit + 1] : [groupId, cursor, limit + 1];
    const rows = this.#database
      .prepare(
        `SELECT * FROM messages WHERE group_id = ? ${comparison}
         ORDER BY group_seq ${direction} LIMIT ?`,
      )
      .all(...parameters) as unknown as MessageRow[];
    const hasExtra = rows.length > limit;
    const selected = rows.slice(0, limit);
    if (direction === "DESC") selected.reverse();
    const messages = selected.map((row) => this.#hydrateMessage(row));
    const messageIds = new Set(messages.map((message) => message.id));
    const deliveryOutcomes = this.listDeliveries().filter((delivery) =>
      messageIds.has(delivery.messageId),
    );
    const first = messages[0]?.groupSeq;
    const last = messages.at(-1)?.groupSeq;
    const state = this.getGroupMessageState(groupId);
    const hasOlder =
      first !== undefined &&
      state.oldestRetainedGroupSeq !== undefined &&
      first > state.oldestRetainedGroupSeq;
    const hasNewer = last !== undefined && last < state.latestGroupSeq;
    return MessagePageSchema.parse({
      groupId,
      messages,
      deliveryOutcomes,
      state,
      pageInfo: {
        hasOlder: options.after === undefined ? hasExtra || hasOlder : hasOlder,
        hasNewer: options.after === undefined ? hasNewer : hasExtra || hasNewer,
        ...(hasOlder && first !== undefined ? { nextBefore: first } : {}),
        ...(hasNewer && last !== undefined ? { nextAfter: last } : {}),
      },
    });
  }

  public clearMessageHistory(groupId: string, idempotencyKey?: string): ClearMessageHistoryResult {
    return this.#executeIdempotent(
      `group.${groupId}.messages.clear`,
      idempotencyKey,
      ClearMessageHistoryResultSchema,
      () => {
        this.#requireGroup(groupId);
        const now = new Date().toISOString();
        this.#assertMessagesDeletable(groupId, undefined, now, "message_history_busy");
        const messageIds = this.#database
          .prepare("SELECT id FROM messages WHERE group_id = ?")
          .all(groupId) as Array<{ id: string }>;
        const ids = messageIds.map((row) => row.id);
        this.#nullMessageReferences(ids);
        this.#invalidateMessageIdempotency(groupId, ids, now);
        const deletedDeliveries = this.#database
          .prepare(
            "DELETE FROM deliveries WHERE message_id IN (SELECT id FROM messages WHERE group_id = ?)",
          )
          .run(groupId);
        const deletedMessages = this.#database
          .prepare("DELETE FROM messages WHERE group_id = ?")
          .run(groupId);
        const result = ClearMessageHistoryResultSchema.parse({
          groupId,
          deletedMessages: Number(deletedMessages.changes),
          deletedDeliveries: Number(deletedDeliveries.changes),
          state: this.getGroupMessageState(groupId),
        });
        return {
          result,
          event: this.#appendEvent("message.history-cleared", "group", groupId, result),
        };
      },
    );
  }

  #pruneGroupMessages(groupId: string, retain: number, now: string): void {
    const victims = this.#database
      .prepare(
        "SELECT id FROM messages WHERE group_id = ? ORDER BY group_seq DESC LIMIT -1 OFFSET ?",
      )
      .all(groupId, retain) as Array<{ id: string }>;
    if (victims.length === 0) return;
    const victimIds = victims.map((victim) => victim.id);
    this.#assertMessagesDeletable(groupId, victimIds, now, "message_retention_busy");
    this.#nullMessageReferences(victimIds);
    this.#invalidateMessageIdempotency(groupId, victimIds, now);
    for (const messageId of victimIds) {
      this.#database.prepare("DELETE FROM deliveries WHERE message_id = ?").run(messageId);
      this.#database.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    }
  }

  #assertMessagesDeletable(
    groupId: string,
    messageIds: string[] | undefined,
    now: string,
    code: string,
  ): void {
    const placeholders = messageIds?.map(() => "?").join(",");
    const filter =
      messageIds === undefined ? "m.group_id = ?" : `m.group_id = ? AND m.id IN (${placeholders})`;
    const busy = this.#database
      .prepare(
        `SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE ${filter} AND d.status IN ('received','delivering')
           AND d.lease_expires_at IS NOT NULL AND d.lease_expires_at > ? LIMIT 1`,
      )
      .get(groupId, ...(messageIds ?? []), now);
    if (busy !== undefined) {
      throw new DomainError(
        code,
        "Message history has an active delivery; retry after it finishes",
        409,
      );
    }
  }

  #nullMessageReferences(messageIds: string[]): void {
    for (const messageId of messageIds) {
      for (const column of ["reply_to", "root_id", "causation_id"] as const) {
        this.#database
          .prepare(`UPDATE messages SET ${column} = NULL WHERE ${column} = ?`)
          .run(messageId);
      }
    }
  }

  #invalidateMessageIdempotency(groupId: string, messageIds: string[], now: string): void {
    for (const messageId of messageIds) {
      this.#database
        .prepare(
          `UPDATE idempotency_keys SET response_json = 'null', invalidated_at = ?
           WHERE scope = ? AND json_extract(response_json, '$.message.id') = ?`,
        )
        .run(now, `group.${groupId}.message.submit`, messageId);
    }
  }

  public listDeliveries(messageId?: string): DeliveryOutcome[] {
    const rows = (messageId === undefined
      ? this.#database.prepare("SELECT * FROM deliveries ORDER BY updated_at, message_id").all()
      : this.#database
          .prepare("SELECT * FROM deliveries WHERE message_id = ? ORDER BY recipient_member_id")
          .all(messageId)) as unknown as DeliveryRow[];
    return rows.map((row) => this.#hydrateDelivery(row));
  }

  public claimDeliveries(options: ClaimDeliveriesOptions): DeliveryClaim[] {
    const now = options.now.toISOString();
    const leaseExpiresAt = new Date(options.now.getTime() + options.leaseMs).toISOString();
    return this.#transaction(() => {
      const rows = this.#database
        .prepare(
          `SELECT d.* FROM deliveries d
           JOIN messages m ON m.id = d.message_id
           WHERE d.status IN ('queued', 'retrying', 'received', 'delivering')
             AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
             AND (d.lease_expires_at IS NULL OR d.lease_expires_at <= ?)
             AND EXISTS (
               SELECT 1 FROM memberships ms
               WHERE ms.group_id = m.group_id
                 AND ms.member_id = d.recipient_member_id
                 AND ms.state = 'active'
             )
             AND EXISTS (
               SELECT 1 FROM runs r
               WHERE r.group_id = m.group_id
                 AND r.member_id = d.recipient_member_id
                 AND r.status = 'running'
             )
           ORDER BY m.created_at, m.group_seq, d.recipient_member_id
           LIMIT ?`,
        )
        .all(now, now, options.limit) as unknown as DeliveryRow[];

      const claims: DeliveryClaim[] = [];
      for (const row of rows) {
        this.#database
          .prepare(
            `UPDATE deliveries
             SET status = 'received', attempts = attempts + 1, lease_owner = ?,
                 lease_expires_at = ?, next_attempt_at = NULL, updated_at = ?
             WHERE message_id = ? AND recipient_member_id = ?`,
          )
          .run(options.owner, leaseExpiresAt, now, row.message_id, row.recipient_member_id);
        const messageRow = this.#database
          .prepare("SELECT * FROM messages WHERE id = ?")
          .get(row.message_id) as unknown as MessageRow;
        const message = this.#hydrateMessage(messageRow);
        const membership = this.#getMembershipRow(messageRow.group_id, row.recipient_member_id);
        const senderAlias =
          message.sender.kind === "agent"
            ? (this.#getMembershipRow(message.groupId, message.sender.memberId)?.alias ??
              message.sender.memberId)
            : "Human";
        const profile = this.#requireAgentProfile(membership?.agent_profile_id ?? "");
        const run = this.getActiveRun(messageRow.group_id, row.recipient_member_id);
        claims.push({
          delivery: this.#hydrateDelivery({
            ...row,
            status: "received",
            attempts: row.attempts + 1,
            lease_owner: options.owner,
            lease_expires_at: leaseExpiresAt,
            next_attempt_at: null,
            updated_at: now,
          }),
          message,
          senderAlias,
          profile,
          ...(run === undefined ? {} : { run }),
          recipientActive: membership?.state === "active",
        });
      }
      return claims;
    });
  }

  public beginDelivery(claim: DeliveryClaim, owner: string): boolean {
    if (claim.run === undefined) return false;
    const timestamp = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'delivering', reason = ?, run_id = ?, run_generation = ?, updated_at = ?
         WHERE message_id = ? AND recipient_member_id = ? AND status = 'received'
           AND lease_owner = ?
           AND EXISTS (
             SELECT 1 FROM memberships
             WHERE group_id = ? AND member_id = ? AND state = 'active'
           )
           AND EXISTS (
             SELECT 1 FROM runs
             WHERE id = ? AND generation = ? AND status = 'running'
           )`,
      )
      .run(
        null,
        claim.run.id,
        claim.run.generation,
        timestamp,
        claim.message.id,
        claim.delivery.recipientMemberId,
        owner,
        claim.message.groupId,
        claim.delivery.recipientMemberId,
        claim.run.id,
        claim.run.generation,
      );
    return Number(result.changes) === 1;
  }

  public markDeliveryTerminalInjected(claim: DeliveryClaim, owner: string): boolean {
    const timestamp = new Date().toISOString();
    const event = this.#transaction(() => {
      const updated = this.#database
        .prepare(
          `UPDATE deliveries
             SET status = 'terminal_injected', lease_owner = NULL, lease_expires_at = NULL,
               updated_at = ?
           WHERE message_id = ? AND recipient_member_id = ? AND status = 'delivering'
             AND lease_owner = ? AND run_id = ? AND run_generation = ?`,
        )
        .run(
          timestamp,
          claim.message.id,
          claim.delivery.recipientMemberId,
          owner,
          claim.run?.id ?? "",
          claim.run?.generation ?? 0,
        );
      if (Number(updated.changes) !== 1) return undefined;
      return this.#appendEvent("delivery.status-changed", "message", claim.message.id, {
        messageId: claim.message.id,
        recipientMemberId: claim.delivery.recipientMemberId,
        status: "terminal_injected",
      });
    });
    if (event === undefined) return false;
    this.#publish(event);
    return true;
  }

  public failDeliveryAttempt(
    claim: DeliveryClaim,
    owner: string,
    reason: string,
    options: { maxAttempts: number; retryAt: Date },
  ): DeliveryAttemptResult {
    const deadLetter = claim.delivery.attempts >= options.maxAttempts;
    const status = deadLetter ? "dead-letter" : "retrying";
    const nextAttemptAt = deadLetter ? undefined : options.retryAt.toISOString();
    const timestamp = new Date().toISOString();
    const event = this.#transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE deliveries
           SET status = ?, reason = ?, next_attempt_at = ?, lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE message_id = ? AND recipient_member_id = ?
             AND status IN ('received', 'delivering') AND lease_owner = ?`,
        )
        .run(
          status,
          reason,
          nextAttemptAt ?? null,
          timestamp,
          claim.message.id,
          claim.delivery.recipientMemberId,
          owner,
        );
      if (Number(result.changes) !== 1) return undefined;
      return this.#appendEvent("delivery.status-changed", "message", claim.message.id, {
        messageId: claim.message.id,
        recipientMemberId: claim.delivery.recipientMemberId,
        status,
        reason,
        attempts: claim.delivery.attempts,
      });
    });
    if (event === undefined) {
      return { status: "revoked", reason: "delivery_claim_lost" };
    }
    this.#publish(event);
    return { status, reason, ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }) };
  }

  public revokeClaim(claim: DeliveryClaim, owner: string, reason: string): boolean {
    return this.#completeDeliveryStatus(claim, owner, "revoked", reason);
  }

  public rejectClaim(claim: DeliveryClaim, owner: string, reason: string): boolean {
    return this.#completeDeliveryStatus(claim, owner, "rejected", reason);
  }

  #completeDeliveryStatus(
    claim: DeliveryClaim,
    owner: string,
    status: "rejected" | "revoked",
    reason: string,
  ): boolean {
    const timestamp = new Date().toISOString();
    const event = this.#transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE deliveries
           SET status = ?, reason = ?, lease_owner = NULL, lease_expires_at = NULL,
               updated_at = ?
           WHERE message_id = ? AND recipient_member_id = ?
             AND status IN ('received', 'delivering') AND lease_owner = ?`,
        )
        .run(status, reason, timestamp, claim.message.id, claim.delivery.recipientMemberId, owner);
      if (Number(result.changes) !== 1) return undefined;
      return this.#appendEvent("delivery.status-changed", "message", claim.message.id, {
        messageId: claim.message.id,
        recipientMemberId: claim.delivery.recipientMemberId,
        status,
        reason,
        attempts: claim.delivery.attempts,
      });
    });
    if (event === undefined) return false;
    this.#publish(event);
    return true;
  }

  public listEvents(afterSequence = 0): DomainEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT sequence, id, type, aggregate_type, aggregate_id, occurred_at, payload_json
         FROM domain_events WHERE sequence > ? ORDER BY sequence`,
      )
      .all(afterSequence) as unknown as EventRow[];
    return rows.map((row) => this.#hydrateEvent(row));
  }

  public saveTerminalCheckpoint(
    ownerPrincipalId: string,
    checkpoint: Omit<TerminalCheckpoint, "id" | "ownerPrincipalId">,
  ): TerminalCheckpoint {
    if (this.#config?.terminal.checkpoints.enabled !== true) {
      throw new DomainError(
        "terminal_checkpoints_disabled",
        "Terminal checkpoint storage is disabled by configuration",
        409,
      );
    }
    const value = TerminalCheckpointSchema.parse({
      ...checkpoint,
      id: `checkpoint_${randomUUID()}`,
      ownerPrincipalId,
    });
    const run = this.getRun(value.runId);
    if (run.generation !== value.generation) {
      throw new DomainError(
        "terminal_checkpoint_generation_mismatch",
        "Terminal checkpoint generation does not match the run",
        409,
      );
    }
    this.#database
      .prepare(
        `INSERT INTO terminal_checkpoints
           (id, owner_principal_id, run_id, generation, terminal_binding_json, captured_at,
            line_count, byte_count, truncated, sensitivity_policy, storage_reference,
            expires_at, deleted_at, deletion_audit_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        value.id,
        value.ownerPrincipalId,
        value.runId,
        value.generation,
        JSON.stringify(value.terminalBinding),
        value.capturedAt,
        value.lineCount,
        value.byteCount,
        value.truncated ? 1 : 0,
        value.sensitivity,
        value.storageReference,
        value.expiresAt,
      );
    return value;
  }

  public listTerminalCheckpoints(ownerPrincipalId: string): TerminalCheckpoint[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM terminal_checkpoints
         WHERE owner_principal_id = ? AND deleted_at IS NULL
         ORDER BY captured_at DESC, id`,
      )
      .all(ownerPrincipalId) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      TerminalCheckpointSchema.parse({
        id: row.id,
        ownerPrincipalId: row.owner_principal_id,
        runId: row.run_id,
        generation: row.generation,
        terminalBinding: JSON.parse(String(row.terminal_binding_json)),
        capturedAt: row.captured_at,
        lineCount: row.line_count,
        byteCount: row.byte_count,
        truncated: row.truncated === 1,
        sensitivity: row.sensitivity_policy,
        storageReference: row.storage_reference,
        expiresAt: row.expires_at,
      }),
    );
  }

  public deleteTerminalCheckpoint(ownerPrincipalId: string, checkpointId: string): boolean {
    const occurredAt = new Date().toISOString();
    return this.#transaction(() => {
      const checkpoint = this.#database
        .prepare(
          `SELECT id FROM terminal_checkpoints
           WHERE id = ? AND owner_principal_id = ? AND deleted_at IS NULL`,
        )
        .get(checkpointId, ownerPrincipalId);
      if (checkpoint === undefined) return false;
      const auditId = `audit_${randomUUID()}`;
      this.#database
        .prepare(
          `INSERT INTO audits
             (id, principal_id, action, resource_type, resource_id, metadata_json, occurred_at)
           VALUES (?, ?, 'terminal-checkpoint.delete', 'terminal-checkpoint', ?, '{}', ?)`,
        )
        .run(auditId, ownerPrincipalId, checkpointId, occurredAt);
      this.#database
        .prepare(
          `UPDATE terminal_checkpoints
           SET deleted_at = ?, deletion_audit_id = ?
           WHERE id = ? AND owner_principal_id = ?`,
        )
        .run(occurredAt, auditId, checkpointId, ownerPrincipalId);
      return true;
    });
  }

  public recordRuntimeEvent(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): DomainEvent {
    const event = this.#transaction(() =>
      this.#appendEvent(type, aggregateType, aggregateId, payload),
    );
    this.#publish(event);
    return event;
  }

  public getGroupStartAllResult(
    groupId: string,
    idempotencyKey: string | undefined,
  ): StartGroupRunsResult | undefined {
    if (idempotencyKey === undefined) return undefined;
    const existing = this.#database
      .prepare("SELECT response_json FROM idempotency_keys WHERE scope = ? AND key = ?")
      .get(`group.${groupId}.runs.start-all`, idempotencyKey) as
      | { response_json: string }
      | undefined;
    return existing === undefined
      ? undefined
      : StartGroupRunsResultSchema.parse(JSON.parse(existing.response_json));
  }

  public recordGroupStartAllResult(
    result: StartGroupRunsResult,
    idempotencyKey: string | undefined,
  ): StartGroupRunsResult {
    const parsed = StartGroupRunsResultSchema.parse(result);
    const existing = this.getGroupStartAllResult(parsed.groupId, idempotencyKey);
    if (existing !== undefined) return existing;
    const completed = this.#transaction(() => {
      const event = this.#appendEvent("group.runs-started", "group", parsed.groupId, {
        outcomes: parsed.outcomes,
      });
      if (idempotencyKey !== undefined) {
        this.#database
          .prepare(
            `INSERT INTO idempotency_keys (scope, key, response_json, event_sequence, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            `group.${parsed.groupId}.runs.start-all`,
            idempotencyKey,
            JSON.stringify(parsed),
            event.sequence,
            new Date().toISOString(),
          );
      }
      return { result: parsed, event };
    });
    this.#publish(completed.event);
    return completed.result;
  }

  public getSnapshot(): PortalSnapshot {
    const groups = (
      this.#database
        .prepare("SELECT * FROM groups ORDER BY created_at, id")
        .all() as unknown as GroupRow[]
    ).map((row) => this.#hydrateGroup(row));
    const agentProfiles = (
      this.#database
        .prepare(
          `SELECT p.* FROM agent_profiles p
           WHERE EXISTS (
             SELECT 1 FROM memberships m
             WHERE m.agent_profile_id = p.id AND m.state = 'active'
           )
           ORDER BY p.created_at, p.id`,
        )
        .all() as unknown as AgentProfileRow[]
    ).map((row) => this.#hydrateAgentProfile(row));
    const memberships = (
      this.#database
        .prepare("SELECT * FROM memberships WHERE state = 'active' ORDER BY joined_at, id")
        .all() as unknown as MembershipRow[]
    ).map((row) => this.#hydrateMembership(row));
    const configuredOrder = new Map<string, number>();
    let nextConfiguredOrder = 0;
    for (const configuredGroup of Object.values(this.#config?.groups ?? {})) {
      for (const [agentId] of orderedAgentEntries(configuredGroup.agents)) {
        configuredOrder.set(agentId, nextConfiguredOrder);
        nextConfiguredOrder += 1;
      }
    }
    memberships.sort(
      (left, right) =>
        (configuredOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (configuredOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.joinedAt.localeCompare(right.joinedAt) ||
        left.id.localeCompare(right.id),
    );
    const runs = (
      this.#database
        .prepare(
          `SELECT r.* FROM runs r
           WHERE EXISTS (
             SELECT 1 FROM memberships m
             WHERE m.group_id = r.group_id
               AND m.member_id = r.member_id
               AND m.state = 'active'
           )
           ORDER BY r.started_at, r.id`,
        )
        .all() as unknown as RunRow[]
    ).map((row) => this.#hydrateRun(row));
    const messages = (
      this.#database
        .prepare("SELECT * FROM messages ORDER BY created_at, id")
        .all() as unknown as MessageRow[]
    ).map((row) => this.#hydrateMessage(row));
    const deliveryOutcomes = this.listDeliveries();
    const messageGroups = groups.map((group) => this.getGroupMessageState(group.id));
    const agentStatuses = groups.flatMap((group) => this.listAgentStatuses(group.id));
    const sequenceRow = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events")
      .get() as unknown as { sequence: number };

    return PortalSnapshotSchema.parse({
      sequence: sequenceRow.sequence,
      generatedAt: new Date().toISOString(),
      groups,
      agentProfiles,
      memberships,
      runs,
      agentStatuses,
      messages,
      deliveryOutcomes,
      messageGroups,
      ...(this.#config === undefined ? {} : { config: this.#config }),
      ...(this.#configStatus === undefined ? {} : { configStatus: this.#configStatus }),
    });
  }

  #executeIdempotent<T>(
    scope: string,
    idempotencyKey: string | undefined,
    schema: Parser<T>,
    operation: () => CommandResult<T>,
  ): T {
    if (idempotencyKey !== undefined) {
      const existing = this.#database
        .prepare(
          "SELECT response_json, invalidated_at FROM idempotency_keys WHERE scope = ? AND key = ?",
        )
        .get(scope, idempotencyKey) as
        | { response_json: string; invalidated_at: string | null }
        | undefined;
      if (existing !== undefined) {
        if (existing.invalidated_at !== null) {
          throw new DomainError(
            "idempotency_result_expired",
            "The original idempotent result expired with retained message history; use a new key",
            410,
          );
        }
        return schema.parse(JSON.parse(existing.response_json));
      }
    }

    const completed = this.#transaction(() => {
      const commandResult = operation();
      if (idempotencyKey !== undefined) {
        this.#database
          .prepare(
            `INSERT INTO idempotency_keys (scope, key, response_json, event_sequence, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            scope,
            idempotencyKey,
            JSON.stringify(commandResult.result),
            commandResult.event.sequence,
            new Date().toISOString(),
          );
      }
      return commandResult;
    });
    this.#publish(completed.event);
    return completed.result;
  }

  #resolveRecipients(group: Group, command: SubmitMessageCommand): string[] {
    if (command.audience.kind === "group") {
      if (command.audience.membershipRevision !== group.membershipRevision) {
        throw new DomainError(
          "membership_revision_mismatch",
          `Expected membership revision ${group.membershipRevision}`,
          409,
        );
      }
      const rows = this.#database
        .prepare(
          "SELECT member_id FROM memberships WHERE group_id = ? AND state = 'active' ORDER BY member_id",
        )
        .all(group.id) as unknown as { member_id: string }[];
      const senderMemberId = command.sender.kind === "agent" ? command.sender.memberId : undefined;
      return rows.map((row) => row.member_id).filter((memberId) => memberId !== senderMemberId);
    }

    const requested =
      command.audience.kind === "dm" ? [command.audience.memberId] : command.audience.memberIds;
    if (command.sender.kind === "agent" && requested.includes(command.sender.memberId)) {
      throw new DomainError(
        "self_recipient_forbidden",
        "Agents cannot send direct or multicast messages to themselves",
        409,
      );
    }
    for (const memberId of requested) {
      const membership = this.#getMembershipRow(group.id, memberId);
      if (membership === undefined || membership.state !== "active") {
        throw new DomainError(
          "recipient_not_active",
          `Recipient ${memberId} is not an active group member`,
          409,
        );
      }
    }
    return requested;
  }

  #generateMemberId(groupId: string): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const memberId = formatMemberId(this.#memberNameGenerator());
      if (this.#getMembershipRow(groupId, memberId) === undefined) return memberId;
    }
    throw new DomainError(
      "member_id_generation_exhausted",
      "Could not generate a unique member ID",
      503,
    );
  }

  #validateSender(groupId: string, sender: SubmitMessageCommand["sender"]): void {
    if (sender.kind === "operator") {
      return;
    }
    const membership = this.#getMembershipRow(groupId, sender.memberId);
    if (membership === undefined || membership.state !== "active") {
      throw new DomainError("sender_not_active", "Agent sender is not an active member", 403);
    }
    const run = this.#database
      .prepare("SELECT group_id, member_id, status FROM runs WHERE id = ?")
      .get(sender.runId) as { group_id: string; member_id: string; status: string } | undefined;
    if (
      run === undefined ||
      run.group_id !== groupId ||
      run.member_id !== sender.memberId ||
      !["starting", "running"].includes(run.status)
    ) {
      throw new DomainError("invalid_sender_run", "Agent sender run is not active", 403);
    }
  }

  #resolveDelivery(
    message: Message,
    recipientMemberId: string,
    timestamp: string,
  ): DeliveryOutcome {
    const status: DeliveryOutcome["status"] = "queued";
    return DeliveryOutcomeSchema.parse({
      messageId: message.id,
      recipientMemberId,
      status,
      attempts: 0,
      updatedAt: timestamp,
    });
  }

  #insertDelivery(outcome: DeliveryOutcome): void {
    this.#database
      .prepare(
        `INSERT INTO deliveries
           (message_id, recipient_member_id, reason, status, attempts, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcome.messageId,
        outcome.recipientMemberId,
        outcome.reason ?? null,
        outcome.status,
        outcome.attempts,
        outcome.updatedAt,
      );
  }

  #requireCurrentAgentStatusRun(identity: AgentStatusIdentity): AgentRun {
    const run = this.getRun(identity.runId);
    const membership = this.#getMembershipRow(identity.groupId, identity.memberId);
    const active = this.getActiveRun(identity.groupId, identity.memberId);
    if (
      run.groupId !== identity.groupId ||
      run.memberId !== identity.memberId ||
      run.generation !== identity.generation ||
      run.desiredState !== "running" ||
      !["starting", "running"].includes(run.status) ||
      membership?.state !== "active" ||
      active?.id !== run.id ||
      active.generation !== run.generation
    ) {
      throw new DomainError(
        "status_generation_fenced",
        "The agent status generation is no longer authoritative",
        409,
      );
    }
    return run;
  }

  #insertAgentStatusEvent(
    run: AgentRun,
    eventId: string,
    source: string,
    kind: string,
    observedAt: string,
    payload: unknown,
  ): void {
    const sourceOccurredAt =
      typeof payload === "object" &&
      payload !== null &&
      "occurredAt" in payload &&
      typeof payload.occurredAt === "string"
        ? payload.occurredAt
        : null;
    this.#database
      .prepare(
        `INSERT INTO runtime_observations
           (event_id, run_id, generation, source, kind, source_occurred_at,
            observed_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        run.id,
        run.generation,
        source,
        kind,
        sourceOccurredAt,
        observedAt,
        JSON.stringify(payload),
      );
  }

  #trimAgentStatusEvents(runId: string, generation: number): void {
    this.#database
      .prepare(
        `DELETE FROM runtime_observations
         WHERE run_id = ? AND generation = ? AND sequence NOT IN (
           SELECT sequence FROM runtime_observations
           WHERE run_id = ? AND generation = ?
           ORDER BY sequence DESC LIMIT 256
         )`,
      )
      .run(runId, generation, runId, generation);
  }

  #appendAgentStatusDomainEvents(
    run: AgentRun,
    previous: AgentStatusReducerState,
    next: AgentStatusReducerState,
  ): DomainEvent[] {
    const material =
      previous.state !== next.state ||
      previous.phase !== next.phase ||
      previous.attention !== next.attention ||
      previous.outcome !== next.outcome ||
      previous.lastProgressSummary !== next.lastProgressSummary ||
      previous.blocker !== next.blocker;
    if (!material) return [];
    const status = agentStatusSummary(this.#getAgentStatusDetail(run.groupId, run.memberId));
    const events = [this.#appendEvent("agent-status.changed", "run", run.id, { status })];
    if (
      previous.attention !== next.attention &&
      ["input_required", "decision_required", "progress_stale", "process_failed"].includes(
        next.attention,
      )
    ) {
      events.push(this.#appendEvent("agent-status.attention-required", "run", run.id, { status }));
    }
    return events;
  }

  #agentStatusState(run: AgentRun): AgentStatusReducerState {
    const row = this.#database
      .prepare("SELECT reducer_state_json FROM status_revisions WHERE run_id = ?")
      .get(run.id) as unknown as AgentStatusCurrentRow | undefined;
    return row === undefined
      ? createAgentStatusReducerState(run.id, run.generation, run.startedAt)
      : (JSON.parse(row.reducer_state_json) as AgentStatusReducerState);
  }

  #upsertAgentStatusState(run: AgentRun, state: AgentStatusReducerState): void {
    const serialized = JSON.stringify(state);
    this.#database
      .prepare(
        `INSERT INTO status_revisions
           (run_id, generation, status_revision, completion_revision, status_json, reducer_state_json, updated_at)
         VALUES (?, ?, 0, 0, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           generation = excluded.generation,
           status_revision = status_revisions.status_revision + 1,
           status_json = excluded.status_json,
           reducer_state_json = excluded.reducer_state_json,
           updated_at = excluded.updated_at`,
      )
      .run(run.id, run.generation, serialized, serialized, state.observedAt);
  }

  #getAgentStatusDetail(groupId: string, memberId: string): AgentStatusDetail {
    const membership = this.#getMembershipRow(groupId, memberId);
    if (membership === undefined || membership.state !== "active") {
      throw new DomainError("membership_not_active", "The member is not active", 404);
    }
    const hydratedMembership = this.#hydrateMembership(membership);
    const role =
      hydratedMembership.roleId === undefined
        ? undefined
        : this.#config?.roles[hydratedMembership.roleId];
    const profile = this.#requireAgentProfile(membership.agent_profile_id);
    const run = this.getLatestRunForMembership(groupId, memberId);
    if (run === undefined) {
      return AgentStatusDetailSchema.parse({
        groupId,
        memberId,
        alias: hydratedMembership.alias,
        agentType: profile.agentType,
        roleId: hydratedMembership.roleId,
        roleName: role?.name,
        state: "not_started",
        phase: "startup",
        outcome: "unknown",
        confidence: "high",
        attention: "none",
        observedAt: hydratedMembership.joinedAt,
        stateChangedAt: hydratedMembership.joinedAt,
        cleanEndSeen: false,
        evidence: [
          {
            source: "scheduler",
            kind: "membership.active",
            observedAt: hydratedMembership.joinedAt,
            confidence: "high",
          },
        ],
        recentTransitions: [],
      });
    }
    const state = this.#agentStatusState(run);
    const persistedState = state.state === "idle" ? "waiting" : state.state;
    const statusState =
      run.status === "stopped" && !["stopped", "crashed"].includes(persistedState)
        ? "stopped"
        : run.status === "failed" && !["stopped", "crashed"].includes(persistedState)
          ? "crashed"
          : persistedState;
    return AgentStatusDetailSchema.parse({
      groupId,
      memberId,
      alias: hydratedMembership.alias,
      agentType: profile.agentType,
      roleId: hydratedMembership.roleId,
      roleName: role?.name,
      runId: run.id,
      generation: run.generation,
      runStatus: run.status,
      state: statusState,
      phase: statusState === "stopped" || statusState === "crashed" ? "exited" : state.phase,
      outcome: statusState === "crashed" && state.outcome === "unknown" ? "failed" : state.outcome,
      confidence: state.confidence,
      attention: statusState === "crashed" ? "process_failed" : state.attention,
      lastActivityAt: state.lastActivityAt,
      lastActivityKind: state.lastActivityKind,
      observedAt: state.observedAt,
      stateChangedAt: state.stateChangedAt,
      lastProgressSummary: state.lastProgressSummary,
      progressStage: state.progressStage,
      nextStep: state.nextStep,
      blocker: state.blocker,
      semanticLeaseExpiresAt: state.semanticLeaseExpiresAt,
      transportLeaseExpiresAt: state.transportLeaseExpiresAt,
      openWait: state.openWaits[0],
      processExitCode: state.processExitCode,
      processSignal: state.processSignal,
      cleanEndSeen: state.cleanEndSeen,
      evidence: state.evidence,
      recentTransitions: state.recentTransitions,
    });
  }

  #appendEvent(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): DomainEvent {
    const id = `evt_${randomUUID()}`;
    const occurredAt = new Date().toISOString();
    const insert = this.#database
      .prepare(
        `INSERT INTO domain_events
           (id, type, aggregate_type, aggregate_id, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, type, aggregateType, aggregateId, occurredAt, JSON.stringify(payload));
    return DomainEventSchema.parse({
      sequence: Number(insert.lastInsertRowid),
      id,
      type,
      aggregateType,
      aggregateId,
      occurredAt,
      payload,
    });
  }

  #publish(event: DomainEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  #incrementMembershipRevision(groupId: string, timestamp: string): number {
    this.#database
      .prepare(
        `UPDATE groups
         SET membership_revision = membership_revision + 1, updated_at = ? WHERE id = ?`,
      )
      .run(timestamp, groupId);
    return this.#requireGroup(groupId).membershipRevision;
  }

  #requireGroup(groupId: string): Group {
    const row = this.#database
      .prepare("SELECT * FROM groups WHERE id = ?")
      .get(groupId) as unknown as GroupRow | undefined;
    if (row === undefined) {
      throw new DomainError("group_not_found", "Group not found", 404);
    }
    return this.#hydrateGroup(row);
  }

  #requireAgentProfile(profileId: string): AgentProfile {
    const row = this.#database
      .prepare("SELECT * FROM agent_profiles WHERE id = ?")
      .get(profileId) as unknown as AgentProfileRow | undefined;
    if (row === undefined) {
      throw new DomainError("agent_profile_not_found", "Agent profile not found", 404);
    }
    return this.#hydrateAgentProfile(row);
  }

  #getMembershipRow(groupId: string, memberId: string): MembershipRow | undefined {
    return this.#database
      .prepare("SELECT * FROM memberships WHERE group_id = ? AND member_id = ?")
      .get(groupId, memberId) as unknown as MembershipRow | undefined;
  }

  #hydrateGroup(row: GroupRow): Group {
    return GroupSchema.parse({
      id: row.id,
      name: row.name,
      membershipRevision: row.membership_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #hydrateAgentProfile(row: AgentProfileRow): AgentProfile {
    return AgentProfileSchema.parse({
      id: row.id,
      name: row.name,
      agentType: row.agent_type,
      kind: row.kind,
      command: row.command,
      args: JSON.parse(row.args_json),
      workingDirectory: row.working_directory ?? undefined,
      environment: JSON.parse(row.environment_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #hydrateMembership(row: MembershipRow): GroupMembership {
    return GroupMembershipSchema.parse({
      id: row.id,
      groupId: row.group_id,
      memberId: row.member_id,
      agentProfileId: row.agent_profile_id,
      alias: row.alias,
      roleId: row.role_id ?? undefined,
      state: row.state,
      joinedAt: row.joined_at,
      removedAt: row.removed_at ?? undefined,
    });
  }

  #hydrateRun(row: RunRow): AgentRun {
    return AgentRunSchema.parse({
      id: row.id,
      groupId: row.group_id,
      memberId: row.member_id,
      agentProfileId: row.agent_profile_id,
      generation: row.generation,
      status: row.status,
      desiredState: row.desired_state ?? (row.status === "stopped" ? "stopped" : "running"),
      recoveryPhase: row.recovery_phase ?? "idle",
      recoveryAttempts: row.recovery_attempts ?? 0,
      recoveryNotBefore: row.recovery_not_before ?? undefined,
      recoveryReason: row.recovery_reason ?? undefined,
      terminal: row.terminal_json === null ? undefined : JSON.parse(row.terminal_json),
      startedAt: row.started_at,
      stoppedAt: row.stopped_at ?? undefined,
    });
  }

  #hydrateMessage(row: MessageRow): Message {
    return MessageSchema.parse({
      id: row.id,
      groupId: row.group_id,
      groupSeq: row.group_seq,
      conversationId: row.conversation_id,
      intent: row.intent,
      sender: JSON.parse(row.sender_json),
      audience: JSON.parse(row.audience_json),
      body: JSON.parse(row.body_json),
      delivery: JSON.parse(row.delivery_json),
      replyTo: row.reply_to ?? undefined,
      rootId: row.root_id ?? undefined,
      causationId: row.causation_id ?? undefined,
      hop: row.hop,
      createdAt: row.created_at,
    });
  }

  #hydrateDelivery(row: DeliveryRow): DeliveryOutcome {
    return DeliveryOutcomeSchema.parse({
      messageId: row.message_id,
      recipientMemberId: row.recipient_member_id,
      reason: row.reason ?? undefined,
      status: row.status,
      attempts: row.attempts,
      updatedAt: row.updated_at,
    });
  }

  #hydrateEvent(row: EventRow): DomainEvent {
    return DomainEventSchema.parse({
      sequence: row.sequence,
      id: row.id,
      type: row.type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json),
    });
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
