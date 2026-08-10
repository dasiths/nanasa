import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AddGroupMembershipCommand,
  AddGroupMembershipCommandSchema,
  type AgentProfile,
  AgentProfileSchema,
  type AgentRun,
  AgentRunSchema,
  type AgentTypeConfig,
  type ConfigStatus,
  type CreateAgentProfileCommand,
  CreateAgentProfileCommandSchema,
  type CreateGroupCommand,
  CreateGroupCommandSchema,
  type DeliveryMode,
  type DeliveryOutcome,
  DeliveryOutcomeSchema,
  type DeliveryStatus,
  type DomainEvent,
  DomainEventSchema,
  type Group,
  type GroupMembership,
  GroupMembershipSchema,
  GroupSchema,
  type InternalCreateAgentProfileCommand,
  InternalCreateAgentProfileCommandSchema,
  type Message,
  MessageSchema,
  type MessageSubmissionResult,
  MessageSubmissionResultSchema,
  type NanasaConfig,
  type PortalSnapshot,
  PortalSnapshotSchema,
  type RecoveryPhase,
  type RecoveryPolicy,
  type RunStatus,
  type StartGroupRunsResult,
  StartGroupRunsResultSchema,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
  type TerminalBinding,
} from "@nanasa/contracts";

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
  adapter: string | null;
  capabilities_json: string | null;
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
  adapter_session_id: string | null;
  adapter_session_json: string | null;
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
  requested_mode: string;
  applied_mode: string | null;
  fallback_applied: number;
  reason: string | null;
  status: string;
  attempts: number;
  adapter: string | null;
  adapter_session_id: string | null;
  adapter_message_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  run_id: string | null;
  run_generation: number | null;
  updated_at: string;
}

export interface DeliveryClaim {
  delivery: DeliveryOutcome;
  message: Message;
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

export class NanasaStore {
  readonly #database: DatabaseSync;
  readonly #listeners = new Set<DomainEventListener>();
  readonly #config: NanasaConfig | undefined;
  readonly #configStatus: ConfigStatus | undefined;

  public constructor(path: string, options: NanasaStoreOptions = {}) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.#database = new DatabaseSync(path);
    this.#config = options.config;
    this.#configStatus = options.configStatus;
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  public close(): void {
    this.#database.close();
  }

  public onEvent(listener: DomainEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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

  public createAgentProfile(
    command: CreateAgentProfileCommand,
    idempotencyKey?: string,
  ): AgentProfile {
    const input = CreateAgentProfileCommandSchema.parse(command);
    const agentType = this.#requireConfiguredAgentType(input.agentType);
    return this.#createAgentProfile(
      {
        name: input.name,
        agentType: agentType.key,
        kind: agentType.kind,
        adapter: agentType.adapter,
        capabilities: agentType.capabilities,
        command: agentType.command[0] as string,
        args: agentType.command.slice(1),
        workingDirectory: agentType.cwd,
        environment: agentType.environment,
      },
      idempotencyKey,
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
              (id, name, agent_type, kind, adapter, capabilities_json, command, args_json,
               working_directory, environment_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            profile.id,
            profile.name,
            profile.agentType,
            profile.kind,
            profile.adapter,
            JSON.stringify(profile.capabilities),
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
    command: AddGroupMembershipCommand,
    idempotencyKey?: string,
  ): GroupMembership {
    const input = AddGroupMembershipCommandSchema.parse(command);
    const scope = `group.${groupId}.membership.add`;
    return this.#executeIdempotent(scope, idempotencyKey, GroupMembershipSchema, () => {
      this.#requireGroup(groupId);
      this.#requireAgentProfile(input.agentProfileId);
      const memberId = input.memberId ?? `member_${randomUUID()}`;
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
        state: "active",
        joinedAt: timestamp,
      });

      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO memberships
               (id, group_id, member_id, agent_profile_id, alias, state, joined_at, removed_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`,
          )
          .run(
            membership.id,
            membership.groupId,
            membership.memberId,
            membership.agentProfileId,
            membership.alias,
            membership.joinedAt,
          );
      } else {
        this.#database
          .prepare(
            `UPDATE memberships
             SET agent_profile_id = ?, alias = ?, state = 'active', joined_at = ?, removed_at = NULL
             WHERE id = ?`,
          )
          .run(membership.agentProfileId, membership.alias, membership.joinedAt, membership.id);
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
            recovery_reason, adapter_session_id, adapter_session_json, terminal_json,
            started_at, stopped_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.adapterSessionId ?? null,
          input.adapterSession === undefined ? null : JSON.stringify(input.adapterSession),
          input.terminal === undefined ? null : JSON.stringify(input.terminal),
          input.startedAt,
          input.stoppedAt ?? null,
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
      preserveAdapterSession?: boolean;
    } = {},
  ): {
    run: AgentRun;
    profile: AgentProfile;
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
      recoveryPhase:
        options.recoveryFrom === undefined
          ? "idle"
          : options.preserveAdapterSession === true
            ? "resuming"
            : "restarting",
      recoveryAttempts: options.recoveryFrom?.recoveryAttempts ?? 0,
      recoveryNotBefore: options.recoveryFrom?.recoveryNotBefore,
      recoveryReason: options.recoveryFrom?.recoveryReason,
      adapterSessionId:
        options.preserveAdapterSession === true
          ? options.recoveryFrom?.adapterSessionId
          : undefined,
      adapterSession:
        options.preserveAdapterSession === true ? options.recoveryFrom?.adapterSession : undefined,
      startedAt: new Date().toISOString(),
    });
    return { run, profile: this.#requireAgentProfile(membership.agent_profile_id) };
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

  public getRecoveryPolicy(profileId: string): RecoveryPolicy {
    const profile = this.#requireAgentProfile(profileId);
    return (
      this.#config?.agentTypes[profile.agentType]?.recovery ??
      (profile.adapter === "terminal" ? "restart" : "resume-or-restart")
    );
  }

  public getActiveDeliveryTarget(
    groupId: string,
    memberId: string,
  ): { run: AgentRun; profile: AgentProfile } | undefined {
    const membership = this.#getMembershipRow(groupId, memberId);
    if (membership === undefined || membership.state !== "active") return undefined;
    const run = this.getActiveRun(groupId, memberId);
    if (run === undefined || run.status !== "running") return undefined;
    return { run, profile: this.#requireAgentProfile(membership.agent_profile_id) };
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
    return result;
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

  public updateRunAdapterSession(
    runId: string,
    generation: number,
    session: {
      adapterSessionId: string;
      adapter?: "copilot-cli" | "pi-rpc";
      sessionFile?: string;
    },
  ): AgentRun {
    const current = this.getRun(runId);
    if (current.generation !== generation || current.status !== "running") {
      throw new DomainError(
        "adapter_generation_unavailable",
        "The adapter run generation is unavailable",
        409,
      );
    }
    const metadata = {
      adapter: session.adapter ?? ("pi-rpc" as const),
      sessionId: session.adapterSessionId,
      ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
      updatedAt: new Date().toISOString(),
    };
    const { result, event } = this.#transaction(() => {
      const updated = this.#database
        .prepare(
          `UPDATE runs SET adapter_session_id = ?, adapter_session_json = ?
           WHERE id = ? AND generation = ? AND status = 'running'`,
        )
        .run(session.adapterSessionId, JSON.stringify(metadata), runId, generation);
      if (Number(updated.changes) !== 1) {
        throw new DomainError(
          "adapter_generation_unavailable",
          "The adapter run generation is unavailable",
          409,
        );
      }
      const run = this.getRun(runId);
      return {
        result: run,
        event: this.#appendEvent("run.adapter-session-changed", "run", runId, {
          generation,
          adapterSession: metadata,
        }),
      };
    });
    this.#publish(event);
    return result;
  }

  public settleRunDeliveries(
    runId: string,
    generation: number,
    adapterMessageIds: readonly string[],
    settlement: { status: "processed" | "failed"; reason?: string } = {
      status: "processed",
    },
  ): number {
    if (adapterMessageIds.length === 0) return 0;
    const timestamp = new Date().toISOString();
    let changed = 0;
    const events: DomainEvent[] = [];
    this.#transaction(() => {
      for (const adapterMessageId of new Set(adapterMessageIds)) {
        const result = this.#database
          .prepare(
            `UPDATE deliveries SET status = ?, reason = ?, updated_at = ?
             WHERE run_id = ? AND run_generation = ? AND adapter_message_id = ?
               AND status = 'consumed'`,
          )
          .run(
            settlement.status,
            settlement.reason ?? null,
            timestamp,
            runId,
            generation,
            adapterMessageId,
          );
        changed += Number(result.changes);
      }
      if (changed > 0) {
        events.push(
          this.#appendEvent("delivery.adapter-settled", "run", runId, {
            generation,
            adapterMessageIds,
            settlement,
            changed,
          }),
        );
      }
    });
    for (const event of events) this.#publish(event);
    return changed;
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

      const sequenceRow = this.#database
        .prepare(
          "SELECT COALESCE(MAX(group_seq), 0) + 1 AS next_seq FROM messages WHERE group_id = ?",
        )
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
      const result = MessageSubmissionResultSchema.parse({ message, deliveryOutcomes });
      return {
        result,
        event: this.#appendEvent("message.submitted", "message", message.id, {
          message,
          deliveryOutcomes,
        }),
      };
    });
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
        const membership = this.#getMembershipRow(messageRow.group_id, row.recipient_member_id);
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
          message: this.#hydrateMessage(messageRow),
          profile,
          ...(run === undefined ? {} : { run }),
          recipientActive: membership?.state === "active",
        });
      }
      return claims;
    });
  }

  public beginDelivery(
    claim: DeliveryClaim,
    owner: string,
    appliedMode: DeliveryMode,
    fallbackApplied: boolean,
  ): boolean {
    if (claim.run === undefined) return false;
    const timestamp = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'delivering', applied_mode = ?, fallback_applied = ?,
             reason = ?, adapter = ?, run_id = ?, run_generation = ?, updated_at = ?
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
        appliedMode,
        fallbackApplied ? 1 : 0,
        fallbackApplied ? "requested_mode_not_supported" : null,
        appliedMode === "terminal" ? "terminal" : claim.profile.adapter,
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

  public markDeliveryConsumed(
    claim: DeliveryClaim,
    owner: string,
    result: {
      adapterSessionId?: string;
      adapterMessageId?: string;
    },
  ): boolean {
    const timestamp = new Date().toISOString();
    const updated = this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'consumed', adapter_session_id = ?, adapter_message_id = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE message_id = ? AND recipient_member_id = ? AND status = 'delivering'
           AND lease_owner = ? AND run_id = ? AND run_generation = ?`,
      )
      .run(
        result.adapterSessionId ?? null,
        result.adapterMessageId ?? null,
        timestamp,
        claim.message.id,
        claim.delivery.recipientMemberId,
        owner,
        claim.run?.id ?? "",
        claim.run?.generation ?? 0,
      );
    return Number(updated.changes) === 1;
  }

  public settleDelivery(
    claim: DeliveryClaim,
    status: "processed" | "failed",
    reason?: string,
  ): boolean {
    const updated = this.#database
      .prepare(
        `UPDATE deliveries SET status = ?, reason = ?, updated_at = ?
         WHERE message_id = ? AND recipient_member_id = ? AND status = 'consumed'
           AND run_id = ? AND run_generation = ?`,
      )
      .run(
        status,
        reason ?? null,
        new Date().toISOString(),
        claim.message.id,
        claim.delivery.recipientMemberId,
        claim.run?.id ?? "",
        claim.run?.generation ?? 0,
      );
    return Number(updated.changes) === 1;
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
        new Date().toISOString(),
        claim.message.id,
        claim.delivery.recipientMemberId,
        owner,
      );
    if (Number(result.changes) !== 1) {
      return { status: "revoked", reason: "delivery_claim_lost" };
    }
    return { status, reason, ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }) };
  }

  public revokeClaim(claim: DeliveryClaim, owner: string, reason: string): boolean {
    const result = this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'revoked', reason = ?, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE message_id = ? AND recipient_member_id = ?
           AND status IN ('received', 'delivering') AND lease_owner = ?`,
      )
      .run(
        reason,
        new Date().toISOString(),
        claim.message.id,
        claim.delivery.recipientMemberId,
        owner,
      );
    return Number(result.changes) === 1;
  }

  public rejectClaim(claim: DeliveryClaim, owner: string, reason: string): boolean {
    const result = this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'rejected', reason = ?, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE message_id = ? AND recipient_member_id = ?
           AND status IN ('received', 'delivering') AND lease_owner = ?`,
      )
      .run(
        reason,
        new Date().toISOString(),
        claim.message.id,
        claim.delivery.recipientMemberId,
        owner,
      );
    return Number(result.changes) === 1;
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
        .prepare("SELECT * FROM agent_profiles ORDER BY created_at, id")
        .all() as unknown as AgentProfileRow[]
    ).map((row) => this.#hydrateAgentProfile(row));
    const memberships = (
      this.#database
        .prepare("SELECT * FROM memberships ORDER BY joined_at, id")
        .all() as unknown as MembershipRow[]
    ).map((row) => this.#hydrateMembership(row));
    const runs = (
      this.#database
        .prepare("SELECT * FROM runs ORDER BY started_at, id")
        .all() as unknown as RunRow[]
    ).map((row) => this.#hydrateRun(row));
    const messages = (
      this.#database
        .prepare("SELECT * FROM messages ORDER BY created_at, id")
        .all() as unknown as MessageRow[]
    ).map((row) => this.#hydrateMessage(row));
    const deliveryOutcomes = this.listDeliveries();
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
      messages,
      deliveryOutcomes,
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
        .prepare("SELECT response_json FROM idempotency_keys WHERE scope = ? AND key = ?")
        .get(scope, idempotencyKey) as { response_json: string } | undefined;
      if (existing !== undefined) {
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
    const requestedMode = message.delivery.mode;
    let appliedMode: DeliveryMode | undefined;
    let fallbackApplied = false;
    let reason: string | undefined;
    const status: DeliveryOutcome["status"] = "queued";

    const membership = this.#getMembershipRow(message.groupId, recipientMemberId);
    const profile = this.#requireAgentProfile(membership?.agent_profile_id ?? "");
    if (requestedMode === "terminal") {
      appliedMode = "terminal";
    } else if (profile.capabilities.includes(requestedMode)) {
      appliedMode = requestedMode;
    } else {
      appliedMode = "queue";
      fallbackApplied = true;
      reason = "requested_mode_not_supported";
    }

    return DeliveryOutcomeSchema.parse({
      messageId: message.id,
      recipientMemberId,
      requestedMode,
      appliedMode,
      fallbackApplied,
      reason,
      status,
      attempts: 0,
      adapter: requestedMode === "terminal" ? "terminal" : profile.adapter,
      updatedAt: timestamp,
    });
  }

  #insertDelivery(outcome: DeliveryOutcome): void {
    this.#database
      .prepare(
        `INSERT INTO deliveries
           (message_id, recipient_member_id, requested_mode, applied_mode, fallback_applied,
            reason, status, attempts, adapter, adapter_session_id, adapter_message_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcome.messageId,
        outcome.recipientMemberId,
        outcome.requestedMode,
        outcome.appliedMode ?? null,
        outcome.fallbackApplied ? 1 : 0,
        outcome.reason ?? null,
        outcome.status,
        outcome.attempts,
        outcome.adapter ?? null,
        outcome.adapterSessionId ?? null,
        outcome.adapterMessageId ?? null,
        outcome.updatedAt,
      );
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

  #requireConfiguredAgentType(agentTypeKey: string): AgentTypeConfig {
    const agentType = this.#config?.agentTypes[agentTypeKey];
    if (agentType === undefined) {
      throw new DomainError(
        "agent_type_not_configured",
        `Agent type ${agentTypeKey} is not configured`,
        400,
      );
    }
    return agentType;
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
    const agentType = row.agent_type ?? this.#inferAgentType(row.kind, row.command, row.args_json);
    const configured = this.#config?.agentTypes[agentType];
    return AgentProfileSchema.parse({
      id: row.id,
      name: row.name,
      agentType,
      kind: row.kind,
      adapter: row.adapter ?? configured?.adapter ?? this.#inferAdapter(row.kind),
      capabilities:
        row.capabilities_json === null
          ? (configured?.capabilities ?? this.#inferCapabilities(row.kind))
          : JSON.parse(row.capabilities_json),
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
      adapterSessionId: row.adapter_session_id ?? undefined,
      adapterSession:
        row.adapter_session_json === null ? undefined : JSON.parse(row.adapter_session_json),
      terminal: row.terminal_json === null ? undefined : JSON.parse(row.terminal_json),
      startedAt: row.started_at,
      stoppedAt: row.stopped_at ?? undefined,
    });
  }

  #hydrateMessage(row: MessageRow): Message {
    const storedDelivery = JSON.parse(row.delivery_json) as {
      mode?: string;
      expiresAt?: string;
    };
    const mode =
      storedDelivery.mode === "terminal"
        ? "terminal"
        : storedDelivery.mode === "steer" || storedDelivery.mode === "interrupt"
          ? "steer"
          : "queue";
    return MessageSchema.parse({
      id: row.id,
      groupId: row.group_id,
      groupSeq: row.group_seq,
      conversationId: row.conversation_id,
      intent: row.intent,
      sender: JSON.parse(row.sender_json),
      audience: JSON.parse(row.audience_json),
      body: JSON.parse(row.body_json),
      delivery: {
        mode,
        ...(storedDelivery.expiresAt === undefined ? {} : { expiresAt: storedDelivery.expiresAt }),
      },
      replyTo: row.reply_to ?? undefined,
      rootId: row.root_id ?? undefined,
      causationId: row.causation_id ?? undefined,
      hop: row.hop,
      createdAt: row.created_at,
    });
  }

  #hydrateDelivery(row: DeliveryRow): DeliveryOutcome {
    const requestedMode =
      row.requested_mode === "terminal"
        ? "terminal"
        : row.requested_mode === "steer" || row.requested_mode === "interrupt"
          ? "steer"
          : "queue";
    const appliedMode =
      row.applied_mode === null
        ? undefined
        : row.applied_mode === "terminal"
          ? "terminal"
          : row.applied_mode === "steer" || row.applied_mode === "interrupt"
            ? "steer"
            : "queue";
    return DeliveryOutcomeSchema.parse({
      messageId: row.message_id,
      recipientMemberId: row.recipient_member_id,
      requestedMode,
      appliedMode,
      fallbackApplied: row.fallback_applied === 1,
      reason: row.reason ?? undefined,
      status: row.status,
      attempts: row.attempts,
      adapter: row.adapter ?? undefined,
      adapterSessionId: row.adapter_session_id ?? undefined,
      adapterMessageId: row.adapter_message_id ?? undefined,
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

  #inferAgentType(kind: string, command: string, argsJson: string): string {
    if (kind === "claude-code") {
      const args = JSON.parse(argsJson) as unknown[];
      return command === "make" && args[0] === "claude-copilot" ? "claude-copilot" : "claude-code";
    }
    return kind;
  }

  #inferAdapter(kind: string): "copilot-cli" | "pi-rpc" | "terminal" {
    if (kind === "copilot") return "copilot-cli";
    if (kind === "pi") return "pi-rpc";
    return "terminal";
  }

  #inferCapabilities(kind: string): Array<"queue" | "steer"> {
    return kind === "pi" ? ["queue", "steer"] : ["queue"];
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        membership_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        adapter TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        working_directory TEXT,
        environment_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memberships (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(id),
        member_id TEXT NOT NULL,
        agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
        alias TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
        joined_at TEXT NOT NULL,
        removed_at TEXT,
        UNIQUE (group_id, member_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(id),
        member_id TEXT NOT NULL,
        agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        desired_state TEXT NOT NULL,
        recovery_phase TEXT NOT NULL,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        recovery_not_before TEXT,
        recovery_reason TEXT,
        adapter_session_id TEXT,
        adapter_session_json TEXT,
        terminal_json TEXT,
        started_at TEXT NOT NULL,
        stopped_at TEXT,
        UNIQUE (group_id, member_id, generation),
        FOREIGN KEY (group_id, member_id) REFERENCES memberships(group_id, member_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(id),
        group_seq INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,
        intent TEXT NOT NULL,
        sender_json TEXT NOT NULL,
        audience_json TEXT NOT NULL,
        body_json TEXT NOT NULL,
        delivery_json TEXT NOT NULL,
        reply_to TEXT REFERENCES messages(id),
        root_id TEXT REFERENCES messages(id),
        causation_id TEXT REFERENCES messages(id),
        hop INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (group_id, group_seq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS deliveries (
        message_id TEXT NOT NULL REFERENCES messages(id),
        recipient_member_id TEXT NOT NULL,
        requested_mode TEXT NOT NULL,
        applied_mode TEXT,
        fallback_applied INTEGER NOT NULL,
        reason TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        adapter TEXT,
        adapter_session_id TEXT,
        adapter_message_id TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        next_attempt_at TEXT,
        run_id TEXT,
        run_generation INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, recipient_member_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS domain_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        response_json TEXT NOT NULL,
        event_sequence INTEGER NOT NULL REFERENCES domain_events(sequence),
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS deliveries_recipient_status
        ON deliveries (recipient_member_id, status);
      CREATE INDEX IF NOT EXISTS events_aggregate
        ON domain_events (aggregate_type, aggregate_id, sequence);
    `);
    this.#migrateLegacyColumns();
  }

  #migrateLegacyColumns(): void {
    const columns = (table: string) =>
      new Set(
        (
          this.#database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
    const addColumn = (table: string, name: string, definition: string) => {
      if (!columns(table).has(name)) {
        this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };

    addColumn("agent_profiles", "agent_type", "TEXT");
    addColumn("agent_profiles", "adapter", "TEXT");
    addColumn("agent_profiles", "capabilities_json", "TEXT");
    this.#database.exec(`
      UPDATE agent_profiles
      SET agent_type = CASE
        WHEN kind = 'claude-code' AND command = 'make'
          AND json_extract(args_json, '$[0]') = 'claude-copilot' THEN 'claude-copilot'
        ELSE kind
      END
      WHERE agent_type IS NULL;
      UPDATE agent_profiles
      SET adapter = CASE kind
        WHEN 'copilot' THEN 'copilot-cli'
        WHEN 'pi' THEN 'pi-rpc'
        ELSE 'terminal'
      END
      WHERE adapter IS NULL;
      UPDATE agent_profiles
      SET capabilities_json = CASE
        WHEN kind = 'pi' THEN '["queue","steer"]'
        ELSE '["queue"]'
      END
      WHERE capabilities_json IS NULL;
      UPDATE agent_profiles
      SET adapter = 'copilot-cli', capabilities_json = '["queue"]'
      WHERE adapter = 'copilot-sdk';
    `);

    addColumn("runs", "desired_state", "TEXT");
    addColumn("runs", "recovery_phase", "TEXT");
    addColumn("runs", "recovery_attempts", "INTEGER NOT NULL DEFAULT 0");
    addColumn("runs", "recovery_not_before", "TEXT");
    addColumn("runs", "recovery_reason", "TEXT");
    addColumn("runs", "adapter_session_json", "TEXT");
    this.#database.exec(`
      UPDATE runs
      SET desired_state = CASE WHEN status = 'stopped' THEN 'stopped' ELSE 'running' END
      WHERE desired_state IS NULL;
      UPDATE runs SET recovery_phase = 'idle' WHERE recovery_phase IS NULL;
      UPDATE runs
      SET adapter_session_json = json_set(adapter_session_json, '$.adapter', 'copilot-cli')
      WHERE json_extract(adapter_session_json, '$.adapter') = 'copilot-sdk';
    `);

    addColumn("deliveries", "adapter", "TEXT");
    addColumn("deliveries", "adapter_session_id", "TEXT");
    addColumn("deliveries", "adapter_message_id", "TEXT");
    addColumn("deliveries", "lease_owner", "TEXT");
    addColumn("deliveries", "lease_expires_at", "TEXT");
    addColumn("deliveries", "next_attempt_at", "TEXT");
    addColumn("deliveries", "run_id", "TEXT");
    addColumn("deliveries", "run_generation", "INTEGER");
    this.#database.exec(`
      UPDATE deliveries SET adapter = 'copilot-cli' WHERE adapter = 'copilot-sdk';
      CREATE INDEX IF NOT EXISTS deliveries_dispatch
        ON deliveries (status, next_attempt_at, lease_expires_at, updated_at);
    `);
  }
}
