import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AgentAction,
  type AgentActionAcknowledgement,
  AgentActionAcknowledgementSchema,
  type AgentActionAttempt,
  AgentActionAttemptSchema,
  AgentActionSchema,
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
  type Checkout,
  CheckoutSchema,
  type ClearMessageHistoryResult,
  ClearMessageHistoryResultSchema,
  type CompletionAcknowledgement,
  CompletionAcknowledgementSchema,
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
  type DurableNativeSession,
  DurableNativeSessionSchema,
  type GitOperation,
  GitOperationSchema,
  type Group,
  type GroupMembership,
  GroupMembershipSchema,
  type GroupMessageState,
  GroupMessageStateSchema,
  GroupSchema,
  type InternalCreateAgentProfileCommand,
  InternalCreateAgentProfileCommandSchema,
  MAX_AUTOMATED_REPLIES_PER_CONVERSATION,
  MAX_MESSAGE_CAUSAL_DEPTH,
  MAX_MESSAGE_FAN_OUT,
  MAX_MESSAGE_PAGE_SIZE,
  type Message,
  type MessagePage,
  MessagePageSchema,
  MessageSchema,
  type MessageSubmissionResult,
  MessageSubmissionResultSchema,
  type NanasaConfig,
  type OpenWait,
  OpenWaitSchema,
  type PortalSnapshot,
  PortalSnapshotSchema,
  type ProviderStateBinding,
  ProviderStateBindingSchema,
  REPORTER_LEASE_MS,
  type RecoveryPhase,
  type ReporterSession,
  ReporterSessionSchema,
  type Repository,
  RepositorySchema,
  type RunStatus,
  type ScreenObservation,
  ScreenObservationSchema,
  type StartGroupRunsResult,
  StartGroupRunsResultSchema,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
  type TerminalBinding,
  type TerminalCheckpoint,
  TerminalCheckpointSchema,
  type UpdateGroupCommand,
  UpdateGroupCommandSchema,
  type Worktree,
  WorktreeSchema,
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
import type { RepositoryTrustReceipt } from "./repository-trust-service.js";

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

export type HttpIdempotencyClaim =
  | { kind: "execute" }
  | { kind: "replay"; statusCode: number; response: unknown };

export type HttpIdempotencyExecution =
  | { kind: "executed"; statusCode: number; response: unknown }
  | { kind: "replay"; statusCode: number; response: unknown };

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
  order_index: number;
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
  checkout_id: string | null;
  order_index: number;
  state: string;
  joined_at: string;
  removed_at: string | null;
}

interface RunRow {
  id: string;
  group_id: string;
  member_id: string;
  agent_profile_id: string;
  checkout_id: string | null;
  resolved_working_directory: string | null;
  generation: number;
  status: string;
  desired_state: string | null;
  recovery_phase: string | null;
  recovery_attempts: number | null;
  recovery_not_before: string | null;
  recovery_reason: string | null;
  launch_kind: string;
  requested_model: string | null;
  requested_model_source: string;
  effective_model: string | null;
  native_session_id: string | null;
  recovery_outcome: string | null;
  terminal_json: string | null;
  started_at: string;
  stopped_at: string | null;
}

interface RepositoryRow {
  id: string;
  common_directory: string;
  display_name: string;
  object_format: string;
  ref_storage: string;
  primary_checkout_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface CheckoutRow {
  id: string;
  repository_id: string;
  checkout_key: string;
  path: string;
  git_directory: string;
  kind: string;
  head: string | null;
  branch: string | null;
  dirty: number;
  observed_at: string;
}

interface WorktreeRow {
  id: string;
  repository_id: string;
  checkout_id: string;
  source_checkout_id: string;
  path: string;
  branch: string;
  base: string;
  provenance_token: string;
  operation_generation: number;
  state: string;
  created_at: string;
  updated_at: string;
}

interface GitOperationRow {
  id: string;
  repository_id: string;
  checkout_id: string | null;
  worktree_id: string | null;
  kind: string;
  generation: number;
  target_path: string | null;
  request_json: string;
  state: string;
  started_at: string;
  completed_at: string | null;
  error_code: string | null;
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

interface ActionRow {
  id: string;
  kind: string;
  principal_json: string;
  group_id: string;
  member_id: string;
  run_id: string;
  generation: number;
  daemon_epoch: number;
  reporter_session_id: string;
  reporter_id: string;
  reporter_epoch: string;
  native_session_id: string | null;
  baseline_status_revision: number;
  baseline_completion_revision: number;
  message_id: string | null;
  conversation_id: string | null;
  reply_to_action_id: string | null;
  causation_id: string | null;
  idempotency_key: string;
  request_digest: string;
  prompt: string | null;
  allow_working: number;
  state: string;
  queue_deadline_at: string;
  acceptance_deadline_at: string | null;
  completion_deadline_at: string | null;
  accepted_provider_turn_id: string | null;
  accepted_provider_request_id: string | null;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionAttemptRow {
  id: string;
  action_id: string;
  attempt: number;
  effect: string;
  state: string;
  daemon_epoch: number;
  group_id: string;
  member_id: string;
  run_id: string;
  generation: number;
  reporter_session_id: string;
  reporter_id: string;
  reporter_epoch: string;
  native_session_id: string | null;
  baseline_status_revision: number;
  baseline_completion_revision: number;
  terminal_binding_json: string;
  terminal_binding_fingerprint: string;
  provider_turn_id: string | null;
  provider_request_id: string | null;
  lease_owner: string;
  lease_expires_at: string;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  failure_code: string | null;
}

interface ActionAcknowledgementRow {
  id: string;
  action_id: string;
  attempt_id: string;
  kind: string;
  run_id: string;
  generation: number;
  reporter_session_id: string;
  reporter_id: string;
  reporter_epoch: string;
  source_sequence: number;
  native_session_id: string | null;
  provider_turn_id: string | null;
  provider_request_id: string | null;
  completion_revision: number;
  acknowledged_at: string;
  data_json: string;
}

interface OpenWaitRow {
  id: string;
  action_id: string | null;
  group_id: string;
  member_id: string;
  run_id: string;
  generation: number;
  reporter_session_id: string;
  reporter_id: string;
  reporter_epoch: string;
  native_session_id: string | null;
  provider_request_id: string;
  kind: string;
  summary: string;
  reply_channel: string;
  opened_status_revision: number;
  state: string;
  expires_at: string | null;
  opened_at: string;
  updated_at: string;
  answered_at: string | null;
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
    statusRevision: detail.statusRevision,
    completionRevision: detail.completionRevision,
    operatorAcknowledgedCompletionRevision: detail.operatorAcknowledgedCompletionRevision,
    completionPending: detail.completionPending,
    interactiveReady: detail.interactiveReady,
    staleAuthority: detail.staleAuthority,
    authorityKind: detail.authorityKind,
    authorityId: detail.authorityId,
    evidenceConfidence: detail.evidenceConfidence,
    processState: detail.processState,
    processFingerprint: detail.processFingerprint,
    reporterEpoch: detail.reporterEpoch,
    reporterLeaseExpiresAt: detail.reporterLeaseExpiresAt,
    readinessCoverage: detail.readinessCoverage,
    lastScreenObservation: detail.lastScreenObservation,
  });
}

export class NanasaStore {
  readonly #database: DatabaseSync;
  readonly #listeners = new Set<DomainEventListener>();
  #instanceId = "store-local";
  #daemonEpoch = 0;
  #config: NanasaConfig | undefined;
  #configStatus: ConfigStatus | undefined;
  #messageRetentionPerGroup: number;
  readonly #memberNameGenerator: MemberNameGenerator;
  #transactionDepth = 0;
  readonly #pendingEvents: DomainEvent[] = [];

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

  public beginDaemonEpoch(options: {
    instanceId: string;
    processId: number;
    processStartedAt: string;
  }): number {
    const epoch = this.#transaction(() => {
      const row = this.#database
        .prepare("SELECT COALESCE(MAX(epoch), 0) + 1 AS epoch FROM daemon_epochs")
        .get() as { epoch: number };
      this.#database
        .prepare(
          `INSERT INTO daemon_epochs
               (epoch, instance_id, process_id, process_started_at, acquired_at, released_at)
             VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          row.epoch,
          options.instanceId,
          options.processId,
          options.processStartedAt,
          new Date().toISOString(),
        );
      return row.epoch;
    });
    this.#instanceId = options.instanceId;
    this.#daemonEpoch = epoch;
    return epoch;
  }

  public releaseDaemonEpoch(instanceId: string): void {
    this.#database
      .prepare(
        `UPDATE daemon_epochs SET released_at = ?
         WHERE instance_id = ? AND released_at IS NULL`,
      )
      .run(new Date().toISOString(), instanceId);
  }

  public getOrderRevision(): number {
    return (
      this.#database
        .prepare("SELECT order_revision FROM topology_order_state WHERE singleton = 1")
        .get() as { order_revision: number }
    ).order_revision;
  }

  public saveDiscoveredCheckout(
    repository: Repository,
    checkout: Checkout,
    makePrimary = false,
  ): { repository: Repository; checkout: Checkout } {
    const parsedRepository = RepositorySchema.parse(repository);
    const parsedCheckout = CheckoutSchema.parse(checkout);
    if (parsedCheckout.repositoryId !== parsedRepository.id) {
      throw new DomainError(
        "checkout_repository_mismatch",
        "Checkout repository identity differs",
        409,
      );
    }
    const result = this.#transaction(() => {
      const existing = this.#database
        .prepare("SELECT * FROM repositories WHERE id = ?")
        .get(parsedRepository.id) as unknown as RepositoryRow | undefined;
      if (
        existing !== undefined &&
        (existing.common_directory !== parsedRepository.commonDirectory ||
          existing.object_format !== parsedRepository.objectFormat)
      ) {
        throw new DomainError(
          "repository_identity_conflict",
          "Repository identity changed while recording a checkout",
          409,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO repositories
             (id, common_directory, display_name, object_format, ref_storage,
              primary_checkout_id, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             ref_storage = excluded.ref_storage,
             revision = repositories.revision + 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          parsedRepository.id,
          parsedRepository.commonDirectory,
          parsedRepository.displayName,
          parsedRepository.objectFormat,
          parsedRepository.refStorage,
          parsedRepository.revision,
          parsedRepository.createdAt,
          parsedRepository.updatedAt,
        );
      this.#database
        .prepare(
          `INSERT INTO checkouts
             (id, repository_id, checkout_key, path, git_directory, kind, head, branch, dirty, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             repository_id = excluded.repository_id,
             checkout_key = excluded.checkout_key,
             path = excluded.path,
             git_directory = excluded.git_directory,
             kind = excluded.kind,
             head = excluded.head,
             branch = excluded.branch,
             dirty = excluded.dirty,
             observed_at = excluded.observed_at`,
        )
        .run(
          parsedCheckout.id,
          parsedCheckout.repositoryId,
          parsedCheckout.checkoutKey,
          parsedCheckout.path,
          parsedCheckout.gitDirectory,
          parsedCheckout.kind,
          parsedCheckout.head ?? null,
          parsedCheckout.branch ?? null,
          parsedCheckout.dirty ? 1 : 0,
          parsedCheckout.observedAt,
        );
      if (makePrimary || existing?.primary_checkout_id === null || existing === undefined) {
        this.#database
          .prepare("UPDATE repositories SET primary_checkout_id = ? WHERE id = ?")
          .run(parsedCheckout.id, parsedRepository.id);
      }
      return {
        repository: this.getRepository(parsedRepository.id),
        checkout: this.getCheckout(parsedCheckout.id),
      };
    });
    return result;
  }

  public listRepositories(): Repository[] {
    return (
      this.#database
        .prepare("SELECT * FROM repositories ORDER BY created_at, id")
        .all() as unknown as RepositoryRow[]
    ).map((row) => this.#hydrateRepository(row));
  }

  public getRepository(repositoryId: string): Repository {
    const row = this.#database
      .prepare("SELECT * FROM repositories WHERE id = ?")
      .get(repositoryId) as unknown as RepositoryRow | undefined;
    if (row === undefined)
      throw new DomainError("repository_not_found", "Repository not found", 404);
    return this.#hydrateRepository(row);
  }

  public listCheckouts(repositoryId?: string): Checkout[] {
    const rows = (repositoryId === undefined
      ? this.#database.prepare("SELECT * FROM checkouts ORDER BY observed_at, id").all()
      : this.#database
          .prepare("SELECT * FROM checkouts WHERE repository_id = ? ORDER BY observed_at, id")
          .all(repositoryId)) as unknown as CheckoutRow[];
    return rows.map((row) => this.#hydrateCheckout(row));
  }

  public getCheckout(checkoutId: string): Checkout {
    const row = this.#database
      .prepare("SELECT * FROM checkouts WHERE id = ?")
      .get(checkoutId) as unknown as CheckoutRow | undefined;
    if (row === undefined) throw new DomainError("checkout_not_found", "Checkout not found", 404);
    return this.#hydrateCheckout(row);
  }

  public listWorktrees(repositoryId?: string): Worktree[] {
    const rows = (repositoryId === undefined
      ? this.#database.prepare("SELECT * FROM worktrees ORDER BY created_at, id").all()
      : this.#database
          .prepare("SELECT * FROM worktrees WHERE repository_id = ? ORDER BY created_at, id")
          .all(repositoryId)) as unknown as WorktreeRow[];
    return rows.map((row) => this.#hydrateWorktree(row));
  }

  public getWorktree(worktreeId: string): Worktree {
    const row = this.#database
      .prepare("SELECT * FROM worktrees WHERE id = ?")
      .get(worktreeId) as unknown as WorktreeRow | undefined;
    if (row === undefined)
      throw new DomainError("worktree_not_found", "Managed worktree not found", 404);
    return this.#hydrateWorktree(row);
  }

  public saveWorktree(worktree: Worktree): Worktree {
    const parsed = WorktreeSchema.parse(worktree);
    this.#database
      .prepare(
        `INSERT INTO worktrees
           (id, repository_id, checkout_id, source_checkout_id, path, branch, base,
            provenance_token, operation_generation, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           checkout_id = excluded.checkout_id,
           path = excluded.path,
           operation_generation = excluded.operation_generation,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(
        parsed.id,
        parsed.repositoryId,
        parsed.checkoutId,
        parsed.sourceCheckoutId,
        parsed.path,
        parsed.branch,
        parsed.base,
        parsed.provenanceToken,
        parsed.operationGeneration,
        parsed.state,
        parsed.createdAt,
        parsed.updatedAt,
      );
    return this.getWorktree(parsed.id);
  }

  public beginGitOperation(input: {
    repositoryId: string;
    checkoutId?: string;
    worktreeId?: string;
    kind: GitOperation["kind"];
    targetPath?: string;
    request?: Readonly<Record<string, unknown>>;
  }): GitOperation {
    this.getRepository(input.repositoryId);
    const generation = (
      this.#database
        .prepare(
          "SELECT COALESCE(MAX(generation), 0) + 1 AS value FROM git_operations WHERE repository_id = ?",
        )
        .get(input.repositoryId) as { value: number }
    ).value;
    const operation = GitOperationSchema.parse({
      id: `gitop_${randomUUID()}`,
      repositoryId: input.repositoryId,
      checkoutId: input.checkoutId,
      worktreeId: input.worktreeId,
      kind: input.kind,
      generation,
      targetPath: input.targetPath,
      state: "running",
      startedAt: new Date().toISOString(),
    });
    this.#database
      .prepare(
        `INSERT INTO git_operations
           (id, repository_id, checkout_id, worktree_id, kind, generation, target_path,
            request_json, state, started_at, completed_at, error_code)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        operation.id,
        operation.repositoryId,
        operation.checkoutId ?? null,
        operation.worktreeId ?? null,
        operation.kind,
        operation.generation,
        operation.targetPath ?? null,
        JSON.stringify(input.request ?? {}),
        operation.state,
        operation.startedAt,
      );
    return operation;
  }

  public completeGitOperation(
    operationId: string,
    state: "succeeded" | "failed" | "cancelled",
    errorCode?: string,
  ): GitOperation {
    const completedAt = new Date().toISOString();
    const changed = this.#database
      .prepare(
        `UPDATE git_operations SET state = ?, completed_at = ?, error_code = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(state, completedAt, errorCode ?? null, operationId);
    if (Number(changed.changes) !== 1) {
      throw new DomainError("git_operation_stale", "Git operation is no longer current", 409);
    }
    return this.getGitOperation(operationId);
  }

  public getGitOperation(operationId: string): GitOperation {
    const row = this.#database
      .prepare("SELECT * FROM git_operations WHERE id = ?")
      .get(operationId) as unknown as GitOperationRow | undefined;
    if (row === undefined)
      throw new DomainError("git_operation_not_found", "Git operation not found", 404);
    return this.#hydrateGitOperation(row);
  }

  public getGitOperationRequest(operationId: string): Readonly<Record<string, unknown>> {
    const row = this.#database
      .prepare("SELECT request_json FROM git_operations WHERE id = ?")
      .get(operationId) as { request_json: string } | undefined;
    if (row === undefined)
      throw new DomainError("git_operation_not_found", "Git operation not found", 404);
    const value: unknown = JSON.parse(row.request_json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DomainError("git_operation_intent_invalid", "Git operation intent is invalid", 500);
    }
    return value as Readonly<Record<string, unknown>>;
  }

  public listRecoverableGitOperations(): GitOperation[] {
    return (
      this.#database
        .prepare("SELECT * FROM git_operations WHERE state = 'running' ORDER BY generation, id")
        .all() as unknown as GitOperationRow[]
    ).map((row) => this.#hydrateGitOperation(row));
  }

  public listRunsBoundToCheckout(checkoutId: string): AgentRun[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM runs WHERE checkout_id = ?
           AND (status IN ('starting', 'running', 'stopping') OR desired_state = 'running')
           ORDER BY started_at, id`,
        )
        .all(checkoutId) as unknown as RunRow[]
    ).map((row) => this.#hydrateRun(row));
  }

  public listMembershipsBoundToCheckout(checkoutId: string): GroupMembership[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM memberships WHERE checkout_id = ? AND state = 'active'
           ORDER BY group_id, order_index, id`,
        )
        .all(checkoutId) as unknown as MembershipRow[]
    ).map((row) => this.#hydrateMembership(row));
  }

  public reconcileTopology(config: NanasaConfig, configStatus?: ConfigStatus): void {
    const timestamp = new Date().toISOString();
    this.#transaction(() => {
      const configuredGroups = Object.entries(config.groups)
        .map(([groupId, group], sourceIndex) => ({ groupId, group, sourceIndex }))
        .sort(
          (left, right) =>
            (left.group.order ?? left.sourceIndex) - (right.group.order ?? right.sourceIndex) ||
            left.sourceIndex - right.sourceIndex ||
            left.groupId.localeCompare(right.groupId),
        );
      const desiredOrder = configuredGroups.flatMap(({ groupId, group }, groupOrder) => [
        `group:${groupId}:${groupOrder}`,
        ...orderedAgentEntries(group.agents).map(
          ([agentId], memberOrder) => `member:${groupId}:${agentId}:${memberOrder}`,
        ),
      ]);
      const persistedOrder = (
        this.#database
          .prepare(
            `SELECT 'group:' || id || ':' || order_index AS value, order_index AS group_order,
                    -1 AS member_order
             FROM groups
             UNION ALL
             SELECT 'member:' || group_id || ':' || id || ':' || order_index AS value,
                    (SELECT order_index FROM groups WHERE groups.id = memberships.group_id),
                    order_index
             FROM memberships WHERE state = 'active'
             ORDER BY group_order, member_order, value`,
          )
          .all() as Array<{ value: string }>
      ).map((row) => row.value);
      if (JSON.stringify(desiredOrder) !== JSON.stringify(persistedOrder)) {
        this.#database
          .prepare(
            "UPDATE topology_order_state SET order_revision = order_revision + 1 WHERE singleton = 1",
          )
          .run();
      }
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
      for (const { group: configuredGroup } of configuredGroups) {
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
      const priorMembershipIdentity = new Map<string, string[]>();
      const priorMemberships = this.#database
        .prepare("SELECT * FROM memberships WHERE state = 'active'")
        .all() as unknown as MembershipRow[];
      for (const membership of priorMemberships) {
        const identity = priorMembershipIdentity.get(membership.group_id) ?? [];
        identity.push(`${membership.id}:${membership.member_id}:${membership.agent_profile_id}`);
        priorMembershipIdentity.set(membership.group_id, identity);
      }
      for (const identity of priorMembershipIdentity.values()) identity.sort();
      const primaryCheckout = this.#database
        .prepare(
          `SELECT c.id FROM checkouts c
           JOIN repositories r ON r.primary_checkout_id = c.id
           ORDER BY r.created_at, r.id LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      for (const [groupOrder, { groupId, group: configuredGroup }] of configuredGroups.entries()) {
        const existingGroup = this.#database
          .prepare("SELECT * FROM groups WHERE id = ?")
          .get(groupId) as unknown as GroupRow | undefined;
        const existingMemberships = this.#database
          .prepare("SELECT * FROM memberships WHERE group_id = ? AND state = 'active'")
          .all(groupId) as unknown as MembershipRow[];
        const desiredMemberships = orderedAgentEntries(configuredGroup.agents);
        const existingIdentity = priorMembershipIdentity.get(groupId) ?? [];
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
            `INSERT INTO groups (id, name, order_index, membership_revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               order_index = excluded.order_index,
               membership_revision = excluded.membership_revision,
               updated_at = excluded.updated_at`,
          )
          .run(
            groupId,
            configuredGroup.name,
            groupOrder,
            membershipRevision,
            existingGroup?.created_at ?? timestamp,
            groupUpdatedAt,
          );

        const desiredMembershipIds = new Set(
          desiredMemberships.map(([membershipId]) => membershipId),
        );
        for (const [memberOrder, [agentId, agent]] of desiredMemberships.entries()) {
          const checkoutId = agent.checkoutId ?? primaryCheckout?.id;
          if (
            checkoutId !== undefined &&
            this.#database.prepare("SELECT 1 FROM checkouts WHERE id = ?").get(checkoutId) ===
              undefined
          ) {
            throw new DomainError(
              "configured_checkout_not_found",
              `Checkout ${checkoutId} is not available on this machine`,
              409,
            );
          }
          this.#database
            .prepare(
              `INSERT INTO memberships
                 (id, group_id, member_id, agent_profile_id, alias, role_id, checkout_id,
                  order_index, state, joined_at, removed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)
               ON CONFLICT(id) DO UPDATE SET
                 group_id = excluded.group_id,
                 member_id = excluded.member_id,
                 agent_profile_id = excluded.agent_profile_id,
                 alias = excluded.alias,
                 role_id = excluded.role_id,
                 checkout_id = excluded.checkout_id,
                 order_index = excluded.order_index,
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
              checkoutId ?? null,
              memberOrder,
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
      const order = (
        this.#database
          .prepare("SELECT COALESCE(MAX(order_index), -1) + 1 AS value FROM groups")
          .get() as {
          value: number;
        }
      ).value;
      const group = GroupSchema.parse({
        id: `grp_${randomUUID()}`,
        name: input.name,
        order,
        membershipRevision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      this.#database
        .prepare(
          `INSERT INTO groups (id, name, order_index, membership_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          group.id,
          group.name,
          group.order,
          group.membershipRevision,
          group.createdAt,
          group.updatedAt,
        );
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
            "UPDATE deliveries SET run_id = NULL, run_generation = NULL WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?)",
          )
          .run(groupId);
        for (const table of [
          "terminal_checkpoints",
          "models",
          "native_sessions",
          "completion_acknowledgements",
          "screen_observations",
        ] as const) {
          this.#database
            .prepare(
              `DELETE FROM ${table} WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?)`,
            )
            .run(groupId);
        }
        this.#database
          .prepare(
            "DELETE FROM action_acknowledgements WHERE action_id IN (SELECT id FROM actions WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?))",
          )
          .run(groupId);
        this.#database
          .prepare(
            "DELETE FROM action_attempts WHERE action_id IN (SELECT id FROM actions WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?))",
          )
          .run(groupId);
        this.#database
          .prepare(
            "DELETE FROM open_waits WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?)",
          )
          .run(groupId);
        this.#database
          .prepare("DELETE FROM actions WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?)")
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
        this.#database
          .prepare(
            "DELETE FROM reporter_sessions WHERE run_id IN (SELECT id FROM runs WHERE group_id = ?)",
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
      const order = (
        this.#database
          .prepare(
            "SELECT COALESCE(MAX(order_index), -1) + 1 AS value FROM memberships WHERE group_id = ? AND state = 'active'",
          )
          .get(groupId) as { value: number }
      ).value;
      const checkout = this.#database
        .prepare(
          `SELECT c.id FROM checkouts c JOIN repositories r ON r.primary_checkout_id = c.id
           ORDER BY r.created_at, r.id LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      const membership = GroupMembershipSchema.parse({
        id: existing?.id ?? `membership_${randomUUID()}`,
        groupId,
        memberId,
        agentProfileId: input.agentProfileId,
        alias: input.alias,
        roleId: input.roleId,
        checkoutId: checkout?.id,
        order,
        state: "active",
        joinedAt: timestamp,
      });

      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO memberships
              (id, group_id, member_id, agent_profile_id, alias, role_id, checkout_id,
               order_index, state, joined_at, removed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
          )
          .run(
            membership.id,
            membership.groupId,
            membership.memberId,
            membership.agentProfileId,
            membership.alias,
            membership.roleId ?? null,
            membership.checkoutId ?? null,
            membership.order,
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

      const timestamp = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE actions SET state = 'superseded', updated_at = ?,
             error_json = '{"code":"run_replaced","message":"The target run was replaced","retryable":false}'
           WHERE group_id = ? AND member_id = ? AND run_id <> ?
             AND state IN ('created', 'deferred', 'submitted', 'accepted', 'started', 'blocked')`,
        )
        .run(timestamp, input.groupId, input.memberId, input.id);
      this.#database
        .prepare(
          `UPDATE open_waits SET state = 'superseded', updated_at = ?
           WHERE group_id = ? AND member_id = ? AND run_id <> ? AND state IN ('open', 'replying')`,
        )
        .run(timestamp, input.groupId, input.memberId, input.id);

      this.#database
        .prepare(
          `INSERT INTO runs
             (id, group_id, member_id, agent_profile_id, checkout_id,
              resolved_working_directory, generation, status,
            desired_state, recovery_phase, recovery_attempts, recovery_not_before,
            recovery_reason, launch_kind, requested_model, requested_model_source,
            effective_model, native_session_id, recovery_outcome, terminal_json, started_at, stopped_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.groupId,
          input.memberId,
          input.agentProfileId,
          input.checkoutId ?? null,
          input.resolvedWorkingDirectory ?? null,
          input.generation,
          input.status,
          input.desiredState,
          input.recoveryPhase,
          input.recoveryAttempts,
          input.recoveryNotBefore ?? null,
          input.recoveryReason ?? null,
          input.launchKind,
          input.requestedModel ?? null,
          input.requestedModelSource,
          input.effectiveModel ?? null,
          input.nativeSessionId ?? null,
          input.recoveryOutcome ?? null,
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
      launchKind?: AgentRun["launchKind"];
      requestedModel?: string;
      requestedModelSource?: AgentRun["requestedModelSource"];
      nativeSessionId?: string;
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
          FROM runs WHERE agent_profile_id = ?`,
      )
      .get(membership.agent_profile_id) as unknown as { generation: number };
    const profile = this.#requireAgentProfile(membership.agent_profile_id);
    const runLocation = this.#resolveRunLocation(membership, profile.workingDirectory);
    const run = this.createRun({
      id: `run_${randomUUID()}`,
      groupId,
      memberId,
      agentProfileId: membership.agent_profile_id,
      ...(runLocation.checkoutId === undefined ? {} : { checkoutId: runLocation.checkoutId }),
      ...(runLocation.workingDirectory === undefined
        ? {}
        : { resolvedWorkingDirectory: runLocation.workingDirectory }),
      generation: generationRow.generation,
      status: "starting",
      desiredState: "running",
      recoveryPhase:
        options.recoveryFrom === undefined
          ? "idle"
          : options.launchKind === "resuming"
            ? "resuming"
            : "restarting",
      recoveryAttempts: options.recoveryFrom?.recoveryAttempts ?? 0,
      recoveryNotBefore: options.recoveryFrom?.recoveryNotBefore,
      recoveryReason: options.recoveryFrom?.recoveryReason,
      launchKind:
        options.launchKind ?? (options.recoveryFrom === undefined ? "fresh" : "restarted"),
      requestedModel: options.requestedModel,
      requestedModelSource: options.requestedModelSource ?? "provider-default",
      nativeSessionId: options.nativeSessionId,
      startedAt: new Date().toISOString(),
    });
    return {
      run,
      profile,
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

  public listAgentStatuses(groupId: string, operatorId?: string): AgentStatusSummary[] {
    this.#requireGroup(groupId);
    return this.listActiveMemberships(groupId)
      .sort((left, right) => left.memberId.localeCompare(right.memberId))
      .map((membership) =>
        agentStatusSummary(this.#getAgentStatusDetail(groupId, membership.memberId, operatorId)),
      );
  }

  public getAgentStatus(groupId: string, memberId: string, operatorId?: string): AgentStatusDetail {
    this.#requireGroup(groupId);
    return this.#getAgentStatusDetail(groupId, memberId, operatorId);
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
        ORDER BY order_index, id`,
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
      if (status === "stopped" || status === "failed") {
        const actionState = status === "stopped" ? "superseded" : "failed";
        this.#database
          .prepare(
            `UPDATE actions SET state = ?, updated_at = ?,
               error_json = ?
             WHERE run_id = ?
               AND state IN ('created', 'deferred', 'submitted', 'accepted', 'started', 'blocked')`,
          )
          .run(
            actionState,
            stoppedAt,
            JSON.stringify({
              code: status === "stopped" ? "run_stopped" : "run_failed",
              message: status === "stopped" ? "The target run stopped" : "The target run failed",
              retryable: false,
            }),
            runId,
          );
        this.#database
          .prepare(
            `UPDATE open_waits SET state = 'superseded', updated_at = ?
             WHERE run_id = ? AND state IN ('open', 'replying')`,
          )
          .run(stoppedAt, runId);
      }
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
      this.revokeReporterAuthority(runId, current.generation, `run_${status}`);
      this.recordProcessStatus(runId, {
        event: "process.exited",
        eventId: `process-exited-${current.generation}-${status}`,
        observedAt: new Date().toISOString(),
        operatorStopped: status === "stopped",
      });
    }
    return result;
  }

  public updateRunProviderMetadata(
    runId: string,
    metadata: Partial<
      Pick<
        AgentRun,
        | "launchKind"
        | "requestedModel"
        | "requestedModelSource"
        | "effectiveModel"
        | "nativeSessionId"
        | "recoveryOutcome"
      >
    >,
  ): AgentRun {
    const current = this.getRun(runId);
    this.#database
      .prepare(
        `UPDATE runs SET
           launch_kind = ?, requested_model = ?, requested_model_source = ?,
           effective_model = ?, native_session_id = ?, recovery_outcome = ?
         WHERE id = ?`,
      )
      .run(
        metadata.launchKind ?? current.launchKind,
        metadata.requestedModel ?? current.requestedModel ?? null,
        metadata.requestedModelSource ?? current.requestedModelSource,
        metadata.effectiveModel ?? current.effectiveModel ?? null,
        metadata.nativeSessionId ?? current.nativeSessionId ?? null,
        metadata.recoveryOutcome ?? current.recoveryOutcome ?? null,
        runId,
      );
    return this.getRun(runId);
  }

  public registerReporterSession(session: ReporterSession): ReporterSession {
    const parsed = ReporterSessionSchema.parse(session);
    this.#transaction(() => {
      this.#database
        .prepare(
          `UPDATE reporter_sessions
           SET revoked_at = COALESCE(revoked_at, ?), closed_at = COALESCE(closed_at, ?)
           WHERE run_id = ? AND generation = ? AND reporter_epoch <> ? AND closed_at IS NULL`,
        )
        .run(
          parsed.openedAt,
          parsed.openedAt,
          parsed.runId,
          parsed.generation,
          parsed.reporterEpoch,
        );
      this.#database
        .prepare(
          `INSERT INTO reporter_sessions
             (id, run_id, generation, provider_id, adapter_id, reporter_id, source,
              protocol_version, reporter_version, reporter_epoch, readiness_coverage,
              source_sequence, native_session_id, process_fingerprint, opened_at,
              lease_expires_at, revoked_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.runId,
          parsed.generation,
          parsed.providerId,
          parsed.adapterId,
          parsed.reporterId,
          parsed.source,
          parsed.protocolVersion,
          parsed.reporterVersion,
          parsed.reporterEpoch,
          parsed.readinessCoverage,
          parsed.sourceSequence,
          parsed.nativeSessionId ?? null,
          parsed.processFingerprint ?? null,
          parsed.openedAt,
          parsed.leaseExpiresAt,
          parsed.revokedAt ?? null,
          parsed.closedAt ?? null,
        );
    });
    return parsed;
  }

  public getCurrentReporterSession(runId: string, generation: number): ReporterSession | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM reporter_sessions
         WHERE run_id = ? AND generation = ? AND revoked_at IS NULL AND closed_at IS NULL
         ORDER BY opened_at DESC LIMIT 1`,
      )
      .get(runId, generation) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return ReporterSessionSchema.parse({
      id: row.id,
      providerId: row.provider_id,
      adapterId: row.adapter_id,
      reporterId: row.reporter_id,
      source: row.source,
      protocolVersion: row.protocol_version,
      reporterVersion: row.reporter_version,
      runId: row.run_id,
      generation: row.generation,
      reporterEpoch: row.reporter_epoch,
      sourceSequence: row.source_sequence,
      nativeSessionId: row.native_session_id ?? undefined,
      readinessCoverage: row.readiness_coverage,
      processFingerprint: row.process_fingerprint ?? undefined,
      openedAt: row.opened_at,
      leaseExpiresAt: row.lease_expires_at,
      revokedAt: row.revoked_at ?? undefined,
      closedAt: row.closed_at ?? undefined,
    });
  }

  public bindReporterProcess(runId: string, generation: number, processFingerprint: string): void {
    const session = this.getCurrentReporterSession(runId, generation);
    if (session === undefined) return;
    if (
      session.processFingerprint !== undefined &&
      session.processFingerprint !== processFingerprint
    ) {
      this.revokeReporterAuthority(runId, generation, "process_replaced");
      throw new DomainError(
        "status_process_fingerprint_changed",
        "Reporter authority was revoked because the foreground process changed",
        409,
      );
    }
    this.#database
      .prepare(
        `UPDATE reporter_sessions SET process_fingerprint = ?
         WHERE id = ? AND revoked_at IS NULL AND closed_at IS NULL`,
      )
      .run(processFingerprint, session.id);
  }

  public revokeReporterAuthority(runId: string, generation: number, reason: string): void {
    void reason;
    const timestamp = new Date().toISOString();
    this.#database
      .prepare(
        `UPDATE reporter_sessions SET revoked_at = COALESCE(revoked_at, ?), closed_at = COALESCE(closed_at, ?)
         WHERE run_id = ? AND generation = ? AND closed_at IS NULL`,
      )
      .run(timestamp, timestamp, runId, generation);
  }

  public recordReporterRejection(event: Partial<AgentStatusEventInput>, code: string): void {
    this.#database
      .prepare(
        `INSERT INTO reporter_rejections
           (run_id, generation, reporter_epoch, source_sequence, code, rejected_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.runId ?? null,
        event.generation ?? null,
        event.reporterEpoch ?? null,
        event.sourceSequence ?? null,
        code,
        new Date().toISOString(),
      );
    this.#database
      .prepare(
        `DELETE FROM reporter_rejections WHERE sequence NOT IN
           (SELECT sequence FROM reporter_rejections ORDER BY sequence DESC LIMIT 256)`,
      )
      .run();
  }

  public ingestAgentStatusEvent(
    identity: AgentStatusIdentity,
    event: AgentStatusEventInput,
  ): AgentStatusIngestResult {
    const input = AgentStatusEventInputSchema.parse(event);
    const observedAt = new Date().toISOString();
    const completed = this.#transaction(() => {
      const run = this.#requireCurrentAgentStatusRun(identity);
      const profile = this.#requireAgentProfile(run.agentProfileId);
      const session = this.getCurrentReporterSession(run.id, run.generation);
      const wrongIdentity =
        input.runId !== run.id ||
        input.generation !== run.generation ||
        session === undefined ||
        input.providerId !== profile.agentType ||
        input.adapterId !== profile.kind ||
        input.providerId !== session.providerId ||
        input.adapterId !== session.adapterId ||
        input.reporterId !== session.reporterId ||
        input.source !== session.source ||
        input.protocolVersion !== session.protocolVersion ||
        input.reporterVersion !== session.reporterVersion ||
        input.reporterEpoch !== session.reporterEpoch;
      if (wrongIdentity) {
        throw new DomainError(
          "status_reporter_identity_fenced",
          "Reporter identity is not authoritative",
          409,
        );
      }
      if (session.processFingerprint === undefined) {
        throw new DomainError(
          "status_process_unverified",
          "Reporter process identity is not verified",
          409,
        );
      }
      if (Date.parse(observedAt) > Date.parse(session.leaseExpiresAt)) {
        throw new DomainError(
          "status_reporter_lease_expired",
          "Reporter authority lease expired",
          409,
        );
      }
      if (input.sourceSequence <= session.sourceSequence) {
        throw new DomainError(
          "status_sequence_reordered",
          "Reporter sequence is stale or reordered",
          409,
        );
      }
      if (
        session.nativeSessionId !== undefined &&
        input.nativeSessionId !== session.nativeSessionId
      ) {
        throw new DomainError(
          "status_native_session_fenced",
          "Reporter native session changed",
          409,
        );
      }
      const eventDuplicate = this.#database
        .prepare(
          "SELECT 1 FROM runtime_observations WHERE run_id = ? AND generation = ? AND event_id = ?",
        )
        .get(run.id, run.generation, input.eventId);
      if (eventDuplicate !== undefined) {
        throw new DomainError(
          "status_event_duplicate",
          "Reporter event ID was already accepted",
          409,
        );
      }
      const leaseExpiresAt = new Date(Date.parse(observedAt) + REPORTER_LEASE_MS).toISOString();
      this.#database
        .prepare(
          `UPDATE reporter_sessions SET source_sequence = ?, native_session_id = COALESCE(native_session_id, ?),
             lease_expires_at = ? WHERE id = ?`,
        )
        .run(input.sourceSequence, input.nativeSessionId ?? null, leaseExpiresAt, session.id);
      const previous = this.#agentStatusState(run);
      const next = reduceAgentStatus(previous, {
        event: "reporter.event",
        observedAt,
        input,
        authority: {
          sessionId: session.id,
          reporterEpoch: session.reporterEpoch,
          readinessCoverage: session.readinessCoverage,
          leaseExpiresAt,
        },
      });
      this.#insertAgentStatusEvent(
        run,
        input.eventId,
        input.source,
        input.event,
        observedAt,
        input,
      );
      this.#applyOpenWaitReporterEvent(run, session, input, next);
      this.#upsertAgentStatusState(run, next);
      this.#trimAgentStatusEvents(run.id, run.generation);
      return {
        status: this.#getAgentStatusDetail(run.groupId, run.memberId),
        duplicate: false as const,
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

  public recordScreenObservation(runId: string, screen: ScreenObservation): AgentStatusDetail {
    const parsed = ScreenObservationSchema.parse(screen);
    const completed = this.#transaction(() => {
      const run = this.getRun(runId);
      if (parsed.runId !== run.id || parsed.generation !== run.generation) {
        throw new DomainError(
          "status_screen_generation_fenced",
          "Screen observation generation is stale",
          409,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO screen_observations (run_id, generation, observed_at, metadata_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(run.id, run.generation, parsed.observedAt, JSON.stringify(parsed));
      this.#database
        .prepare(
          `DELETE FROM screen_observations WHERE run_id = ? AND generation = ? AND sequence NOT IN
             (SELECT sequence FROM screen_observations WHERE run_id = ? AND generation = ? ORDER BY sequence DESC LIMIT 20)`,
        )
        .run(run.id, run.generation, run.id, run.generation);
      const previous = this.#agentStatusState(run);
      const next = reduceAgentStatus(previous, {
        event: "screen.classified",
        eventId: `screen-${parsed.captureHash}-${parsed.manifestDigest}`,
        observedAt: parsed.observedAt,
        screen: parsed,
      });
      this.#upsertAgentStatusState(run, next);
      return {
        status: this.#getAgentStatusDetail(run.groupId, run.memberId),
        domainEvents: this.#appendAgentStatusDomainEvents(run, previous, next),
      };
    });
    for (const event of completed.domainEvents) this.#publish(event);
    return completed.status;
  }

  public acknowledgeCompletion(operatorId: string, runId: string): CompletionAcknowledgement {
    const run = this.getRun(runId);
    const state = this.#agentStatusState(run);
    const acknowledgement = CompletionAcknowledgementSchema.parse({
      operatorId,
      runId,
      generation: run.generation,
      completionRevision: state.completionRevision,
      acknowledgedAt: new Date().toISOString(),
    });
    this.#database
      .prepare(
        `INSERT INTO completion_acknowledgements
           (operator_id, run_id, generation, completion_revision, acknowledged_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(operator_id, run_id, generation) DO UPDATE SET
           completion_revision = MAX(completion_acknowledgements.completion_revision, excluded.completion_revision),
           acknowledged_at = excluded.acknowledged_at`,
      )
      .run(
        acknowledgement.operatorId,
        acknowledgement.runId,
        acknowledgement.generation,
        acknowledgement.completionRevision,
        acknowledgement.acknowledgedAt,
      );
    return acknowledgement;
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
    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ groupId, input }))
      .digest("hex");
    return this.#executeIdempotent(
      scope,
      idempotencyKey,
      MessageSubmissionResultSchema,
      () => {
        const group = this.#requireGroup(groupId);
        this.#validateSender(groupId, input.sender);
        const recipients = this.#resolveRecipients(group, input);
        if (recipients.length === 0) {
          throw new DomainError("empty_audience", "The message has no eligible recipients", 409);
        }
        if (recipients.length > MAX_MESSAGE_FAN_OUT) {
          throw new DomainError(
            "message_fan_out_exceeded",
            `Message fan-out exceeds the ${MAX_MESSAGE_FAN_OUT}-recipient limit`,
            409,
          );
        }
        const causation = this.#deriveMessageCausation(groupId, input, recipients);

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
          ...causation,
          id: messageId,
          groupId,
          groupSeq: sequenceRow.next_seq,
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
      },
      requestDigest,
    );
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

  public getMessage(messageId: string): Message {
    const row = this.#database.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
      | MessageRow
      | undefined;
    if (row === undefined) throw new DomainError("message_not_found", "Message not found", 404);
    return this.#hydrateMessage(row);
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
      this.#database
        .prepare("UPDATE actions SET message_id = NULL WHERE message_id = ?")
        .run(messageId);
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

  public createAgentAction(action: AgentAction): AgentAction {
    const parsed = AgentActionSchema.parse(action);
    const existing = this.#database
      .prepare("SELECT * FROM actions WHERE group_id = ? AND idempotency_key = ?")
      .get(parsed.target.groupId, parsed.idempotencyKey) as ActionRow | undefined;
    if (existing !== undefined) {
      if (existing.request_digest !== parsed.requestDigest) {
        throw new DomainError(
          "action_idempotency_conflict",
          "The action idempotency key was already used for different input",
          409,
        );
      }
      return this.#hydrateAction(existing);
    }
    const event = this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO actions
             (id, kind, principal_json, group_id, member_id, run_id, generation, daemon_epoch,
              reporter_session_id, reporter_id, reporter_epoch, native_session_id,
              baseline_status_revision, baseline_completion_revision, message_id,
              conversation_id, reply_to_action_id, causation_id, idempotency_key,
              request_digest, prompt, allow_working, state, queue_deadline_at,
              acceptance_deadline_at, completion_deadline_at, accepted_provider_turn_id,
              accepted_provider_request_id, result_json, error_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.kind,
          JSON.stringify(parsed.principal),
          parsed.target.groupId,
          parsed.target.memberId,
          parsed.target.runId,
          parsed.target.generation,
          parsed.target.daemonEpoch,
          parsed.target.reporterSessionId,
          parsed.target.reporterId,
          parsed.target.reporterEpoch,
          parsed.target.nativeSessionId ?? null,
          parsed.target.baselineStatusRevision,
          parsed.target.baselineCompletionRevision,
          parsed.messageId ?? null,
          parsed.conversationId ?? null,
          parsed.replyToActionId ?? null,
          parsed.causationId ?? null,
          parsed.idempotencyKey,
          parsed.requestDigest,
          parsed.prompt ?? null,
          parsed.allowWorking ? 1 : 0,
          parsed.state,
          parsed.queueDeadlineAt,
          parsed.acceptanceDeadlineAt ?? null,
          parsed.completionDeadlineAt ?? null,
          parsed.acceptedProviderTurnId ?? null,
          parsed.acceptedProviderRequestId ?? null,
          parsed.result === undefined ? null : JSON.stringify(parsed.result),
          parsed.error === undefined ? null : JSON.stringify(parsed.error),
          parsed.createdAt,
          parsed.updatedAt,
        );
      return this.#appendEvent("agent-action.created", "agent-action", parsed.id, {
        groupId: parsed.target.groupId,
        memberId: parsed.target.memberId,
        state: parsed.state,
      });
    });
    this.#publish(event);
    return parsed;
  }

  public getAgentAction(actionId: string): AgentAction {
    const row = this.#database.prepare("SELECT * FROM actions WHERE id = ?").get(actionId) as
      | ActionRow
      | undefined;
    if (row === undefined)
      throw new DomainError("agent_action_not_found", "Agent action not found", 404);
    return this.#hydrateAction(row);
  }

  public listAgentActions(groupId?: string): AgentAction[] {
    const rows = (groupId === undefined
      ? this.#database.prepare("SELECT * FROM actions ORDER BY created_at, id").all()
      : this.#database
          .prepare("SELECT * FROM actions WHERE group_id = ? ORDER BY created_at, id")
          .all(groupId)) as unknown as ActionRow[];
    return rows.map((row) => this.#hydrateAction(row));
  }

  public listActionAttempts(actionId?: string): AgentActionAttempt[] {
    const rows = (actionId === undefined
      ? this.#database.prepare("SELECT * FROM action_attempts ORDER BY created_at, id").all()
      : this.#database
          .prepare("SELECT * FROM action_attempts WHERE action_id = ? ORDER BY attempt")
          .all(actionId)) as unknown as ActionAttemptRow[];
    return rows.map((row) => this.#hydrateActionAttempt(row));
  }

  public listActionAcknowledgements(actionId?: string): AgentActionAcknowledgement[] {
    const rows = (actionId === undefined
      ? this.#database
          .prepare("SELECT * FROM action_acknowledgements ORDER BY acknowledged_at, id")
          .all()
      : this.#database
          .prepare(
            "SELECT * FROM action_acknowledgements WHERE action_id = ? ORDER BY acknowledged_at, id",
          )
          .all(actionId)) as unknown as ActionAcknowledgementRow[];
    return rows.map((row) => this.#hydrateActionAcknowledgement(row));
  }

  public beginAgentActionAttempt(attempt: AgentActionAttempt): AgentActionAttempt {
    const parsed = AgentActionAttemptSchema.parse(attempt);
    const event = this.#transaction(() => {
      const action = this.getAgentAction(parsed.actionId);
      const run = this.getActiveRun(action.target.groupId, action.target.memberId);
      const reporter = this.getCurrentReporterSession(
        action.target.runId,
        action.target.generation,
      );
      const status = this.getAgentStatus(action.target.groupId, action.target.memberId);
      if (
        !["created", "deferred"].includes(action.state) ||
        run?.id !== action.target.runId ||
        run.generation !== action.target.generation ||
        parsed.runId !== action.target.runId ||
        parsed.generation !== action.target.generation ||
        parsed.daemonEpoch !== action.target.daemonEpoch ||
        parsed.reporterSessionId !== action.target.reporterSessionId ||
        parsed.reporterId !== action.target.reporterId ||
        parsed.reporterEpoch !== action.target.reporterEpoch ||
        reporter?.id !== action.target.reporterSessionId ||
        reporter.reporterEpoch !== action.target.reporterEpoch ||
        JSON.stringify(run.terminal) !== JSON.stringify(parsed.terminalBinding) ||
        parsed.baselineStatusRevision !== status.statusRevision ||
        parsed.baselineCompletionRevision !== status.completionRevision
      ) {
        throw new DomainError(
          "agent_action_target_replaced",
          "The exact action target is no longer authoritative",
          409,
        );
      }
      if (
        this.listActionAttempts(action.id).some((candidate) => candidate.state === "submitting")
      ) {
        throw new DomainError(
          "agent_action_ambiguous_attempt",
          "An action attempt may already have written to the provider",
          409,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO action_attempts
             (id, action_id, attempt, effect, state, daemon_epoch, group_id, member_id,
              run_id, generation, reporter_session_id, reporter_id, reporter_epoch,
              native_session_id, baseline_status_revision, baseline_completion_revision,
              terminal_binding_json, terminal_binding_fingerprint, provider_turn_id,
              provider_request_id, lease_owner, lease_expires_at, created_at, updated_at,
              submitted_at, failure_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.actionId,
          parsed.attempt,
          parsed.effect,
          parsed.state,
          parsed.daemonEpoch,
          parsed.groupId,
          parsed.memberId,
          parsed.runId,
          parsed.generation,
          parsed.reporterSessionId,
          parsed.reporterId,
          parsed.reporterEpoch,
          parsed.nativeSessionId ?? null,
          parsed.baselineStatusRevision,
          parsed.baselineCompletionRevision,
          JSON.stringify(parsed.terminalBinding),
          parsed.terminalBindingFingerprint,
          parsed.providerTurnId ?? null,
          parsed.providerRequestId ?? null,
          parsed.leaseOwner,
          parsed.leaseExpiresAt,
          parsed.createdAt,
          parsed.updatedAt,
          parsed.submittedAt ?? null,
          parsed.failureCode ?? null,
        );
      return this.#appendEvent("agent-action.attempt-started", "agent-action", parsed.actionId, {
        attemptId: parsed.id,
        state: parsed.state,
      });
    });
    this.#publish(event);
    return parsed;
  }

  public markAgentActionSubmitted(
    actionId: string,
    attemptId: string,
    leaseOwner: string,
  ): AgentAction {
    const timestamp = new Date().toISOString();
    const completed = this.#transaction(() => {
      const attempt = this.#database
        .prepare("SELECT * FROM action_attempts WHERE id = ? AND action_id = ?")
        .get(attemptId, actionId) as ActionAttemptRow | undefined;
      if (
        attempt === undefined ||
        attempt.state !== "submitting" ||
        attempt.lease_owner !== leaseOwner
      ) {
        throw new DomainError(
          "agent_action_attempt_fenced",
          "The action attempt lease is no longer current",
          409,
        );
      }
      const action = this.getAgentAction(actionId);
      const run = this.getActiveRun(action.target.groupId, action.target.memberId);
      if (
        run?.id !== attempt.run_id ||
        run.generation !== attempt.generation ||
        JSON.stringify(run.terminal) !== attempt.terminal_binding_json
      ) {
        throw new DomainError(
          "agent_action_target_replaced",
          "The action target changed during submission",
          409,
        );
      }
      this.#database
        .prepare(
          "UPDATE action_attempts SET state = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(timestamp, timestamp, attemptId);
      this.#database
        .prepare("UPDATE actions SET state = 'submitted', updated_at = ? WHERE id = ?")
        .run(timestamp, actionId);
      const result = this.getAgentAction(actionId);
      return {
        result,
        event: this.#appendEvent("agent-action.submitted", "agent-action", actionId, {
          attemptId,
          state: "submitted",
          transportEvidence: "terminal_injected",
        }),
      };
    });
    this.#publish(completed.event);
    return completed.result;
  }

  public failAgentActionAttempt(
    actionId: string,
    attemptId: string,
    leaseOwner: string,
    state: "failed" | "stalled" | "superseded" | "rejected",
    error: { code: string; message: string; retryable: boolean },
  ): AgentAction {
    const timestamp = new Date().toISOString();
    const completed = this.#transaction(() => {
      const attempt = this.#database
        .prepare("SELECT * FROM action_attempts WHERE id = ? AND action_id = ?")
        .get(attemptId, actionId) as ActionAttemptRow | undefined;
      if (
        attempt === undefined ||
        attempt.state !== "submitting" ||
        attempt.lease_owner !== leaseOwner
      ) {
        throw new DomainError(
          "agent_action_attempt_fenced",
          "The action attempt lease is no longer current",
          409,
        );
      }
      this.#database
        .prepare(
          "UPDATE action_attempts SET state = ?, failure_code = ?, updated_at = ? WHERE id = ?",
        )
        .run(state, error.code, timestamp, attemptId);
      this.#database
        .prepare("UPDATE actions SET state = ?, error_json = ?, updated_at = ? WHERE id = ?")
        .run(state, JSON.stringify(error), timestamp, actionId);
      const result = this.getAgentAction(actionId);
      return {
        result,
        event: this.#appendEvent(`agent-action.${state}`, "agent-action", actionId, {
          attemptId,
          state,
          error,
        }),
      };
    });
    this.#publish(completed.event);
    return completed.result;
  }

  public transitionAgentAction(
    actionId: string,
    expectedStates: AgentAction["state"][],
    state: AgentAction["state"],
    options: {
      error?: AgentAction["error"];
      result?: Record<string, unknown>;
      acceptedProviderTurnId?: string;
      acceptedProviderRequestId?: string;
    } = {},
  ): AgentAction {
    const current = this.getAgentAction(actionId);
    if (!expectedStates.includes(current.state)) {
      throw new DomainError(
        "agent_action_state_conflict",
        `Cannot transition action from ${current.state} to ${state}`,
        409,
      );
    }
    const timestamp = new Date().toISOString();
    const completed = this.#transaction(() => {
      this.#database
        .prepare(
          `UPDATE actions SET state = ?, error_json = ?, result_json = ?,
             accepted_provider_turn_id = COALESCE(?, accepted_provider_turn_id),
             accepted_provider_request_id = COALESCE(?, accepted_provider_request_id),
             updated_at = ? WHERE id = ? AND state = ?`,
        )
        .run(
          state,
          options.error === undefined ? null : JSON.stringify(options.error),
          options.result === undefined ? null : JSON.stringify(options.result),
          options.acceptedProviderTurnId ?? null,
          options.acceptedProviderRequestId ?? null,
          timestamp,
          actionId,
          current.state,
        );
      const result = this.getAgentAction(actionId);
      return {
        result,
        event: this.#appendEvent(`agent-action.${state}`, "agent-action", actionId, { state }),
      };
    });
    this.#publish(completed.event);
    return completed.result;
  }

  public recoverAmbiguousActionAttempts(now: Date): AgentAction[] {
    const rows = this.#database
      .prepare(
        `SELECT DISTINCT a.id FROM actions a
         JOIN action_attempts aa ON aa.action_id = a.id
         WHERE aa.state = 'submitting' AND aa.lease_expires_at <= ?
           AND a.state IN ('created', 'deferred')`,
      )
      .all(now.toISOString()) as Array<{ id: string }>;
    return rows.map((row) =>
      this.transitionAgentAction(row.id, ["created", "deferred"], "settled-unverified", {
        error: {
          code: "submission_crash_window",
          message: "Submission may have reached the provider before durable confirmation",
          retryable: false,
        },
      }),
    );
  }

  public recordAgentActionAcknowledgement(
    acknowledgement: AgentActionAcknowledgement,
  ): AgentAction {
    const parsed = AgentActionAcknowledgementSchema.parse(acknowledgement);
    const completed = this.#transaction(() => {
      const action = this.getAgentAction(parsed.actionId);
      const attempt = this.listActionAttempts(action.id).find(
        (item) => item.id === parsed.attemptId,
      );
      const reporter = this.getCurrentReporterSession(parsed.runId, parsed.generation);
      const status = this.getAgentStatus(action.target.groupId, action.target.memberId);
      if (
        attempt?.state !== "submitted" ||
        !["submitted", "accepted", "started", "blocked"].includes(action.state) ||
        parsed.runId !== action.target.runId ||
        parsed.generation !== action.target.generation ||
        parsed.reporterSessionId !== action.target.reporterSessionId ||
        parsed.reporterId !== action.target.reporterId ||
        parsed.reporterEpoch !== action.target.reporterEpoch ||
        reporter?.id !== parsed.reporterSessionId ||
        reporter.reporterEpoch !== parsed.reporterEpoch ||
        parsed.sourceSequence <= reporter.sourceSequence ||
        (action.target.nativeSessionId !== undefined &&
          parsed.nativeSessionId !== action.target.nativeSessionId)
      ) {
        throw new DomainError(
          "agent_action_ack_fenced",
          "The acknowledgement does not match the current exact action target",
          409,
        );
      }
      if (
        action.acceptedProviderTurnId !== undefined &&
        parsed.providerTurnId !== action.acceptedProviderTurnId
      ) {
        throw new DomainError(
          "agent_action_ack_correlation_mismatch",
          "The acknowledgement provider turn does not match accepted work",
          409,
        );
      }
      if (
        parsed.kind === "completed" &&
        parsed.completionRevision <= attempt.baselineCompletionRevision
      ) {
        throw new DomainError(
          "agent_action_completion_revision_stale",
          "Completion must advance beyond the action baseline",
          409,
        );
      }
      if (parsed.completionRevision > status.completionRevision) {
        throw new DomainError(
          "agent_action_completion_revision_future",
          "Acknowledgement completion revision is not durable in status",
          409,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO action_acknowledgements
             (id, action_id, attempt_id, kind, run_id, generation, reporter_session_id,
              reporter_id, reporter_epoch, source_sequence, native_session_id,
              provider_turn_id, provider_request_id, completion_revision,
              acknowledged_at, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.actionId,
          parsed.attemptId,
          parsed.kind,
          parsed.runId,
          parsed.generation,
          parsed.reporterSessionId,
          parsed.reporterId,
          parsed.reporterEpoch,
          parsed.sourceSequence,
          parsed.nativeSessionId ?? null,
          parsed.providerTurnId ?? null,
          parsed.providerRequestId ?? null,
          parsed.completionRevision,
          parsed.acknowledgedAt,
          JSON.stringify(parsed.data),
        );
      this.#database
        .prepare("UPDATE reporter_sessions SET source_sequence = ? WHERE id = ?")
        .run(parsed.sourceSequence, parsed.reporterSessionId);
      const nextState = parsed.kind;
      this.#database
        .prepare(
          `UPDATE actions SET state = ?,
             accepted_provider_turn_id = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_provider_turn_id END,
             accepted_provider_request_id = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_provider_request_id END,
             result_json = CASE WHEN ? IN ('completed', 'settled-unverified') THEN ? ELSE result_json END,
             error_json = CASE WHEN ? = 'failed' THEN ? ELSE error_json END,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          nextState,
          parsed.kind,
          parsed.providerTurnId ?? null,
          parsed.kind,
          parsed.providerRequestId ?? null,
          parsed.kind,
          JSON.stringify(parsed.data),
          parsed.kind,
          JSON.stringify({
            code: "provider_failed",
            message: "Provider reported failure",
            retryable: false,
          }),
          parsed.acknowledgedAt,
          parsed.actionId,
        );
      const result = this.getAgentAction(parsed.actionId);
      return {
        result,
        event: this.#appendEvent(`agent-action.${parsed.kind}`, "agent-action", parsed.actionId, {
          acknowledgementId: parsed.id,
          kind: parsed.kind,
        }),
      };
    });
    this.#publish(completed.event);
    return completed.result;
  }

  public listOpenWaits(groupId?: string, memberId?: string): OpenWait[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (groupId !== undefined) {
      conditions.push("group_id = ?");
      values.push(groupId);
    }
    if (memberId !== undefined) {
      conditions.push("member_id = ?");
      values.push(memberId);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#database
      .prepare(`SELECT * FROM open_waits ${where} ORDER BY opened_at, id`)
      .all(...values) as unknown as OpenWaitRow[];
    return rows.map((row) => this.#hydrateOpenWait(row));
  }

  public getOpenWait(waitId: string): OpenWait {
    const row = this.#database.prepare("SELECT * FROM open_waits WHERE id = ?").get(waitId) as
      | OpenWaitRow
      | undefined;
    if (row === undefined) throw new DomainError("open_wait_not_found", "Open wait not found", 404);
    return this.#hydrateOpenWait(row);
  }

  public beginOpenWaitReply(
    waitId: string,
    expected: { runId: string; generation: number; reporterEpoch: string; statusRevision: number },
  ): OpenWait {
    const wait = this.getOpenWait(waitId);
    const status = this.getAgentStatus(wait.groupId, wait.memberId);
    const reporter = this.getCurrentReporterSession(wait.runId, wait.generation);
    if (
      wait.state !== "open" ||
      wait.runId !== expected.runId ||
      wait.generation !== expected.generation ||
      wait.reporterEpoch !== expected.reporterEpoch ||
      status.runId !== wait.runId ||
      status.generation !== wait.generation ||
      expected.statusRevision !== wait.openedStatusRevision ||
      status.statusRevision < wait.openedStatusRevision ||
      status.openWait?.requestId !== wait.providerRequestId ||
      reporter?.id !== wait.reporterSessionId ||
      reporter.reporterEpoch !== wait.reporterEpoch
    ) {
      throw new DomainError(
        "open_wait_replaced",
        "The exact provider wait is closed, stale, or replaced",
        409,
      );
    }
    const timestamp = new Date().toISOString();
    this.#database
      .prepare(
        "UPDATE open_waits SET state = 'replying', updated_at = ? WHERE id = ? AND state = 'open'",
      )
      .run(timestamp, waitId);
    return this.getOpenWait(waitId);
  }

  public resetOpenWaitReply(waitId: string): OpenWait {
    const timestamp = new Date().toISOString();
    this.#database
      .prepare(
        "UPDATE open_waits SET state = 'open', updated_at = ? WHERE id = ? AND state = 'replying'",
      )
      .run(timestamp, waitId);
    return this.getOpenWait(waitId);
  }

  public pruneAgentActions(groupId: string, retain: number): number {
    if (!Number.isInteger(retain) || retain < 0) {
      throw new DomainError(
        "invalid_action_retention",
        "Action retention must be nonnegative",
        400,
      );
    }
    const victims = this.#database
      .prepare(
        `SELECT id FROM actions WHERE group_id = ?
         AND state IN ('completed', 'settled-unverified', 'failed', 'stalled', 'timed-out',
                       'cancelled', 'expired', 'superseded', 'rejected')
         AND NOT EXISTS (
           SELECT 1 FROM open_waits ow WHERE ow.action_id = actions.id
             AND ow.state IN ('open', 'replying')
         )
         ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?`,
      )
      .all(groupId, retain) as Array<{ id: string }>;
    for (const victim of victims) {
      this.#database
        .prepare("UPDATE actions SET reply_to_action_id = NULL WHERE reply_to_action_id = ?")
        .run(victim.id);
      this.#database.prepare("DELETE FROM actions WHERE id = ?").run(victim.id);
    }
    return victims.length;
  }

  public listEvents(afterSequence = 0): DomainEvent[] {
    return this.listEventPage(afterSequence, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  }

  public eventBounds(): { earliestAvailable: number; highWater: number } {
    const row = this.#database
      .prepare(
        `SELECT COALESCE(MIN(sequence), 0) AS earliest_available,
                COALESCE(MAX(sequence), 0) AS high_water
         FROM domain_events`,
      )
      .get() as { earliest_available: number; high_water: number };
    return { earliestAvailable: row.earliest_available, highWater: row.high_water };
  }

  public listEventPage(
    afterSequence: number,
    throughSequence: number,
    limit: number,
  ): DomainEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new DomainError("invalid_event_page_limit", "Event page limit must be positive", 400);
    }
    const boundedLimit = Math.min(limit, 1_000);
    const rows = this.#database
      .prepare(
        `SELECT sequence, id, type, aggregate_type, aggregate_id, occurred_at, payload_json
         FROM domain_events
         WHERE sequence > ? AND sequence <= ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(afterSequence, throughSequence, boundedLimit) as unknown as EventRow[];
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
            content_digest, expires_at, deleted_at, deletion_audit_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
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
        value.contentDigest,
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
        contentDigest: row.content_digest,
        expiresAt: row.expires_at,
      }),
    );
  }

  public listTerminalCheckpointOwners(): string[] {
    const rows = this.#database
      .prepare(
        `SELECT DISTINCT owner_principal_id
         FROM terminal_checkpoints
         WHERE deleted_at IS NULL
         ORDER BY owner_principal_id`,
      )
      .all() as Array<{ owner_principal_id: string }>;
    return rows.map((row) => row.owner_principal_id);
  }

  public deleteTerminalCheckpoint(ownerPrincipalId: string, checkpointId: string): boolean {
    return this.#finalizeTerminalCheckpointDeletion(ownerPrincipalId, checkpointId, false);
  }

  public reconcileDestroyedTerminalCheckpoint(
    ownerPrincipalId: string,
    checkpointId: string,
  ): boolean {
    return this.#finalizeTerminalCheckpointDeletion(ownerPrincipalId, checkpointId, true);
  }

  #finalizeTerminalCheckpointDeletion(
    ownerPrincipalId: string,
    checkpointId: string,
    reconciled: boolean,
  ): boolean {
    const occurredAt = new Date().toISOString();
    return this.#transaction(() => {
      const checkpoint = this.#database
        .prepare(
          `SELECT id, deleted_at FROM terminal_checkpoints
           WHERE id = ? AND owner_principal_id = ?`,
        )
        .get(checkpointId, ownerPrincipalId) as
        | { id: string; deleted_at: string | null }
        | undefined;
      if (checkpoint === undefined) return false;
      if (checkpoint.deleted_at !== null) return reconciled;
      const auditId = `audit_${randomUUID()}`;
      this.#database
        .prepare(
          `INSERT INTO audits
             (id, principal_id, action, resource_type, resource_id, metadata_json, occurred_at)
           VALUES (?, ?, 'terminal-checkpoint.delete', 'terminal-checkpoint', ?, ?, ?)`,
        )
        .run(
          auditId,
          ownerPrincipalId,
          checkpointId,
          JSON.stringify({ contentDestroyed: true, reconciled }),
          occurredAt,
        );
      const updated = this.#database
        .prepare(
          `UPDATE terminal_checkpoints
           SET deleted_at = ?, deletion_audit_id = ?
           WHERE id = ? AND owner_principal_id = ? AND deleted_at IS NULL`,
        )
        .run(occurredAt, auditId, checkpointId, ownerPrincipalId);
      return updated.changes === 1;
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

  public claimHttpIdempotency(input: {
    principalId: string;
    routeId: string;
    key: string;
    requestDigest: string;
    now?: Date;
    inProgressTtlMs?: number;
  }): HttpIdempotencyClaim {
    const now = input.now ?? new Date();
    const nowText = now.toISOString();
    return this.#transaction(() => {
      this.#database
        .prepare(
          `DELETE FROM http_idempotency_keys
           WHERE state = 'completed' AND expires_at <= ?`,
        )
        .run(nowText);
      const existing = this.#database
        .prepare(
          `SELECT request_digest, response_json, state, status_code
           FROM http_idempotency_keys
           WHERE principal_id = ? AND route_id = ? AND key = ?`,
        )
        .get(input.principalId, input.routeId, input.key) as
        | {
            request_digest: string | null;
            response_json: string;
            state: "in-progress" | "completed";
            status_code: number | null;
          }
        | undefined;
      if (existing !== undefined) {
        if (existing.request_digest !== input.requestDigest) {
          throw new DomainError(
            "idempotency_request_conflict",
            "The idempotency key was already used for different request content",
            409,
          );
        }
        if (existing.state === "in-progress") {
          throw new DomainError(
            "idempotency_outcome_uncertain",
            "The prior request outcome is uncertain and requires domain reconciliation",
            409,
          );
        }
        if (existing.status_code === null) {
          throw new DomainError(
            "idempotency_result_invalid",
            "The retained idempotency result is incomplete",
            500,
          );
        }
        return {
          kind: "replay",
          statusCode: existing.status_code,
          response: JSON.parse(existing.response_json),
        };
      }
      this.#database
        .prepare(
          `INSERT INTO http_idempotency_keys
             (principal_id, route_id, key, request_digest, state, status_code,
              response_json, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, 'in-progress', NULL, 'null', ?, ?, ?)`,
        )
        .run(
          input.principalId,
          input.routeId,
          input.key,
          input.requestDigest,
          nowText,
          nowText,
          new Date(now.getTime() + (input.inProgressTtlMs ?? 5 * 60_000)).toISOString(),
        );
      return { kind: "execute" };
    });
  }

  public completeHttpIdempotency(input: {
    principalId: string;
    routeId: string;
    key: string;
    requestDigest: string;
    statusCode: number;
    response: unknown;
    now?: Date;
    retentionMs?: number;
  }): void {
    if (input.statusCode < 200 || input.statusCode >= 500) {
      throw new Error("Only completed responses and deterministic 4xx outcomes may be retained");
    }
    const now = input.now ?? new Date();
    const result = this.#database
      .prepare(
        `UPDATE http_idempotency_keys
         SET response_json = ?, state = 'completed', status_code = ?, updated_at = ?, expires_at = ?
         WHERE principal_id = ? AND route_id = ? AND key = ?
           AND request_digest = ? AND state = 'in-progress'`,
      )
      .run(
        JSON.stringify(input.response ?? null),
        input.statusCode,
        now.toISOString(),
        new Date(now.getTime() + (input.retentionMs ?? 24 * 60 * 60_000)).toISOString(),
        input.principalId,
        input.routeId,
        input.key,
        input.requestDigest,
      );
    if (result.changes !== 1) {
      throw new DomainError(
        "idempotency_completion_conflict",
        "The in-progress idempotency reservation was lost",
        409,
      );
    }
  }

  public executeHttpIdempotency(
    input: {
      principalId: string;
      routeId: string;
      key: string;
      requestDigest: string;
    },
    operation: () => { statusCode: number; response: unknown },
  ): HttpIdempotencyExecution {
    return this.#transaction(() => {
      const claim = this.claimHttpIdempotency(input);
      if (claim.kind === "replay") return claim;
      const outcome = operation();
      if (
        outcome !== null &&
        typeof outcome === "object" &&
        "then" in outcome &&
        typeof (outcome as { then?: unknown }).then === "function"
      ) {
        throw new Error("Transactional HTTP idempotency handlers must be synchronous");
      }
      this.completeHttpIdempotency({ ...input, ...outcome });
      return { kind: "executed", ...outcome };
    });
  }

  public upsertProviderState(binding: ProviderStateBinding): ProviderStateBinding {
    const parsed = ProviderStateBindingSchema.parse(binding);
    this.#database
      .prepare(
        `INSERT INTO provider_state
           (id, integration_id, member_id, scope, storage_reference,
            credential_reference_json, lifecycle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           storage_reference = excluded.storage_reference,
           credential_reference_json = excluded.credential_reference_json,
           lifecycle = excluded.lifecycle,
           updated_at = excluded.updated_at`,
      )
      .run(
        parsed.id,
        parsed.integrationId,
        parsed.memberId ?? null,
        parsed.scope,
        parsed.storageReference,
        JSON.stringify(parsed.credentialReference),
        parsed.lifecycle,
        parsed.createdAt,
        parsed.updatedAt,
      );
    return this.getProviderState(parsed.id)!;
  }

  public getProviderState(bindingId: string): ProviderStateBinding | undefined {
    const row = this.#database
      .prepare("SELECT * FROM provider_state WHERE id = ?")
      .get(bindingId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#hydrateProviderState(row);
  }

  public listProviderStates(): readonly ProviderStateBinding[] {
    return Object.freeze(
      (
        this.#database
          .prepare("SELECT * FROM provider_state ORDER BY created_at, id")
          .all() as Record<string, unknown>[]
      ).map((row) => this.#hydrateProviderState(row)),
    );
  }

  public setProviderStateLifecycle(
    bindingId: string,
    lifecycle: ProviderStateBinding["lifecycle"],
  ): ProviderStateBinding {
    const updatedAt = new Date().toISOString();
    const result = this.#database
      .prepare("UPDATE provider_state SET lifecycle = ?, updated_at = ? WHERE id = ?")
      .run(lifecycle, updatedAt, bindingId);
    if (result.changes !== 1)
      throw new DomainError("provider_state_not_found", "Provider state binding not found", 404);
    return this.getProviderState(bindingId)!;
  }

  public saveNativeSession(session: DurableNativeSession): DurableNativeSession {
    const parsed = DurableNativeSessionSchema.parse(session);
    this.#database
      .prepare(
        `INSERT INTO native_sessions
           (id, member_id, integration_id, provider_kind, source, ref_kind, ref_value,
            dedupe_hash, observed_model, run_id, generation, status, reported_at, last_resumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           run_id = excluded.run_id, generation = excluded.generation,
           observed_model = excluded.observed_model, status = excluded.status,
           reported_at = excluded.reported_at, last_resumed_at = excluded.last_resumed_at`,
      )
      .run(
        parsed.id,
        parsed.memberId,
        parsed.integrationId,
        parsed.provider,
        parsed.source,
        parsed.referenceKind,
        parsed.referenceValue,
        parsed.dedupeHash,
        parsed.effectiveModel ?? null,
        parsed.runId,
        parsed.generation,
        parsed.status,
        parsed.reportedAt,
        parsed.lastResumedAt ?? null,
      );
    return this.latestNativeSession(parsed.memberId, parsed.integrationId)!;
  }

  public latestNativeSession(
    memberId: string,
    integrationId: string,
  ): DurableNativeSession | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM native_sessions
         WHERE member_id = ? AND integration_id = ?
         ORDER BY reported_at DESC, id DESC LIMIT 1`,
      )
      .get(memberId, integrationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#hydrateNativeSession(row);
  }

  public reservedNativeSession(
    memberId: string,
    integrationId: string,
  ): DurableNativeSession | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM native_sessions
         WHERE member_id = ? AND integration_id = ? AND status = 'reserved'
         ORDER BY reserved_at DESC, id DESC LIMIT 1`,
      )
      .get(memberId, integrationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#hydrateNativeSession(row);
  }

  public reserveNativeSession(sessionId: string, resumeRunId: string, reservedAt: string): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE native_sessions
           SET status = 'reserved', resume_run_id = ?, reserved_at = ?
           WHERE id = ? AND status IN ('ready', 'resumed')`,
        )
        .run(resumeRunId, reservedAt, sessionId).changes === 1
    );
  }

  public confirmNativeSession(
    sessionId: string,
    resumeRunId: string,
    confirmedAt: string,
  ): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE native_sessions
            SET status = 'resumed', last_resumed_at = ?, resume_run_id = ?
            WHERE id = ? AND status IN ('reserved', 'resumed')`,
        )
        .run(confirmedAt, resumeRunId, sessionId).changes === 1
    );
  }

  public invalidateNativeSession(sessionId: string): void {
    this.#database
      .prepare("UPDATE native_sessions SET status = 'invalid' WHERE id = ?")
      .run(sessionId);
  }

  public isNativeSessionConfirmed(sessionId: string, resumeRunId: string): boolean {
    return (
      this.#database
        .prepare(
          "SELECT 1 FROM native_sessions WHERE id = ? AND resume_run_id = ? AND status = 'resumed'",
        )
        .get(sessionId, resumeRunId) !== undefined
    );
  }

  public findRepositoryTrust(
    repositoryIdentity: string,
    subjectDigest: string,
  ): RepositoryTrustReceipt | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM trust
         WHERE repository_identity = ? AND subject_digest = ?
         ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
      )
      .get(repositoryIdentity, subjectDigest) as Record<string, unknown> | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          repositoryIdentity,
          subjectDigest,
          principalId: String(row.principal_id),
          decision: row.decision as RepositoryTrustReceipt["decision"],
          decidedAt: String(row.decided_at),
          ...(row.revoked_at === null ? {} : { revokedAt: String(row.revoked_at) }),
        };
  }

  public listRepositoryTrust(): RepositoryTrustReceipt[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM trust
           ORDER BY decided_at DESC, rowid DESC`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      repositoryIdentity: String(row.repository_identity),
      subjectDigest: String(row.subject_digest),
      principalId: String(row.principal_id),
      decision: row.decision as RepositoryTrustReceipt["decision"],
      decidedAt: String(row.decided_at),
      ...(row.revoked_at === null ? {} : { revokedAt: String(row.revoked_at) }),
    }));
  }

  public saveRepositoryTrust(receipt: RepositoryTrustReceipt): RepositoryTrustReceipt {
    this.#database
      .prepare(
        `INSERT INTO trust
           (id, repository_id, repository_identity, principal_id, subject_digest, decision, decided_at, revoked_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.id,
        receipt.repositoryIdentity,
        receipt.principalId,
        receipt.subjectDigest,
        receipt.decision,
        receipt.decidedAt,
        receipt.revokedAt ?? null,
      );
    return receipt;
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

  public getSnapshot(
    authority: { instanceId: string; daemonEpoch: number } = {
      instanceId: this.#instanceId,
      daemonEpoch: this.#daemonEpoch,
    },
  ): PortalSnapshot {
    return this.#readTransaction(() => {
      const groups = (
        this.#database
          .prepare("SELECT * FROM groups ORDER BY order_index, id")
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
          .prepare(
            `SELECT m.* FROM memberships m JOIN groups g ON g.id = m.group_id
             WHERE m.state = 'active' ORDER BY g.order_index, m.order_index, m.id`,
          )
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
             WHERE m.agent_profile_id = r.agent_profile_id
               AND m.state = 'active'
           )
           ORDER BY r.started_at, r.id`,
          )
          .all() as unknown as RunRow[]
      ).map((row) => this.#hydrateRun(row));
      const repositories = this.listRepositories();
      const checkouts = this.listCheckouts();
      const worktrees = this.listWorktrees();
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
        instanceId: authority.instanceId,
        daemonEpoch: authority.daemonEpoch,
        sequence: sequenceRow.sequence,
        generatedAt: new Date().toISOString(),
        orderRevision: this.getOrderRevision(),
        groups,
        agentProfiles,
        memberships,
        runs,
        repositories,
        checkouts,
        worktrees,
        agentStatuses,
        messages,
        deliveryOutcomes,
        messageGroups,
        ...(this.#config === undefined ? {} : { config: this.#config }),
        ...(this.#configStatus === undefined ? {} : { configStatus: this.#configStatus }),
      });
    });
  }

  #executeIdempotent<T>(
    scope: string,
    idempotencyKey: string | undefined,
    schema: Parser<T>,
    operation: () => CommandResult<T>,
    requestDigest?: string,
  ): T {
    if (idempotencyKey !== undefined) {
      const existing = this.#database
        .prepare(
          `SELECT request_digest, response_json, invalidated_at
           FROM idempotency_keys WHERE scope = ? AND key = ?`,
        )
        .get(scope, idempotencyKey) as
        | { request_digest: string | null; response_json: string; invalidated_at: string | null }
        | undefined;
      if (existing !== undefined) {
        if (existing.invalidated_at !== null) {
          throw new DomainError(
            "idempotency_result_expired",
            "The original idempotent result expired with retained message history; use a new key",
            410,
          );
        }
        if (requestDigest !== undefined && existing.request_digest !== requestDigest) {
          throw new DomainError(
            "idempotency_request_conflict",
            "The idempotency key was already used for different request content",
            409,
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
            `INSERT INTO idempotency_keys
               (scope, key, request_digest, response_json, event_sequence, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            scope,
            idempotencyKey,
            requestDigest ?? null,
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

  #deriveMessageCausation(
    groupId: string,
    command: SubmitMessageCommand,
    recipients: string[],
  ): Pick<Message, "conversationId" | "replyTo" | "rootId" | "causationId" | "hop"> {
    const edgeIds = [
      ...new Set([command.replyTo, command.causationId].filter(Boolean)),
    ] as string[];
    const parents = edgeIds.map((id) => {
      const row = this.#database.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
        | MessageRow
        | undefined;
      if (row === undefined || row.group_id !== groupId) {
        throw new DomainError(
          "message_causation_invalid",
          "Reply and causation messages must exist in the same group",
          409,
        );
      }
      if (command.sender.kind === "agent") {
        const visible = this.#database
          .prepare(
            "SELECT 1 FROM deliveries WHERE message_id = ? AND recipient_member_id = ? LIMIT 1",
          )
          .get(row.id, command.sender.memberId);
        if (
          visible === undefined &&
          JSON.parse(row.sender_json).memberId !== command.sender.memberId
        ) {
          throw new DomainError(
            "message_causation_forbidden",
            "Agent senders may only reply to messages visible to their identity",
            403,
          );
        }
      }
      return this.#hydrateMessage(row);
    });
    const conversationIds = new Set(parents.map((parent) => parent.conversationId));
    if (conversationIds.size > 1) {
      throw new DomainError(
        "message_conversation_mismatch",
        "Reply and causation edges must belong to one conversation",
        409,
      );
    }
    const inheritedConversationId = parents[0]?.conversationId;
    if (
      inheritedConversationId !== undefined &&
      command.conversationId !== undefined &&
      command.conversationId !== inheritedConversationId
    ) {
      throw new DomainError(
        "message_conversation_mismatch",
        "The requested conversation does not match its causal parent",
        409,
      );
    }
    const conversationId =
      inheritedConversationId ?? command.conversationId ?? `conv_${randomUUID()}`;
    const hop = parents.length === 0 ? 0 : Math.max(...parents.map((parent) => parent.hop)) + 1;
    if (hop > MAX_MESSAGE_CAUSAL_DEPTH) {
      throw new DomainError(
        "message_causal_depth_exceeded",
        `Message causal depth exceeds the ${MAX_MESSAGE_CAUSAL_DEPTH}-hop limit`,
        409,
      );
    }
    if (command.sender.kind === "agent") {
      const automated = this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM messages
           WHERE group_id = ? AND conversation_id = ?
             AND json_extract(sender_json, '$.kind') = 'agent'`,
        )
        .get(groupId, conversationId) as { count: number };
      if (automated.count >= MAX_AUTOMATED_REPLIES_PER_CONVERSATION) {
        throw new DomainError(
          "message_automated_reply_budget_exhausted",
          "The conversation requires operator intervention before another automated reply",
          409,
        );
      }
    }
    const actor =
      command.sender.kind === "agent"
        ? `agent:${command.sender.memberId}`
        : `operator:${command.sender.operatorId}`;
    const signature = `${actor}->${[...recipients].sort().join(",")}`;
    let cursor = parents.find((parent) => parent.id === command.causationId) ?? parents[0];
    const visited = new Set<string>();
    while (cursor !== undefined) {
      if (visited.has(cursor.id)) {
        throw new DomainError(
          "message_causal_cycle",
          "The message causation graph has a cycle",
          409,
        );
      }
      visited.add(cursor.id);
      const priorRecipients = (
        this.#database
          .prepare(
            "SELECT recipient_member_id FROM deliveries WHERE message_id = ? ORDER BY recipient_member_id",
          )
          .all(cursor.id) as Array<{ recipient_member_id: string }>
      ).map((row) => row.recipient_member_id);
      const priorActor =
        cursor.sender.kind === "agent"
          ? `agent:${cursor.sender.memberId}`
          : `operator:${cursor.sender.operatorId}`;
      if (`${priorActor}->${priorRecipients.join(",")}` === signature) {
        throw new DomainError(
          "message_causal_cycle",
          "The automated actor and audience already occur in this causal chain",
          409,
        );
      }
      const nextId = cursor.causationId ?? cursor.replyTo;
      if (nextId === undefined) break;
      const row = this.#database.prepare("SELECT * FROM messages WHERE id = ?").get(nextId) as
        | MessageRow
        | undefined;
      cursor = row === undefined ? undefined : this.#hydrateMessage(row);
    }
    const root = parents[0];
    return {
      conversationId,
      ...(command.replyTo === undefined ? {} : { replyTo: command.replyTo }),
      ...(root === undefined ? {} : { rootId: root.rootId ?? root.id }),
      ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
      hop,
    };
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

  #applyOpenWaitReporterEvent(
    run: AgentRun,
    session: ReporterSession,
    input: AgentStatusEventInput,
    state: AgentStatusReducerState,
  ): void {
    if (input.event === "wait.opened") {
      if (
        input.requestId === undefined ||
        input.data.waitKind === undefined ||
        input.data.summary === undefined ||
        input.data.replyChannel === undefined
      ) {
        throw new DomainError(
          "open_wait_report_invalid",
          "The reporter wait is missing exact request metadata",
          400,
        );
      }
      if (input.actionId !== undefined) {
        const action = this.getAgentAction(input.actionId);
        if (
          action.target.runId !== run.id ||
          action.target.generation !== run.generation ||
          action.target.reporterSessionId !== session.id ||
          action.target.reporterEpoch !== session.reporterEpoch
        ) {
          throw new DomainError(
            "open_wait_action_mismatch",
            "The open wait action does not match the exact reporter target",
            409,
          );
        }
      }
      const timestamp = new Date().toISOString();
      this.#database
        .prepare(
          `INSERT INTO open_waits
             (id, action_id, group_id, member_id, run_id, generation, reporter_session_id,
              reporter_id, reporter_epoch, native_session_id, provider_request_id, kind,
              summary, reply_channel, opened_status_revision, state, expires_at, opened_at,
              updated_at, answered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL)`,
        )
        .run(
          `wait_${randomUUID()}`,
          input.actionId ?? null,
          run.groupId,
          run.memberId,
          run.id,
          run.generation,
          session.id,
          session.reporterId,
          session.reporterEpoch,
          input.nativeSessionId ?? session.nativeSessionId ?? null,
          input.requestId,
          input.data.waitKind,
          input.data.summary,
          input.data.replyChannel,
          state.statusRevision,
          timestamp,
          timestamp,
        );
      return;
    }
    if (input.event === "wait.closed") {
      if (input.requestId === undefined) {
        throw new DomainError(
          "open_wait_report_invalid",
          "The reporter wait close is missing its request identity",
          400,
        );
      }
      const timestamp = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE open_waits SET state = 'answered', answered_at = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND reporter_epoch = ?
             AND provider_request_id = ? AND state IN ('open', 'replying')`,
        )
        .run(timestamp, timestamp, run.id, run.generation, session.reporterEpoch, input.requestId);
    }
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
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           generation = excluded.generation,
           status_revision = excluded.status_revision,
           completion_revision = excluded.completion_revision,
           status_json = excluded.status_json,
           reducer_state_json = excluded.reducer_state_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        run.id,
        run.generation,
        state.statusRevision,
        state.completionRevision,
        serialized,
        serialized,
        state.observedAt,
      );
  }

  #getAgentStatusDetail(groupId: string, memberId: string, operatorId?: string): AgentStatusDetail {
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
        state: "unknown",
        phase: "startup",
        outcome: "unknown",
        confidence: "high",
        attention: "none",
        observedAt: hydratedMembership.joinedAt,
        stateChangedAt: hydratedMembership.joinedAt,
        cleanEndSeen: false,
        statusRevision: 0,
        completionRevision: 0,
        operatorAcknowledgedCompletionRevision: 0,
        completionPending: false,
        interactiveReady: false,
        staleAuthority: true,
        authorityKind: "none",
        evidenceConfidence: "high",
        processState: "missing",
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
    const statusState =
      run.status === "stopped" && !["stopped", "failed"].includes(state.state)
        ? "stopped"
        : run.status === "failed" && !["stopped", "failed"].includes(state.state)
          ? "failed"
          : state.state;
    const acknowledgement =
      operatorId === undefined
        ? undefined
        : (this.#database
            .prepare(
              `SELECT completion_revision FROM completion_acknowledgements
               WHERE operator_id = ? AND run_id = ? AND generation = ?`,
            )
            .get(operatorId, run.id, run.generation) as
            | { completion_revision: number }
            | undefined);
    const acknowledgedRevision = acknowledgement?.completion_revision ?? 0;
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
      phase: statusState === "stopped" || statusState === "failed" ? "exited" : state.phase,
      outcome: statusState === "failed" && state.outcome === "unknown" ? "failed" : state.outcome,
      confidence: state.confidence,
      attention: statusState === "failed" ? "process_failed" : state.attention,
      lastActivityAt: state.lastActivityAt,
      lastActivityKind: state.lastActivityKind,
      observedAt: state.observedAt,
      stateChangedAt: state.stateChangedAt,
      lastProgressSummary: state.lastProgressSummary,
      progressStage: state.progressStage,
      nextStep: state.nextStep,
      blocker: state.blocker,
      statusRevision: state.statusRevision,
      completionRevision: state.completionRevision,
      operatorAcknowledgedCompletionRevision: acknowledgedRevision,
      completionPending: statusState === "idle" && state.completionRevision > acknowledgedRevision,
      interactiveReady: state.interactiveReady,
      staleAuthority: state.staleAuthority,
      authorityKind: state.authorityKind,
      authorityId: state.authorityId,
      evidenceConfidence: state.confidence,
      processState: state.processState,
      processFingerprint: state.processFingerprint,
      reporterEpoch: state.reporterEpoch,
      reporterLeaseExpiresAt: state.reporterLeaseExpiresAt,
      readinessCoverage: state.readinessCoverage,
      lastScreenObservation: state.lastScreenObservation,
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
    if (this.#transactionDepth > 0) {
      this.#pendingEvents.push(event);
      return;
    }
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
      order: row.order_index,
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
      checkoutId: row.checkout_id ?? undefined,
      order: row.order_index,
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
      checkoutId: row.checkout_id ?? undefined,
      resolvedWorkingDirectory: row.resolved_working_directory ?? undefined,
      generation: row.generation,
      status: row.status,
      desiredState: row.desired_state ?? (row.status === "stopped" ? "stopped" : "running"),
      recoveryPhase: row.recovery_phase ?? "idle",
      recoveryAttempts: row.recovery_attempts ?? 0,
      recoveryNotBefore: row.recovery_not_before ?? undefined,
      recoveryReason: row.recovery_reason ?? undefined,
      launchKind: row.launch_kind,
      requestedModel: row.requested_model ?? undefined,
      requestedModelSource: row.requested_model_source,
      effectiveModel: row.effective_model ?? undefined,
      nativeSessionId: row.native_session_id ?? undefined,
      recoveryOutcome: row.recovery_outcome ?? undefined,
      terminal: row.terminal_json === null ? undefined : JSON.parse(row.terminal_json),
      startedAt: row.started_at,
      stoppedAt: row.stopped_at ?? undefined,
    });
  }

  #hydrateRepository(row: RepositoryRow): Repository {
    return RepositorySchema.parse({
      id: row.id,
      commonDirectory: row.common_directory,
      displayName: row.display_name,
      objectFormat: row.object_format,
      refStorage: row.ref_storage,
      primaryCheckoutId: row.primary_checkout_id ?? undefined,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #hydrateCheckout(row: CheckoutRow): Checkout {
    return CheckoutSchema.parse({
      id: row.id,
      repositoryId: row.repository_id,
      checkoutKey: row.checkout_key,
      path: row.path,
      gitDirectory: row.git_directory,
      kind: row.kind,
      head: row.head ?? undefined,
      branch: row.branch ?? undefined,
      dirty: row.dirty === 1,
      observedAt: row.observed_at,
    });
  }

  #hydrateWorktree(row: WorktreeRow): Worktree {
    return WorktreeSchema.parse({
      id: row.id,
      repositoryId: row.repository_id,
      checkoutId: row.checkout_id,
      sourceCheckoutId: row.source_checkout_id,
      path: row.path,
      branch: row.branch,
      base: row.base,
      provenanceToken: row.provenance_token,
      operationGeneration: row.operation_generation,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #hydrateGitOperation(row: GitOperationRow): GitOperation {
    return GitOperationSchema.parse({
      id: row.id,
      repositoryId: row.repository_id,
      checkoutId: row.checkout_id ?? undefined,
      worktreeId: row.worktree_id ?? undefined,
      kind: row.kind,
      generation: row.generation,
      targetPath: row.target_path ?? undefined,
      state: row.state,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      errorCode: row.error_code ?? undefined,
    });
  }

  #resolveRunLocation(
    membership: MembershipRow,
    configuredWorkingDirectory: string | undefined,
  ): { checkoutId?: string; workingDirectory?: string } {
    if (membership.checkout_id === null) {
      return configuredWorkingDirectory === undefined
        ? {}
        : { workingDirectory: configuredWorkingDirectory };
    }
    const checkout = this.getCheckout(membership.checkout_id);
    if (checkout.kind === "bare") {
      throw new DomainError(
        "bare_checkout_cannot_run",
        "Agents cannot run in a bare checkout",
        409,
      );
    }
    const repository = this.getRepository(checkout.repositoryId);
    const primary =
      repository.primaryCheckoutId === undefined
        ? checkout
        : this.getCheckout(repository.primaryCheckoutId);
    const relativeWorkingDirectory =
      configuredWorkingDirectory === undefined
        ? "."
        : relative(primary.path, configuredWorkingDirectory);
    if (
      relativeWorkingDirectory === ".." ||
      relativeWorkingDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relativeWorkingDirectory)
    ) {
      throw new DomainError(
        "run_working_directory_outside_checkout",
        "Configured working directory is outside the primary checkout",
        409,
      );
    }
    const candidate = resolve(checkout.path, relativeWorkingDirectory);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
      throw new DomainError(
        "run_working_directory_missing",
        "The assigned checkout working directory does not exist",
        409,
      );
    }
    const canonical = realpathSync(candidate);
    const relativeCanonical = relative(checkout.path, canonical);
    if (
      relativeCanonical === ".." ||
      relativeCanonical.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relativeCanonical)
    ) {
      throw new DomainError(
        "run_working_directory_symlink_escape",
        "The assigned checkout working directory escapes through a symlink",
        409,
      );
    }
    return { checkoutId: checkout.id, workingDirectory: canonical };
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

  #hydrateAction(row: ActionRow): AgentAction {
    return AgentActionSchema.parse({
      version: 1,
      id: row.id,
      kind: row.kind,
      principal: JSON.parse(row.principal_json),
      target: {
        groupId: row.group_id,
        memberId: row.member_id,
        runId: row.run_id,
        generation: row.generation,
        daemonEpoch: row.daemon_epoch,
        reporterSessionId: row.reporter_session_id,
        reporterId: row.reporter_id,
        reporterEpoch: row.reporter_epoch,
        nativeSessionId: row.native_session_id ?? undefined,
        baselineStatusRevision: row.baseline_status_revision,
        baselineCompletionRevision: row.baseline_completion_revision,
      },
      messageId: row.message_id ?? undefined,
      conversationId: row.conversation_id ?? undefined,
      replyToActionId: row.reply_to_action_id ?? undefined,
      causationId: row.causation_id ?? undefined,
      idempotencyKey: row.idempotency_key,
      requestDigest: row.request_digest,
      prompt: row.prompt ?? undefined,
      allowWorking: row.allow_working === 1,
      state: row.state,
      queueDeadlineAt: row.queue_deadline_at,
      acceptanceDeadlineAt: row.acceptance_deadline_at ?? undefined,
      completionDeadlineAt: row.completion_deadline_at ?? undefined,
      acceptedProviderTurnId: row.accepted_provider_turn_id ?? undefined,
      acceptedProviderRequestId: row.accepted_provider_request_id ?? undefined,
      result: row.result_json === null ? undefined : JSON.parse(row.result_json),
      error: row.error_json === null ? undefined : JSON.parse(row.error_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #hydrateActionAttempt(row: ActionAttemptRow): AgentActionAttempt {
    return AgentActionAttemptSchema.parse({
      id: row.id,
      actionId: row.action_id,
      attempt: row.attempt,
      effect: row.effect,
      state: row.state,
      daemonEpoch: row.daemon_epoch,
      groupId: row.group_id,
      memberId: row.member_id,
      runId: row.run_id,
      generation: row.generation,
      reporterSessionId: row.reporter_session_id,
      reporterId: row.reporter_id,
      reporterEpoch: row.reporter_epoch,
      nativeSessionId: row.native_session_id ?? undefined,
      baselineStatusRevision: row.baseline_status_revision,
      baselineCompletionRevision: row.baseline_completion_revision,
      terminalBinding: JSON.parse(row.terminal_binding_json),
      terminalBindingFingerprint: row.terminal_binding_fingerprint,
      providerTurnId: row.provider_turn_id ?? undefined,
      providerRequestId: row.provider_request_id ?? undefined,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      submittedAt: row.submitted_at ?? undefined,
      failureCode: row.failure_code ?? undefined,
    });
  }

  #hydrateActionAcknowledgement(row: ActionAcknowledgementRow): AgentActionAcknowledgement {
    return AgentActionAcknowledgementSchema.parse({
      id: row.id,
      actionId: row.action_id,
      attemptId: row.attempt_id,
      kind: row.kind,
      runId: row.run_id,
      generation: row.generation,
      reporterSessionId: row.reporter_session_id,
      reporterId: row.reporter_id,
      reporterEpoch: row.reporter_epoch,
      sourceSequence: row.source_sequence,
      nativeSessionId: row.native_session_id ?? undefined,
      providerTurnId: row.provider_turn_id ?? undefined,
      providerRequestId: row.provider_request_id ?? undefined,
      completionRevision: row.completion_revision,
      acknowledgedAt: row.acknowledged_at,
      data: JSON.parse(row.data_json),
    });
  }

  #hydrateOpenWait(row: OpenWaitRow): OpenWait {
    return OpenWaitSchema.parse({
      id: row.id,
      actionId: row.action_id ?? undefined,
      groupId: row.group_id,
      memberId: row.member_id,
      runId: row.run_id,
      generation: row.generation,
      reporterSessionId: row.reporter_session_id,
      reporterId: row.reporter_id,
      reporterEpoch: row.reporter_epoch,
      nativeSessionId: row.native_session_id ?? undefined,
      providerRequestId: row.provider_request_id,
      kind: row.kind,
      summary: row.summary,
      replyChannel: row.reply_channel,
      openedStatusRevision: row.opened_status_revision,
      state: row.state,
      expiresAt: row.expires_at ?? undefined,
      openedAt: row.opened_at,
      updatedAt: row.updated_at,
      answeredAt: row.answered_at ?? undefined,
    });
  }

  #hydrateProviderState(row: Record<string, unknown>): ProviderStateBinding {
    return ProviderStateBindingSchema.parse({
      id: row.id,
      integrationId: row.integration_id,
      memberId: row.member_id ?? undefined,
      scope: row.scope,
      storageReference: row.storage_reference,
      credentialReference: JSON.parse(String(row.credential_reference_json)),
      lifecycle: row.lifecycle,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #hydrateNativeSession(row: Record<string, unknown>): DurableNativeSession {
    return DurableNativeSessionSchema.parse({
      id: row.id,
      memberId: row.member_id,
      integrationId: row.integration_id,
      provider: row.provider_kind,
      source: row.source,
      referenceKind: row.ref_kind,
      referenceValue: row.ref_value,
      dedupeHash: row.dedupe_hash,
      effectiveModel: row.observed_model ?? undefined,
      runId: row.run_id,
      generation: row.generation,
      status: row.status,
      reportedAt: row.reported_at,
      lastResumedAt: row.last_resumed_at ?? undefined,
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
    if (this.#transactionDepth > 0) return operation();
    this.#database.exec("BEGIN IMMEDIATE");
    this.#transactionDepth = 1;
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      this.#transactionDepth = 0;
      for (const event of this.#pendingEvents.splice(0)) this.#publish(event);
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      this.#transactionDepth = 0;
      this.#pendingEvents.splice(0);
      throw error;
    }
  }
  #readTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN");
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
