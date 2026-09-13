import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type AgentAction,
  type AgentActionPrincipal,
  ControlForemanGoalCommandSchema,
  type CreateAgentActionCommand,
  CreateAgentActionCommandSchema,
  canonicalJson,
  type DelegateForemanGoalCommand,
  DelegateForemanGoalCommandSchema,
  type DelegationReport,
  type ForemanCheckInCommand,
  ForemanCheckInCommandSchema,
  ForemanConversationRequestSchema,
  type ForemanGoal,
  ForemanGoalSchema,
  type ForemanGoalWorkspace,
  type ForemanNotification,
  ForemanNotificationQuerySchema,
  type HumanDecision,
  type NanasaConfig,
  type ProposeForemanGoalCommand,
  ProposeForemanGoalCommandSchema,
  type ReportDelegationCommand,
  ReportDelegationCommandSchema,
  type RequestHumanDecisionCommand,
  RequestHumanDecisionCommandSchema,
  type ResolveHumanDecisionCommand,
  ResolveHumanDecisionCommandSchema,
  ResetForemanStateCommandSchema,
  type TeamDelegation,
} from "@nanasa/contracts";
import type { AgentActionService } from "./actions/agent-action-service.js";
import type { McpForemanPrincipal } from "./mcp-auth.js";
import type { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
import { DomainError, type NanasaStore } from "./store.js";
import type { TerminalReadService } from "./terminal/terminal-read-service.js";

type MemberPrincipal = Extract<AgentActionPrincipal, { kind: "agent" }>;
type RecordKind = "goal" | "delegation" | "report" | "decision";
const inactive = new Set(["completed", "cancelled"]);
const settled = new Set(["completed", "cancelled", "rejected", "expired", "superseded"]);

function assertGoalGrantWithin(grant: ForemanGoal["grant"], ceiling: ForemanGoal["grant"]): void {
  const numeric = [
    "maxActiveGoals",
    "maxTeamsPerGoal",
    "maxConcurrentActions",
    "maxGoalHours",
    "maxForemanTurns",
  ] as const;
  if (
    numeric.some((key) => grant[key] > ceiling[key]) ||
    (grant.approvalMode === "autonomous" && ceiling.approvalMode !== "autonomous") ||
    (grant.mode === "bounded" && ceiling.mode !== "bounded") ||
    grant.transcript.maxLines > ceiling.transcript.maxLines ||
    grant.transcript.maxBytes > ceiling.transcript.maxBytes ||
    (grant.intervention.idlePrompt && !ceiling.intervention.idlePrompt) ||
    grant.intervention.maxPerIncident > ceiling.intervention.maxPerIncident ||
    (grant.recovery.restartDelegatedAgents && !ceiling.recovery.restartDelegatedAgents) ||
    grant.recovery.maxAttemptsPerIncident > ceiling.recovery.maxAttemptsPerIncident ||
    grant.recovery.maxAttemptsPerGoal > ceiling.recovery.maxAttemptsPerGoal ||
    grant.recovery.cooldownSeconds < ceiling.recovery.cooldownSeconds
  )
    throw new DomainError(
      "goal_grant_exceeds_policy",
      "Goal authority exceeds repository policy",
      403,
    );
}

export class ForemanGoalService {
  #timer: NodeJS.Timeout | undefined;
  #pending: Promise<void> | undefined;
  public constructor(
    private readonly store: NanasaStore,
    private readonly config: () => NanasaConfig,
    private readonly hasController: (runId: string) => boolean = () => false,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !store.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'foreman_coordination_records'",
        )
        .get()
    )
      throw new DomainError(
        "foreman_state_layout_outdated",
        "This development database predates goal delegation. Preserve it and start with a fresh Nanasa state directory; no data was migrated or deleted.",
        409,
      );
  }

  #timestamp() {
    return this.now().toISOString();
  }
  #automatic(goal: ForemanGoal): boolean {
    return (
      goal.grant.approvalMode === "autonomous" &&
      this.config().foreman?.autonomy.approvalMode === "autonomous"
    );
  }
  #recordAutomaticApproval(goal: ForemanGoal, action: string, resourceId: string) {
    this.store.database
      .prepare(
        "INSERT INTO audits (id, principal_id, action, resource_type, resource_id, metadata_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `audit_${randomUUID()}`,
        `foreman-policy:${goal.foremanId}`,
        `foreman.auto-${action}`,
        "foreman",
        resourceId,
        JSON.stringify({
          goalId: goal.id,
          goalRevision: goal.revision,
          approvalMode: "autonomous",
        }),
        this.#timestamp(),
      );
  }
  resetState(operatorId: string, command: unknown) {
    const input = ResetForemanStateCommandSchema.parse(command);
    return this.store.atomic(() => {
      if (
        this.store.database
          .prepare(
            "SELECT id FROM runs WHERE foreman_id IS NOT NULL AND status IN ('starting', 'running', 'stopping')",
          )
          .get()
      )
        this.#fail("Stop Foreman before clearing coordination state");
      const goals = this.list();
      if (input.scope === "channel" && goals.length > 0)
        this.#fail(
          "Goals still reference channel history; clear finished goals or reset all coordination state first",
        );
      if (
        input.scope === "all" &&
        this.delegations().some((delegation) =>
          this.store.database
            .prepare(
              "SELECT id FROM runs WHERE group_id = ? AND status IN ('starting', 'running', 'stopping')",
            )
            .get(delegation.groupId),
        )
      )
        this.#fail("Stop delegated team runs before resetting their coordination state");
      const removed =
        input.scope === "channel"
          ? []
          : goals.filter((goal) => input.scope === "all" || inactive.has(goal.state));
      const removedGoalIds = new Set(removed.map((goal) => goal.id));
      const removedDelegationIds = new Set(
        this.delegations()
          .filter((delegation) => removedGoalIds.has(delegation.goalId))
          .map((delegation) => delegation.id),
      );
      const linkedActionIds = new Set(
        this.store.database
          .prepare("SELECT action_id, delegation_id FROM delegation_actions")
          .all()
          .filter((row) => removedDelegationIds.has(String(row.delegation_id)))
          .map((row) => String(row.action_id)),
      );
      const retiredActions = this.store
        .listAgentActions()
        .filter(
          (action) =>
            !settled.has(action.state) &&
            (linkedActionIds.has(action.id) ||
              (action.principal.kind === "foreman" &&
                (input.scope === "all" || removedGoalIds.has(action.principal.goalId))) ||
              (action.principal.kind === "foreman-conversation" &&
                input.scope !== "finished-goals")),
        );
      if (
        retiredActions.some((action) =>
          this.store.database
            .prepare(
              "SELECT id FROM runs WHERE id = ? AND status IN ('starting', 'running', 'stopping')",
            )
            .get(action.target.runId),
        )
      )
        this.#fail("Stop addressed team runs before clearing their coordination actions");
      for (const action of retiredActions)
        this.store.transitionAgentAction(action.id, [action.state], "superseded", {
          ...(action.result === undefined ? {} : { result: action.result }),
          error: {
            code: "foreman_state_reset",
            retryable: false,
            message:
              "Operator cleared coordination state after the addressed runtime stopped. Prior effects are not undone or certified complete.",
          },
        });
      for (const goal of removed) {
        const delegationIds = this.delegations()
          .filter((delegation) => delegation.goalId === goal.id)
          .map((delegation) => delegation.id);
        for (const id of delegationIds) {
          this.store.database
            .prepare("DELETE FROM delegation_actions WHERE delegation_id = ?")
            .run(id);
          this.store.database
            .prepare("DELETE FROM delegation_recovery WHERE delegation_id = ?")
            .run(id);
          this.store.database
            .prepare(
              "DELETE FROM foreman_coordination_records WHERE kind = 'report' AND json_extract(data_json, '$.delegationId') = ?",
            )
            .run(id);
        }
        this.store.database
          .prepare("DELETE FROM foreman_inbox WHERE dedupe_key LIKE ?")
          .run(`goal-review:${goal.id}:%`);
        this.store.database
          .prepare(
            "DELETE FROM foreman_notifications WHERE json_extract(data_json, '$.goalId') = ?",
          )
          .run(goal.id);
        this.store.database
          .prepare("DELETE FROM foreman_coordination_records WHERE goal_id = ? OR id = ?")
          .run(goal.id, goal.id);
      }
      let messagesRemoved = 0;
      let conversationsRemoved = 0;
      if (input.scope !== "finished-goals") {
        this.store.database.prepare("DELETE FROM foreman_inbox").run();
        messagesRemoved = Number(
          this.store.database.prepare("DELETE FROM foreman_messages").run().changes,
        );
        conversationsRemoved = Number(
          this.store.database.prepare("DELETE FROM foreman_conversations").run().changes,
        );
      }
      if (input.scope === "all") {
        this.store.database.prepare("DELETE FROM foreman_coordination_records").run();
        this.store.database.prepare("DELETE FROM foreman_notifications").run();
        this.store.database.prepare("DELETE FROM foreman_notification_cursors").run();
        this.store.database.prepare("DELETE FROM foreman_recovery").run();
      }
      const result = {
        scope: input.scope,
        goalsRemoved: removed.length,
        messagesRemoved,
        conversationsRemoved,
      };
      this.store.database
        .prepare(
          "INSERT INTO audits (id, principal_id, action, resource_type, resource_id, metadata_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `audit_${randomUUID()}`,
          operatorId,
          "foreman.reset-state",
          "foreman",
          this.config().foreman?.id ?? "repository",
          JSON.stringify(result),
          this.#timestamp(),
        );
      return result;
    });
  }
  #digest(input: unknown) {
    return createHash("sha256").update(canonicalJson(input)).digest("hex");
  }
  #candidateDigest(checkoutId: string, candidatePath: string): string {
    const root = realpathSync(this.store.getCheckout(checkoutId).path);
    if (
      isAbsolute(candidatePath) ||
      candidatePath.includes("\\") ||
      candidatePath
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || part === ".git" || part === "node_modules",
        )
    )
      this.#fail("Candidate path must name a bounded repository-relative file or directory");
    const target = resolve(root, candidatePath);
    if (!target.startsWith(`${root}${sep}`) || realpathSync(target) !== target)
      this.#fail("Candidate path must remain inside the checkout without symlinks");
    const hash = createHash("sha256");
    let bytes = 0;
    let files = 0;
    let entries = 0;
    const visit = (path: string) => {
      if (++entries > 1024 || relative(target, path).split(sep).length > 32)
        this.#fail("Candidate snapshot exceeds directory limits");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) this.#fail("Candidate snapshots must not contain symlinks");
      if (stat.isDirectory()) {
        const children = readdirSync(path).sort();
        if (children.length > 512) this.#fail("Candidate snapshot has too many entries");
        for (const child of children) {
          if (child === ".git" || child === "node_modules")
            this.#fail("Candidate snapshot must exclude repository metadata and dependencies");
          visit(resolve(path, child));
        }
      } else {
        if (!stat.isFile() || ++files > 512 || (bytes += stat.size) > 16 * 1024 * 1024)
          this.#fail("Candidate snapshot exceeds file or byte limits");
        const content = readFileSync(path);
        hash.update(
          canonicalJson({
            path: relative(root, path),
            executable: Boolean(stat.mode & 0o111),
            digest: createHash("sha256").update(content).digest("hex"),
          }),
        );
      }
    };
    visit(target);
    if (files === 0) this.#fail("Candidate snapshot must include files");
    return hash.digest("hex");
  }
  #fail(message: string): never {
    throw new DomainError("foreman_goal_conflict", message, 409);
  }
  #records<Value>(kind: RecordKind): Value[] {
    return this.store.database
      .prepare("SELECT data_json FROM foreman_coordination_records WHERE kind = ? ORDER BY rowid")
      .all(kind)
      .map((row) => JSON.parse(String(row.data_json)) as Value);
  }
  #get<Value>(kind: RecordKind, id: string): Value {
    const row = this.store.database
      .prepare("SELECT data_json FROM foreman_coordination_records WHERE kind = ? AND id = ?")
      .get(kind, id);
    if (row === undefined)
      throw new DomainError("foreman_goal_not_found", "Coordination record not found", 404);
    return JSON.parse(String(row.data_json)) as Value;
  }
  #save<Value extends { id: string; goalId?: string; groupId?: string }>(
    kind: RecordKind,
    value: Value,
    key?: string,
    input?: unknown,
  ) {
    this.store.database
      .prepare(`INSERT INTO foreman_coordination_records (id, kind, goal_id, group_id, request_key, request_digest, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json`)
      .run(
        value.id,
        kind,
        value.goalId ?? null,
        value.groupId ?? null,
        key ?? null,
        input === undefined ? null : this.#digest(input),
        JSON.stringify(value),
      );
  }
  #existing<Value>(key: string, input: unknown): Value | undefined {
    const row = this.store.database
      .prepare(
        "SELECT data_json, request_digest FROM foreman_coordination_records WHERE request_key = ?",
      )
      .get(key);
    if (row === undefined) return undefined;
    if (row.request_digest !== this.#digest(input))
      this.#fail("Request ID was reused with different content");
    return JSON.parse(String(row.data_json)) as Value;
  }
  notify(key: string, notification: Omit<ForemanNotification, "id" | "sequence" | "createdAt">) {
    const id = `fn_${randomUUID()}`;
    this.store.database
      .prepare(
        "INSERT OR IGNORE INTO foreman_notifications (id, dedupe_key, data_json) VALUES (?, ?, ?)",
      )
      .run(id, key, JSON.stringify({ ...notification, id, createdAt: this.#timestamp() }));
  }
  notifications(query: unknown) {
    const input = ForemanNotificationQuerySchema.parse(query);
    const rows = this.store.database
      .prepare(
        "SELECT sequence, data_json FROM foreman_notifications WHERE sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(input.after, input.limit + 1);
    const notifications: ForemanNotification[] = rows
      .slice(0, input.limit)
      .map((row) => ({ ...JSON.parse(String(row.data_json)), sequence: Number(row.sequence) }));
    return {
      notifications,
      nextAfter: notifications.at(-1)?.sequence ?? input.after,
      hasMore: rows.length > input.limit,
    };
  }
  acknowledge(consumerId: string, after: number) {
    const latest = Number(
      this.store.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM foreman_notifications")
        .get()!.value,
    );
    if (!Number.isSafeInteger(after) || after < 0 || after > latest)
      this.#fail("Invalid notification cursor");
    this.store.database
      .prepare(
        `INSERT INTO foreman_notification_cursors VALUES (?, ?, ?) ON CONFLICT(consumer_id) DO UPDATE SET after_sequence = MAX(after_sequence, excluded.after_sequence), updated_at = excluded.updated_at`,
      )
      .run(consumerId, after, this.#timestamp());
    return this.cursor(consumerId);
  }
  cursor(consumerId: string) {
    return {
      after: Number(
        this.store.database
          .prepare("SELECT after_sequence FROM foreman_notification_cursors WHERE consumer_id = ?")
          .get(consumerId)?.after_sequence ?? 0,
      ),
    };
  }
  list() {
    return this.#records<unknown>("goal").map((goal) => this.#validateGoal(goal));
  }
  get(id: string) {
    return this.#validateGoal(this.#get<unknown>("goal", id));
  }
  #validateGoal(value: unknown): ForemanGoal {
    const parsed = ForemanGoalSchema.safeParse(value);
    if (!parsed.success) {
      throw new DomainError(
        "foreman_state_layout_outdated",
        "Stored goal policy does not match the current goal-only contract. Preserve required records and use fresh development state; no state was reset.",
        409,
      );
    }
    return parsed.data;
  }
  delegations() {
    return this.#records<TeamDelegation>("delegation");
  }
  delegation(id: string) {
    return this.#get<TeamDelegation>("delegation", id);
  }
  workspace(id: string): ForemanGoalWorkspace {
    return {
      goal: this.get(id),
      delegations: this.delegations().filter((item) => item.goalId === id),
      reports: this.#records<DelegationReport>("report").filter(
        (item) => this.delegation(item.delegationId).goalId === id,
      ),
      decisions: this.#records<HumanDecision>("decision").filter((item) => item.goalId === id),
    };
  }
  assertForeman(principal: McpForemanPrincipal) {
    const actor = this.store.getForeman(principal.foremanId);
    const run = this.store.getActiveForemanRun(actor.id);
    if (
      !actor.enabled ||
      actor.authorityRevision !== principal.authorityRevision ||
      run?.id !== principal.runId ||
      run.generation !== principal.generation ||
      run.desiredState !== "running" ||
      this.config().foreman?.enabled !== true
    )
      throw new DomainError(
        "foreman_authority_revoked",
        "Foreman authority is no longer current",
        403,
      );
  }
  #running(goal: ForemanGoal) {
    const foreman = this.config().foreman;
    if (
      goal.state !== "running" ||
      foreman?.enabled !== true ||
      foreman.id !== goal.foremanId ||
      Date.parse(goal.expiresAt) <= this.now().getTime()
    )
      this.#fail("Goal is not running within its authorized time limit");
    assertGoalGrantWithin(goal.grant, foreman.autonomy);
  }
  propose(command: ProposeForemanGoalCommand): ForemanGoal {
    const input = ProposeForemanGoalCommandSchema.parse(command);
    return this.store.atomic(() => {
      const existing = this.#existing<ForemanGoal>(`goal:${input.requestId}`, input);
      if (existing) return existing;
      const foreman = this.config().foreman;
      if (foreman?.enabled !== true) this.#fail("Enable Foreman before proposing a goal");
      if (
        this.list().filter((goal) => !inactive.has(goal.state)).length >=
        foreman.autonomy.maxActiveGoals
      )
        this.#fail("Goal capacity exhausted");
      if (input.sourceMessageId !== undefined) {
        const parent = this.store.database
          .prepare("SELECT sender_json FROM foreman_messages WHERE id = ?")
          .get(input.sourceMessageId);
        if (parent === undefined || JSON.parse(String(parent.sender_json)).kind !== "operator")
          this.#fail("Goal source must be a human channel message");
      }
      const timestamp = this.#timestamp();
      const goal: ForemanGoal = {
        ...input,
        id: `goal_${randomUUID()}`,
        foremanId: foreman.id,
        state: "proposed",
        revision: 0,
        grant: foreman.autonomy,
        turnsUsed: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: new Date(
          this.now().getTime() + foreman.autonomy.maxGoalHours * 3600000,
        ).toISOString(),
      };
      for (const id of input.sourceConversationIds ?? []) {
        const row = this.store.database
          .prepare("SELECT data_json FROM foreman_conversations WHERE id = ?")
          .get(id);
        if (
          !row ||
          ForemanConversationRequestSchema.parse(JSON.parse(String(row.data_json))).foremanId !==
            goal.foremanId
        )
          this.#fail("Goal conversation context is unavailable or belongs to another Foreman");
      }
      this.#save("goal", goal, `goal:${input.requestId}`, input);
      this.notify(`goal:${goal.id}`, {
        kind: "goal",
        goalId: goal.id,
        summary: `${this.#automatic(goal) ? "Goal authorized by autonomous coordination policy" : "Goal requires human approval"}: ${goal.title}`,
      });
      if (this.#automatic(goal)) {
        const approved = this.control(`foreman-policy:${goal.foremanId}`, {
          id: goal.id,
          expectedRevision: goal.revision,
          action: "approve",
        });
        this.#recordAutomaticApproval(approved, "approve-goal", goal.id);
        return approved;
      }
      return goal;
    });
  }
  acceptAutonomously(principal: McpForemanPrincipal, goalId: string, expectedRevision: number) {
    this.assertForeman(principal);
    return this.store.atomic(() => {
      const goal = this.get(goalId);
      if (goal.foremanId !== principal.foremanId || !this.#automatic(goal))
        this.#fail(
          "Autonomous coordination must be authorized by both the goal grant and current policy",
        );
      this.#running({ ...goal, state: "running" });
      const result = this.control(`foreman-policy:${principal.foremanId}`, {
        id: goal.id,
        expectedRevision,
        action: "accept",
      });
      this.#recordAutomaticApproval(result, "accept-goal", goal.id);
      return result;
    });
  }
  control(operatorId: string, command: unknown) {
    const input = ControlForemanGoalCommandSchema.parse(command);
    return this.store.atomic(() => {
      const goal = this.get(input.id);
      if (goal.revision !== input.expectedRevision)
        this.#fail("Goal revision changed; refresh before deciding");
      const allowed = {
        approve: ["proposed"],
        pause: ["running", "blocked", "awaiting-acceptance"],
        resume: ["paused", "blocked"],
        cancel: ["proposed", "running", "paused", "blocked", "awaiting-acceptance"],
        accept: ["awaiting-acceptance"],
      };
      if (!allowed[input.action].includes(goal.state))
        this.#fail("Goal control is not valid in this state");
      if (input.action === "approve" || input.action === "resume") {
        this.#running({ ...goal, state: "running" });
        goal.state = "running";
      } else if (input.action === "accept") {
        const delegates = this.workspace(goal.id).delegations.filter(
          (item) => item.state !== "cancelled",
        );
        if (!delegates.length || delegates.some((item) => item.state !== "ready"))
          this.#fail("All delegations must provide completion evidence");
        for (const delegation of delegates) {
          this.assertAssignment(delegation);
          if (this.unsettled(delegation).length) this.#fail("Team still has unsettled work");
          const checkout = this.store.getCheckout(delegation.checkoutId);
          const ready = this.workspace(goal.id)
            .reports.filter(
              (report) => report.delegationId === delegation.id && report.kind === "ready",
            )
            .at(-1);
          if (
            ready?.candidatePath !== undefined
              ? this.#candidateDigest(checkout.id, ready.candidatePath) !== ready.candidateDigest
              : checkout.dirty || !checkout.head || checkout.head !== ready?.candidateHead
          )
            this.#fail("Completion evidence no longer matches the reviewed candidate");
          if (
            this.discover()
              .find((team) => team.id === delegation.groupId)
              ?.members.some((member) => !["idle", "stopped"].includes(member.status.state))
          )
            this.#fail("Wait for all team members to settle before acceptance");
          this.#save("delegation", {
            ...delegation,
            state: "completed",
            revision: delegation.revision + 1,
          });
        }
        goal.state = "completed";
      } else goal.state = input.action === "pause" ? "paused" : "cancelled";
      goal.revision++;
      goal.updatedAt = this.#timestamp();
      this.#save("goal", goal);
      if (input.action === "pause" || input.action === "cancel") {
        for (const decision of this.workspace(goal.id).decisions.filter(
          (item) => item.state === "pending",
        ))
          this.#save("decision", { ...decision, state: "stale", revision: decision.revision + 1 });
        for (const delegation of this.workspace(goal.id).delegations) {
          if (delegation.state === "proposed" || input.action === "cancel")
            this.#save("delegation", {
              ...delegation,
              state: "cancelled",
              revision: delegation.revision + 1,
              updatedAt: this.#timestamp(),
            });
        }
      }
      this.notify(`control:${goal.id}:${goal.revision}`, {
        kind: "control",
        goalId: goal.id,
        summary: `${operatorId}: ${input.action} ${goal.title}. Existing provider work is not forcibly interrupted.`,
      });
      return goal;
    });
  }
  discover() {
    const snapshot = this.store.getSnapshot();
    const config = this.config();
    return snapshot.groups.map((group) => ({
      ...group,
      startupRequiredMemberIds: this.store
        .listActiveMemberships(group.id)
        .filter((member) => this.store.getActiveRun(group.id, member.memberId) === undefined)
        .map((member) => member.memberId),
      effectiveCheckout: (() => {
        const checkout = this.store.getEffectiveGroupCheckout(group.id);
        return checkout === undefined
          ? undefined
          : {
              id: checkout.id,
              kind: checkout.kind,
              sharedWithActiveTeams: snapshot.groups
                .filter(
                  (other) =>
                    other.id !== group.id &&
                    this.store.getEffectiveGroupCheckout(other.id)?.id === checkout.id &&
                    this.store
                      .listActiveMemberships(other.id)
                      .some(
                        (member) =>
                          this.store.getActiveRun(other.id, member.memberId) !== undefined,
                      ),
                )
                .map((other) => ({ id: other.id, name: other.name })),
            };
      })(),
      reservation: this.delegations().find(
        (item) => item.groupId === group.id && !inactive.has(item.state),
      ),
      members: this.store.listActiveMemberships(group.id).map((member) => {
        const run = this.store.getActiveRun(group.id, member.memberId);
        const profile = this.store.getAgentProfile(member.agentProfileId);
        const role = member.roleId === undefined ? undefined : config.roles[member.roleId];
        return {
          memberId: member.memberId,
          alias: member.alias,
          roleId: member.roleId,
          roleName: role?.name,
          description: role?.description,
          permissionPolicy: role?.permissionPolicy,
          provider: profile.kind,
          runId: run?.id,
          generation: run?.generation,
          status: this.store.getAgentStatus(group.id, member.memberId),
          humanControlled: run !== undefined && this.hasController(run.id),
        };
      }),
    }));
  }
  assertAssignment(delegation: TeamDelegation) {
    const group = this.store.getSnapshot().groups.find((item) => item.id === delegation.groupId);
    const members = this.store.listActiveMemberships(delegation.groupId);
    if (
      !group ||
      group.membershipRevision !== delegation.expectedMembershipRevision ||
      group.checkoutRevision !== delegation.expectedCheckoutRevision ||
      this.store.getEffectiveGroupCheckout(group.id)?.id !== delegation.checkoutId ||
      !members.some((member) => member.memberId === delegation.memberId)
    )
      this.#fail("Team membership or checkout changed; a new delegation is required");
    if (
      this.store
        .getSnapshot()
        .groups.some(
          (other) =>
            other.id !== delegation.groupId &&
            this.store.getEffectiveGroupCheckout(other.id)?.id === delegation.checkoutId &&
            this.store
              .listActiveMemberships(other.id)
              .some((member) => this.store.getActiveRun(other.id, member.memberId) !== undefined),
        )
    )
      this.#fail("Another active team shares this checkout");
    if (
      members.some((member) => {
        const run = this.store.getActiveRun(group.id, member.memberId);
        return (
          run !== undefined &&
          (run.checkoutId !== delegation.checkoutId || this.hasController(run.id))
        );
      })
    )
      this.#fail("Team checkout or human control prevents delegated work");
  }
  delegate(principal: McpForemanPrincipal, command: DelegateForemanGoalCommand): TeamDelegation {
    this.assertForeman(principal);
    const input = DelegateForemanGoalCommandSchema.parse(command);
    return this.store.atomic(() => {
      const key = `delegate:${input.goalId}:${input.requestId}`;
      const existing = this.#existing<TeamDelegation>(key, input);
      if (existing) return existing;
      const goal = this.get(input.goalId);
      this.#running(goal);
      if (goal.foremanId !== principal.foremanId || goal.revision !== input.expectedRevision)
        this.#fail("Goal authority changed");
      if (
        this.workspace(goal.id).delegations.filter((item) => !inactive.has(item.state)).length >=
        goal.grant.maxTeamsPerGoal
      )
        this.#fail("Goal team budget exhausted");
      if (
        this.delegations().some(
          (item) => item.groupId === input.groupId && !inactive.has(item.state),
        )
      )
        this.#fail("Team is already reserved");
      const group = this.store.getSnapshot().groups.find((item) => item.id === input.groupId);
      if (group === undefined) this.#fail("Team is no longer available");
      const checkout = this.store.getEffectiveGroupCheckout(group.id);
      if (checkout === undefined) this.#fail("Assign a team checkout before delegation");
      if (
        this.delegations().some(
          (item) => item.checkoutId === checkout.id && !inactive.has(item.state),
        )
      )
        this.#fail("Checkout is already reserved by another delegation");
      const timestamp = this.#timestamp();
      const delegation: TeamDelegation = {
        ...input,
        id: `delegation_${randomUUID()}`,
        state: "proposed",
        revision: 0,
        checkoutId: checkout.id,
        nextCheckAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.assertAssignment(delegation);
      if (
        this.store
          .listAgentActions(input.groupId)
          .some(
            (action) =>
              action.principal.kind !== "foreman-conversation" && !settled.has(action.state),
          )
      )
        this.#fail("Team has unsettled work");
      if (
        this.discover()
          .find((item) => item.id === input.groupId)
          ?.members.some(
            (member) =>
              member.runId !== undefined &&
              (member.status.state !== "idle" ||
                member.status.staleAuthority ||
                !member.status.interactiveReady),
          )
      )
        this.#fail("Team is not currently available");
      this.#save("delegation", delegation, key, input);
      const decision = this.#question(
        {
          requestId: delegation.id,
          goalId: goal.id,
          delegationId: delegation.id,
          question: `Authorize ${group.name} / ${input.memberId} to own this outcome, its team peer work, and checkout ${checkout.id}? ${input.rationale}`,
          options: ["approve", "deny"],
          blocking: true,
        },
        "delegation",
      );
      this.notify(`delegation:${delegation.id}`, {
        kind: "decision",
        goalId: goal.id,
        delegationId: delegation.id,
        decisionId: decision.id,
        summary: decision.question.slice(0, 2000),
      });
      if (this.#automatic(goal)) {
        this.resolve(`foreman-policy:${goal.foremanId}`, {
          id: decision.id,
          expectedRevision: decision.revision,
          requestId: `auto:${decision.id}`,
          answer: "approve",
        });
        this.#recordAutomaticApproval(goal, "approve-delegation", delegation.id);
        return this.delegation(delegation.id);
      }
      return delegation;
    });
  }
  #member(principal: MemberPrincipal, delegation: TeamDelegation) {
    const run = this.store.getActiveRun(principal.groupId, principal.memberId);
    if (
      principal.groupId !== delegation.groupId ||
      run?.id !== principal.runId ||
      run.generation !== principal.generation ||
      run.desiredState !== "running"
    )
      throw new DomainError(
        "delegation_forbidden",
        "Only a current member of the delegated team may use this record",
        403,
      );
    this.assertAssignment(delegation);
  }
  own(principal: MemberPrincipal) {
    return this.delegations()
      .filter((item) => item.groupId === principal.groupId && !inactive.has(item.state))
      .map((item) => {
        this.#member(principal, item);
        const workspace = this.workspace(item.goalId);
        const delegations = workspace.delegations.filter(
          (delegation) => delegation.groupId === principal.groupId,
        );
        const ids = new Set(delegations.map((delegation) => delegation.id));
        return {
          ...workspace,
          delegations,
          reports: workspace.reports.filter((report) => ids.has(report.delegationId)),
          decisions: workspace.decisions.filter(
            (decision) => decision.delegationId === undefined || ids.has(decision.delegationId),
          ),
        };
      });
  }
  report(principal: MemberPrincipal, command: ReportDelegationCommand) {
    const input = ReportDelegationCommandSchema.parse(command);
    return this.store.atomic(() => {
      const delegation = this.delegation(input.delegationId);
      this.#member(principal, delegation);
      const key = `report:${delegation.id}:${principal.memberId}:${input.requestId}`;
      const existing = this.#existing<DelegationReport>(key, input);
      if (existing) return existing;
      const goal = this.get(delegation.goalId);
      this.#running(goal);
      if (["proposed", "queued", "cancelled", "completed"].includes(delegation.state))
        this.#fail("Delegation is not active");
      const lead = principal.memberId === delegation.memberId;
      if (input.candidatePath && input.candidateHead)
        this.#fail("Choose a working-tree candidate path or a clean candidate commit, not both");
      const candidateDigest =
        (input.kind === "ready" || input.kind === "review") && input.candidatePath
          ? this.#candidateDigest(delegation.checkoutId, input.candidatePath)
          : undefined;
      if (!lead && ["accepted", "plan", "ready"].includes(input.kind))
        this.#fail("Only the accountable member can accept, plan, or finish a delegation");
      if (input.kind === "ready") {
        if (!input.evidence.length || this.unsettled(delegation).length)
          this.#fail("Completion requires evidence and settled team work");
        if (
          this.workspace(goal.id).decisions.some(
            (decision) =>
              decision.state === "pending" &&
              decision.blocking &&
              (decision.delegationId === undefined || decision.delegationId === delegation.id),
          )
        )
          this.#fail("Human decisions remain pending");
        if (
          !this.workspace(goal.id).reports.some(
            (report) =>
              report.delegationId === delegation.id &&
              report.kind === "review" &&
              report.memberId !== delegation.memberId &&
              (candidateDigest === undefined
                ? report.candidateHead === input.candidateHead && report.candidatePath === undefined
                : report.candidatePath === input.candidatePath &&
                  report.candidateDigest === candidateDigest) &&
              report.evidence.length,
          )
        )
          this.#fail("Independent review of the same candidate is required");
      }
      if (input.kind === "ready" || input.kind === "review") {
        const checkout = this.store.getCheckout(delegation.checkoutId);
        if (
          (candidateDigest === undefined &&
            (!input.candidateHead || checkout.head !== input.candidateHead || checkout.dirty)) ||
          !input.evidence.length
        )
          this.#fail("Evidence must reference the current clean candidate commit");
        if (input.kind === "review" && lead)
          this.#fail("The accountable member cannot supply independent review");
      }
      const timestamp = this.#timestamp();
      const report: DelegationReport = {
        ...input,
        ...(candidateDigest === undefined ? {} : { candidateDigest }),
        id: `report_${randomUUID()}`,
        memberId: principal.memberId,
        runId: principal.runId,
        generation: principal.generation,
        createdAt: timestamp,
      };
      this.#save("report", report, key, input);
      delegation.lastReportAt = timestamp;
      delegation.nextCheckAt = new Date(
        this.now().getTime() + input.nextCheckSeconds * 1000,
      ).toISOString();
      delegation.updatedAt = timestamp;
      delegation.revision++;
      if (lead)
        delegation.state =
          input.kind === "ready"
            ? "ready"
            : input.kind === "blocked"
              ? "blocked"
              : input.kind === "accepted"
                ? "accepted"
                : "working";
      this.#save("delegation", delegation);
      if (
        this.workspace(goal.id)
          .delegations.filter((item) => !inactive.has(item.state))
          .every((item) => item.state === "ready")
      ) {
        goal.state = "awaiting-acceptance";
        goal.revision++;
        this.#save("goal", goal);
        this.#wake(
          goal,
          "The team reports ready. Inspect independent review and pinned evidence, explain residual risks, and ask the Human to accept the outcome. Do not dispatch more work.",
        );
      }
      this.notify(`report:${report.id}`, {
        kind: "report",
        goalId: goal.id,
        delegationId: delegation.id,
        summary: `${input.kind}: ${input.summary}`.slice(0, 2000),
      });
      if (input.kind === "blocked" && goal.state === "running")
        this.#wake(
          goal,
          "A team member reported a blocker. Inspect the durable report and let the accountable member retain orchestration ownership.",
        );
      return report;
    });
  }
  #question(input: RequestHumanDecisionCommand, kind: HumanDecision["kind"]): HumanDecision {
    const key = `question:${input.goalId}:${input.delegationId ?? "goal"}:${input.requestId}`;
    const existing = this.#existing<HumanDecision>(key, input);
    if (existing) return existing;
    const goal = this.get(input.goalId);
    this.#running(goal);
    if (input.delegationId !== undefined && this.delegation(input.delegationId).goalId !== goal.id)
      this.#fail("Decision belongs to another goal");
    const decision: HumanDecision = {
      ...input,
      id: `decision_${randomUUID()}`,
      kind,
      state: "pending",
      revision: 0,
      goalRevision: goal.revision,
      createdAt: this.#timestamp(),
    };
    this.#save("decision", decision, key, input);
    this.notify(`decision:${decision.id}`, {
      kind: "decision",
      goalId: goal.id,
      ...(input.delegationId ? { delegationId: input.delegationId } : {}),
      decisionId: decision.id,
      summary: input.question.slice(0, 2000),
    });
    return decision;
  }
  question(principal: McpForemanPrincipal | MemberPrincipal, command: RequestHumanDecisionCommand) {
    const input = RequestHumanDecisionCommandSchema.parse(command);
    if (principal.kind === "foreman") this.assertForeman(principal);
    else {
      if (input.delegationId === undefined) this.#fail("Team decisions require a delegation");
      this.#member(principal, this.delegation(input.delegationId));
    }
    return this.store.atomic(() => this.#question(input, "question"));
  }
  resolve(operatorId: string, command: ResolveHumanDecisionCommand) {
    const input = ResolveHumanDecisionCommandSchema.parse(command);
    return this.store.atomic(() => {
      const decision = this.#get<HumanDecision>("decision", input.id);
      if (
        decision.state === "resolved" &&
        decision.decidedBy === operatorId &&
        decision.answer === input.answer &&
        decision.revision === input.expectedRevision + 1
      )
        return decision;
      const goal = this.get(decision.goalId);
      this.#running(goal);
      if (
        decision.state !== "pending" ||
        decision.revision !== input.expectedRevision ||
        decision.goalRevision !== goal.revision
      )
        this.#fail("Human request is stale or already resolved");
      if (decision.options.length && !decision.options.includes(input.answer))
        this.#fail("Choose one of the current decision options");
      if (decision.kind === "delegation") {
        const delegation = this.delegation(decision.delegationId!);
        if (input.answer === "approve") {
          this.assertAssignment(delegation);
          const team = this.discover().find((item) => item.id === delegation.groupId);
          if (
            this.store
              .listAgentActions(delegation.groupId)
              .some(
                (action) =>
                  action.principal.kind !== "foreman-conversation" && !settled.has(action.state),
              ) ||
            team?.members.some(
              (member) =>
                member.runId !== undefined &&
                (member.status.state !== "idle" ||
                  member.status.staleAuthority ||
                  !member.status.interactiveReady),
            )
          )
            this.#fail("Team availability changed before approval");
        }
        if (delegation.state !== "proposed") this.#fail("Delegation is no longer proposed");
        delegation.state = input.answer === "approve" ? "queued" : "cancelled";
        delegation.revision++;
        this.#save("delegation", delegation);
      }
      decision.state = "resolved";
      decision.revision++;
      decision.answer = input.answer;
      decision.decidedBy = operatorId;
      decision.resolvedAt = this.#timestamp();
      this.#save("decision", decision);
      this.notify(`resolved:${decision.id}`, {
        kind: "decision",
        goalId: goal.id,
        decisionId: decision.id,
        summary: `${operatorId} resolved a human request. Read the durable decision before continuing.`,
      });
      this.#wake(
        goal,
        "A human decision was resolved. Read it and notify the accountable team member when permitted.",
      );
      return decision;
    });
  }
  unsettled(delegation: TeamDelegation) {
    return this.store
      .listAgentActions(delegation.groupId)
      .filter(
        (action) =>
          action.principal.kind !== "foreman-conversation" &&
          action.id !== delegation.actionId &&
          !settled.has(action.state),
      );
  }
  authorizeTeamInput(principal: AgentActionPrincipal) {
    if (principal.kind !== "agent") return;
    const delegation = this.delegations().find(
      (item) =>
        item.groupId === principal.groupId &&
        item.state !== "proposed" &&
        !inactive.has(item.state),
    );
    if (!delegation) {
      const run = this.store.getActiveRun(principal.groupId, principal.memberId);
      const previous = this.delegations()
        .filter((item) => item.groupId === principal.groupId && item.state === "cancelled")
        .at(-1);
      if (run && previous && Date.parse(run.startedAt) <= Date.parse(previous.updatedAt))
        this.#fail("Cancelled delegation runtimes require a new assignment or a Human restart");
      return;
    }
    this.#member(principal, delegation);
    const goal = this.get(delegation.goalId);
    this.#running(goal);
    if (!["accepted", "working", "blocked"].includes(delegation.state))
      this.#fail("Team must accept its delegation before peer work");
    if (
      this.workspace(goal.id).decisions.some(
        (item) =>
          item.state === "pending" &&
          item.blocking &&
          (item.delegationId === undefined || item.delegationId === delegation.id),
      )
    )
      this.#fail("Delegation is waiting for a human decision");
    return { goal, delegation };
  }
  authorizePeer(principal: AgentActionPrincipal, command: CreateAgentActionCommand) {
    const authorized = this.authorizeTeamInput(principal);
    if (!authorized) return;
    const { goal, delegation } = authorized;
    if (
      this.workspace(goal.id).delegations.reduce(
        (count, item) => count + this.unsettled(item).length,
        0,
      ) >= goal.grant.maxConcurrentActions
    )
      this.#fail("Goal concurrency budget exhausted");
    if (command.groupId !== delegation.groupId)
      this.#fail("Peer work cannot escape the delegated team");
  }
  authorizeMessage(
    groupId: string,
    message: { sender: { kind: string; memberId?: string; runId?: string } },
  ) {
    if (message.sender.kind !== "agent" || message.sender.memberId === undefined) return;
    const run = this.store.getActiveRun(groupId, message.sender.memberId);
    const reserved = this.delegations().some((item) => item.groupId === groupId);
    if (!reserved) return;
    if (!run || (message.sender.runId !== undefined && run.id !== message.sender.runId))
      this.#fail("Peer message sender runtime changed");
    this.authorizeTeamInput({
      kind: "agent",
      groupId,
      memberId: message.sender.memberId,
      runId: run.id,
      generation: run.generation,
    });
  }
  linkAction(action: AgentAction) {
    if (action.principal.kind !== "agent") return;
    const delegation = this.delegations().find(
      (item) =>
        item.groupId === action.target.groupId &&
        item.state !== "proposed" &&
        !inactive.has(item.state),
    );
    if (delegation)
      this.store.database
        .prepare("INSERT OR IGNORE INTO delegation_actions VALUES (?, ?)")
        .run(action.id, delegation.id);
  }
  authorizeAction(action: AgentAction) {
    if (action.principal.kind === "foreman") {
      this.authorizeHandoff(
        action.principal,
        CreateAgentActionCommandSchema.parse({
          kind: "prompt",
          groupId: action.target.groupId,
          memberId: action.target.memberId,
          prompt: action.prompt,
        }),
      );
    }
    const link = this.store.database
      .prepare("SELECT delegation_id FROM delegation_actions WHERE action_id = ?")
      .get(action.id);
    if (!link) return;
    const delegation = this.delegation(String(link.delegation_id));
    this.#running(this.get(delegation.goalId));
    this.assertAssignment(delegation);
    if (inactive.has(delegation.state) || delegation.state === "ready")
      this.#fail("Delegation no longer authorizes work");
    if (
      this.workspace(delegation.goalId).decisions.some(
        (item) =>
          item.state === "pending" &&
          item.blocking &&
          (item.delegationId === undefined || item.delegationId === delegation.id),
      )
    )
      this.#fail("Delegation is waiting for a human decision");
  }

  authorizeHandoff(
    principal: Extract<AgentActionPrincipal, { kind: "foreman" }>,
    command: CreateAgentActionCommand,
  ) {
    this.assertForeman(principal);
    const goal = this.get(principal.goalId);
    this.#running(goal);
    const delegation = this.delegation(principal.delegationId);
    if (
      delegation.goalId !== goal.id ||
      goal.foremanId !== principal.foremanId ||
      principal.goalRevision !== goal.revision + 1 ||
      delegation.groupId !== command.groupId ||
      delegation.memberId !== command.memberId ||
      !["queued", "offered", "accepted", "working", "blocked"].includes(delegation.state)
    )
      this.#fail("Delegation no longer authorizes this handoff");
    this.assertAssignment(delegation);
  }

  checkIn(
    principal: McpForemanPrincipal,
    command: ForemanCheckInCommand,
    actions: AgentActionService,
  ) {
    this.assertForeman(principal);
    const input = ForemanCheckInCommandSchema.parse(command);
    return this.store.atomic(() => {
      const delegation = this.delegation(input.delegationId);
      const goal = this.get(delegation.goalId);
      this.#running(goal);
      if (!goal.grant.intervention.idlePrompt || goal.grant.mode !== "bounded")
        this.#fail("Goal policy does not permit idle check-ins");
      const previous = this.store
        .listAgentActions(delegation.groupId)
        .filter(
          (action) =>
            action.principal.kind === "foreman" &&
            action.principal.delegationId === delegation.id &&
            action.id !== delegation.actionId,
        );
      const duplicate = previous.find(
        (action) => action.idempotencyKey === `check-in:${delegation.id}:${input.requestId}`,
      );
      if (duplicate) {
        if (
          duplicate.prompt !== input.text ||
          duplicate.target.runId !== input.expectedRunId ||
          duplicate.target.generation !== input.expectedGeneration
        )
          this.#fail("Check-in request ID was reused");
        return duplicate;
      }
      if (
        previous.length >= goal.grant.intervention.maxPerIncident ||
        previous.some((action) => !settled.has(action.state)) ||
        previous.some(
          (action) =>
            Date.parse(action.createdAt) + goal.grant.recovery.cooldownSeconds * 1000 >
            this.now().getTime(),
        )
      )
        this.#fail("Check-in budget or cooldown prevents another prompt");
      const action = actions.create(
        {
          ...principal,
          goalId: goal.id,
          delegationId: delegation.id,
          goalRevision: goal.revision + 1,
        },
        CreateAgentActionCommandSchema.parse({
          kind: "prompt",
          groupId: delegation.groupId,
          memberId: delegation.memberId,
          expectedRunId: input.expectedRunId,
          expectedGeneration: input.expectedGeneration,
          expectedStatusRevision: input.expectedStatusRevision,
          prompt: input.text,
          allowWorking: false,
        }),
        `check-in:${delegation.id}:${input.requestId}`,
      );
      this.store.database
        .prepare("INSERT OR IGNORE INTO delegation_actions VALUES (?, ?)")
        .run(action.id, delegation.id);
      return action;
    });
  }

  async observe(
    principal: McpForemanPrincipal,
    delegationId: string,
    memberId: string | undefined,
    reads: Pick<TerminalReadService, "read">,
  ) {
    this.assertForeman(principal);
    const delegation = this.delegation(delegationId);
    const goal = this.get(delegation.goalId);
    if (
      goal.foremanId !== principal.foremanId ||
      delegation.state === "proposed" ||
      inactive.has(delegation.state)
    )
      this.#fail("Observation requires an approved delegation");
    this.assertAssignment(delegation);
    const team = this.discover().find((item) => item.id === delegation.groupId)!;
    let capture;
    if (memberId !== undefined) {
      const member = team.members.find((item) => item.memberId === memberId);
      if (member?.runId === undefined || member.generation === undefined)
        this.#fail("Member has no current runtime");
      capture = await reads.read({
        runId: member.runId,
        generation: member.generation,
        source: "history",
        maxLines: goal.grant.transcript.maxLines,
        maxBytes: goal.grant.transcript.maxBytes,
      });
      this.assertForeman(principal);
      this.assertAssignment(delegation);
      const current = this.store.getActiveRun(delegation.groupId, memberId);
      if (current?.id !== member.runId || current.generation !== member.generation)
        this.#fail("Runtime changed during observation");
    }
    return {
      untrustedEvidence: true,
      team,
      workspace: this.workspace(goal.id),
      ...(capture ? { capture } : {}),
    };
  }

  pauseForTakeover(runId: string) {
    for (const goal of this.list().filter((item) => item.state === "running")) {
      const foreman = this.store.getActiveForemanRun(goal.foremanId);
      const involved = this.workspace(goal.id).delegations.some((item) =>
        this.store
          .listActiveMemberships(item.groupId)
          .some((member) => this.store.getActiveRun(item.groupId, member.memberId)?.id === runId),
      );
      if (foreman?.id === runId || involved)
        this.control("human-terminal", {
          id: goal.id,
          expectedRevision: goal.revision,
          action: "pause",
        });
    }
  }

  authorizeInbox(inboxId: string) {
    const row = this.store.database
      .prepare("SELECT dedupe_key FROM foreman_inbox WHERE id = ?")
      .get(inboxId);
    const key = String(row?.dedupe_key ?? "");
    if (!key.startsWith("goal-review:")) return;
    const goal = this.get(key.split(":")[1]!);
    this.#running(goal.state === "awaiting-acceptance" ? { ...goal, state: "running" } : goal);
  }

  authorizeRecovery(groupId: string, memberId: string): boolean | undefined {
    const delegation = this.delegations().find(
      (item) => item.groupId === groupId && item.state !== "proposed" && !inactive.has(item.state),
    );
    if (!delegation) {
      const run = this.store.getLatestRunForMembership(groupId, memberId);
      const cancelled = this.delegations()
        .filter((item) => item.groupId === groupId && item.state === "cancelled")
        .at(-1);
      if (run && cancelled && Date.parse(run.startedAt) <= Date.parse(cancelled.updatedAt))
        return false;
      return undefined;
    }
    return this.store.atomic(() => {
      const goal = this.get(delegation.goalId);
      const run = this.store.getLatestRunForMembership(groupId, memberId);
      try {
        this.#running(goal);
        this.assertAssignment(delegation);
      } catch {
        return false;
      }
      if (
        goal.grant.mode !== "bounded" ||
        !goal.grant.recovery.restartDelegatedAgents ||
        !run ||
        run.desiredState !== "running" ||
        run.checkoutId !== delegation.checkoutId ||
        this.hasController(run.id) ||
        !["offered", "accepted", "working", "blocked"].includes(delegation.state)
      )
        return false;
      const incident = this.store.database
        .prepare("SELECT * FROM delegation_recovery WHERE delegation_id = ? AND member_id = ?")
        .get(delegation.id, memberId);
      const total = this.workspace(goal.id).delegations.reduce(
        (sum, item) =>
          sum +
          Number(
            this.store.database
              .prepare(
                "SELECT COALESCE(SUM(attempts), 0) AS total FROM delegation_recovery WHERE delegation_id = ?",
              )
              .get(item.id)!.total,
          ),
        0,
      );
      if (
        Number(incident?.attempts ?? 0) >= goal.grant.recovery.maxAttemptsPerIncident ||
        total >= goal.grant.recovery.maxAttemptsPerGoal ||
        Date.parse(String(incident?.next_allowed_at ?? "")) > this.now().getTime()
      )
        return false;
      this.store.database
        .prepare(
          `INSERT INTO delegation_recovery VALUES (?, ?, 1, ?, ?) ON CONFLICT(delegation_id, member_id) DO UPDATE SET attempts = attempts + 1, last_run_id = excluded.last_run_id, next_allowed_at = excluded.next_allowed_at`,
        )
        .run(
          delegation.id,
          memberId,
          run.id,
          new Date(this.now().getTime() + goal.grant.recovery.cooldownSeconds * 1000).toISOString(),
        );
      this.notify(`recovery:${delegation.id}:${memberId}:${Number(incident?.attempts ?? 0) + 1}`, {
        kind: "health",
        goalId: goal.id,
        delegationId: delegation.id,
        summary: `Authorized bounded recovery for ${memberId}; the replacement runtime must reconcile durable delegation state, not replay old work.`,
      });
      return true;
    });
  }

  #wake(goal: ForemanGoal, reason: string) {
    const prefix = `goal-review:${goal.id}:`;
    if (
      this.store.database
        .prepare(
          "SELECT id FROM foreman_inbox WHERE dedupe_key LIKE ? AND state IN ('queued', 'writing', 'submitted', 'ambiguous')",
        )
        .get(`${prefix}%`)
    )
      return;
    if (goal.turnsUsed >= goal.grant.maxForemanTurns) {
      goal.state = "blocked";
      goal.revision++;
      this.#save("goal", goal);
      this.notify(`turn-limit:${goal.id}`, {
        kind: "health",
        goalId: goal.id,
        summary: "Foreman review budget exhausted; human input required.",
      });
      return;
    }
    const timestamp = this.#timestamp();
    this.store.database
      .prepare(
        `INSERT INTO foreman_inbox (id, dedupe_key, prompt, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        `inbox_${randomUUID()}`,
        `${prefix}${randomUUID()}`,
        `Supervise goal ${goal.id}. ${reason} Read nanasa.foreman_get_goal and nanasa.foreman_observe_team. The team owns research, planning, implementation and review; do not take over its task orchestration. Ask the accountable member for context only when needed. Finish with nanasa.foreman_finish_goal_review.`,
        timestamp,
        timestamp,
      );
    goal.turnsUsed++;
    this.#save("goal", goal);
  }

  finishReview(principal: McpForemanPrincipal, goalId: string) {
    this.assertForeman(principal);
    const goal = this.get(goalId);
    if (goal.foremanId !== principal.foremanId) this.#fail("Goal belongs to another Foreman");
    this.store.database
      .prepare(
        "UPDATE foreman_inbox SET state = 'answered', updated_at = ? WHERE dedupe_key LIKE ? AND state IN ('queued', 'submitted')",
      )
      .run(this.#timestamp(), `goal-review:${goalId}:%`);
    return this.workspace(goalId);
  }

  start(actions: AgentActionService, coordinator: Pick<RunRuntimeCoordinator, "startRun">) {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick(actions, coordinator).catch(() => undefined);
    }, 1000);
    this.#timer.unref();
  }
  async close() {
    if (this.#timer) clearInterval(this.#timer);
    await this.#pending;
  }
  tick(actions: AgentActionService, coordinator: Pick<RunRuntimeCoordinator, "startRun">) {
    if (this.#pending) return this.#pending;
    this.#pending = this.#reconcile(actions, coordinator).finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }
  async #reconcile(
    actions: AgentActionService,
    coordinator: Pick<RunRuntimeCoordinator, "startRun">,
  ) {
    for (const current of this.list().filter((goal) => goal.state === "running")) {
      try {
        this.#running(current);
      } catch {
        this.store.atomic(() => {
          this.#save("goal", { ...current, state: "blocked", revision: current.revision + 1 });
          this.notify(`policy:${current.id}:${current.revision}`, {
            kind: "health",
            goalId: current.id,
            summary:
              "Goal paused by time or repository policy limits. Human reconciliation required.",
          });
        });
        continue;
      }
      const run = this.store.getActiveForemanRun(current.foremanId);
      if (!run || run.status === "failed")
        this.notify(`foreman-offline:${current.id}:${run?.id ?? "none"}`, {
          kind: "health",
          goalId: current.id,
          summary: "Foreman is unavailable; supervision cannot currently reach the model.",
        });
      const delegates = this.workspace(current.id).delegations.filter(
        (item) => !inactive.has(item.state),
      );
      if (
        !delegates.length &&
        !this.store.database
          .prepare("SELECT id FROM foreman_inbox WHERE dedupe_key LIKE ?")
          .get(`goal-review:${current.id}:%`)
      )
        this.store.atomic(() =>
          this.#wake(
            this.get(current.id),
            "Discover an eligible team and propose an accountable owner for this goal.",
          ),
        );
      for (const delegation of delegates) {
        try {
          if (delegation.state === "proposed") continue;
          this.assertAssignment(delegation);
          if (delegation.state === "queued" && run !== undefined) {
            for (const member of this.store.listActiveMemberships(delegation.groupId)) {
              if (!this.store.getLatestRunForMembership(delegation.groupId, member.memberId))
                await coordinator.startRun(delegation.groupId, member.memberId, {
                  cols: 120,
                  rows: 36,
                });
            }
            const target = this.store.getActiveRun(delegation.groupId, delegation.memberId);
            const status = this.store.getAgentStatus(delegation.groupId, delegation.memberId);
            if (
              !target ||
              status.state !== "idle" ||
              !status.interactiveReady ||
              status.staleAuthority ||
              status.authorityKind !== "reporter" ||
              status.processState !== "present"
            )
              continue;
            this.store.atomic(() => {
              const goal = this.get(current.id);
              const actor = this.store.getForeman(goal.foremanId);
              const principal = {
                kind: "foreman" as const,
                foremanId: goal.foremanId,
                runId: run.id,
                generation: run.generation,
                authorityRevision: actor.authorityRevision,
                goalId: goal.id,
                delegationId: delegation.id,
                goalRevision: goal.revision + 1,
              };
              const action = actions.create(
                principal,
                CreateAgentActionCommandSchema.parse({
                  kind: "prompt",
                  groupId: delegation.groupId,
                  memberId: delegation.memberId,
                  expectedRunId: target.id,
                  expectedGeneration: target.generation,
                  expectedStatusRevision: status.statusRevision,
                  prompt: `Nanasa outcome delegation ${delegation.id}; goal ${goal.id}.\nObjective: ${goal.objective}\nConstraints: ${goal.constraints.join("; ")}\n${delegation.brief}\nYou are the accountable team lead. Own research, planning, implementation, independent review and evidence. Discover peers dynamically. Use nanasa.team_delegations to read durable context; nanasa.report_delegation to accept and report milestones; nanasa.request_human_decision for decisions beyond authority. Report ready only after team work and review finish. A model turn ending does not complete this delegation.`,
                }),
                `delegation:${delegation.id}`,
              );
              this.#save("delegation", {
                ...delegation,
                state: "offered",
                revision: delegation.revision + 1,
                actionId: action.id,
                runId: target.id,
                generation: target.generation,
                nextCheckAt: new Date(this.now().getTime() + 900000).toISOString(),
              });
              this.store.database
                .prepare("INSERT OR IGNORE INTO delegation_actions VALUES (?, ?)")
                .run(action.id, delegation.id);
            });
          }
          if (["accepted", "working", "blocked"].includes(delegation.state) && run !== undefined) {
            const resolved = this.workspace(current.id).decisions.filter(
              (decision) =>
                decision.state === "resolved" &&
                decision.kind === "question" &&
                (decision.delegationId === undefined || decision.delegationId === delegation.id),
            );
            for (const decision of resolved) {
              const key = `decision-notice:${delegation.id}:${decision.id}`;
              if (
                this.store
                  .listAgentActions(delegation.groupId)
                  .some((action) => action.idempotencyKey === key)
              )
                continue;
              const target = this.store.getActiveRun(delegation.groupId, delegation.memberId);
              const status = this.store.getAgentStatus(delegation.groupId, delegation.memberId);
              if (
                !target ||
                status.state !== "idle" ||
                status.staleAuthority ||
                !status.interactiveReady
              )
                continue;
              this.store.atomic(() => {
                const goal = this.get(current.id);
                const actor = this.store.getForeman(goal.foremanId);
                const action = actions.create(
                  {
                    kind: "foreman",
                    foremanId: goal.foremanId,
                    runId: run.id,
                    generation: run.generation,
                    authorityRevision: actor.authorityRevision,
                    goalId: goal.id,
                    delegationId: delegation.id,
                    goalRevision: goal.revision + 1,
                  },
                  CreateAgentActionCommandSchema.parse({
                    kind: "prompt",
                    groupId: delegation.groupId,
                    memberId: delegation.memberId,
                    expectedRunId: target.id,
                    expectedGeneration: target.generation,
                    expectedStatusRevision: status.statusRevision,
                    prompt: `Human decision ${decision.id} for delegation ${delegation.id} has been resolved. Read nanasa.team_delegations before continuing. The answer is scoped to that question and grants no additional runtime privileges.`,
                  }),
                  key,
                );
                this.store.database
                  .prepare("INSERT OR IGNORE INTO delegation_actions VALUES (?, ?)")
                  .run(action.id, delegation.id);
              });
              break;
            }
          }
          if (
            Date.parse(delegation.nextCheckAt) <= this.now().getTime() &&
            delegation.state !== "queued"
          ) {
            const team = this.discover().find((item) => item.id === delegation.groupId)!;
            const issues = team.members.filter(
              (member) =>
                ["failed", "blocked", "unknown", "stopped"].includes(member.status.state) ||
                member.status.staleAuthority,
            );
            this.store.atomic(() => {
              this.#wake(
                this.get(current.id),
                `Team ${delegation.groupId} is due for a progress review. ${issues.length ? "Some members need health inspection." : "Do not confuse quiet or long-running work with failure."}`,
              );
              this.#save("delegation", {
                ...this.delegation(delegation.id),
                nextCheckAt: new Date(
                  this.now().getTime() +
                    Math.max(30, this.config().foreman?.supervision.reviewIntervalSeconds ?? 300) *
                      1000,
                ).toISOString(),
              });
              if (issues.length)
                this.notify(
                  `team-health:${delegation.id}:${issues.map((member) => `${member.memberId}:${member.runId}:${member.status.state}`).join(",")}`,
                  {
                    kind: "health",
                    goalId: current.id,
                    delegationId: delegation.id,
                    summary:
                      `Team health requires inspection: ${issues.map((member) => `${member.alias}: ${member.status.state}`).join(", ")}`.slice(
                        0,
                        2000,
                      ),
                  },
                );
            });
          }
        } catch (error) {
          this.notify(`delegation-problem:${delegation.id}:${delegation.revision}`, {
            kind: "health",
            goalId: current.id,
            delegationId: delegation.id,
            summary:
              error instanceof DomainError
                ? error.message
                : "Delegation reconciliation failed; inspect the retained state.",
          });
        }
      }
    }
  }
}
