import { createHash, randomUUID } from "node:crypto";
import {
  AssignForemanOutcomeCommandSchema,
  canonicalJson,
  type ForemanPreparation,
  ForemanPreparationSchema,
} from "@nanasa/contracts";
import type { ForemanGoalService } from "./foreman-goal-service.js";
import type { CheckoutService } from "./git/checkout-service.js";
import type { WorktreeService } from "./git/worktree-service.js";
import type { McpForemanPrincipal } from "./mcp-auth.js";
import type { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
import { DomainError, type NanasaStore } from "./store.js";

type RuntimeStep = {
  memberId: string;
  runId?: string;
  generation?: number;
  state: "intent" | "done";
};
type Preparation = ForemanPreparation & {
  foremanId: string;
  authorityRevision: number;
  membershipRevision: number;
  checkoutRevision: number;
  originalCheckoutId: string;
  bound: boolean;
  assignmentPending?: boolean;
  createdWorkspace?: boolean;
  stops: RuntimeStep[];
  starts: RuntimeStep[];
};
const finished = new Set(["ready", "delegated", "cancelled", "expired", "held"]);

export class ForemanOrchestrationService {
  #pending: Promise<void> | undefined;
  #closing = false;

  constructor(
    private readonly store: NanasaStore,
    private readonly goals: ForemanGoalService,
    private readonly checkouts: Pick<CheckoutService, "refresh">,
    private readonly worktrees: Pick<WorktreeService, "create">,
    private readonly coordinator: Pick<
      RunRuntimeCoordinator,
      "startRun" | "stopRun" | "assignGroupCheckout"
    >,
    private readonly now: () => Date = () => new Date(),
  ) {
    store.database.exec(`CREATE TABLE IF NOT EXISTS foreman_preparations (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, group_id TEXT NOT NULL,
      request_id TEXT NOT NULL, request_digest TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(goal_id, request_id)
    )`);
    goals.attachPreparation(this);
  }

  list(goalId: string): ForemanPreparation[] {
    return this.#records()
      .filter((item) => item.goalId === goalId)
      .map((item) => this.#public(item));
  }

  authorizeRecovery(groupId: string, memberId: string): boolean | undefined {
    const run = this.store.getLatestRunForMembership(groupId, memberId);
    return run &&
      this.#records().some(
        (item) =>
          item.groupId === groupId &&
          item.checkoutId === run.checkoutId &&
          item.phase !== "delegated" &&
          item.starts.some(
            (step) =>
              step.memberId === memberId && (step.runId === run.id || step.state === "intent"),
          ),
      )
      ? false
      : undefined;
  }

  assignOutcome(principal: McpForemanPrincipal, command: unknown) {
    return this.#request(principal, command, "assign");
  }

  prepareWorkspace(principal: McpForemanPrincipal, command: unknown) {
    return this.#request(principal, command, "prepare");
  }

  async #request(
    principal: McpForemanPrincipal,
    command: unknown,
    operation: Preparation["operation"],
  ) {
    this.goals.assertForeman(principal);
    if (this.#closing)
      throw new DomainError("foreman_preparation_closed", "Preparation is shutting down", 503);
    const input = AssignForemanOutcomeCommandSchema.parse(command);
    const digest = createHash("sha256").update(canonicalJson({ operation, input })).digest("hex");
    const record = this.store.atomic(() => {
      const existing = this.#records().find(
        (item) => item.goalId === input.goalId && item.requestId === input.requestId,
      );
      if (existing) {
        if (existing.requestDigest !== digest)
          throw new DomainError(
            "foreman_preparation_conflict",
            "Request ID was reused with different preparation content",
            409,
          );
        return existing;
      }
      const { goal } = this.goals.authorizePreparation(principal, input.goalId);
      const group = this.store.getGroup(input.groupId);
      if (
        !this.store
          .listActiveMemberships(group.id)
          .some((member) => member.memberId === input.memberId)
      )
        throw new DomainError(
          "foreman_owner_unavailable",
          "Selected accountable member is not active in this team",
          409,
        );
      const source = this.store.getEffectiveGroupCheckout(group.id);
      if (!source)
        throw new DomainError("foreman_source_missing", "The team has no repository checkout", 409);
      if (input.workspace !== "existing" && input.checkoutId)
        throw new DomainError(
          "foreman_workspace_invalid",
          "checkoutId is only valid with workspace existing",
          400,
        );
      const outstanding = this.#records().filter(
        (item) => item.goalId === goal.id && !finished.has(item.phase),
      );
      if (outstanding.length >= goal.grant.maxTeamsPerGoal)
        throw new DomainError(
          "foreman_preparation_capacity",
          "Goal preparation capacity exhausted",
          409,
        );
      const timestamp = this.now().toISOString();
      const created: Preparation = {
        ...input,
        id: `preparation_${randomUUID()}`,
        requestDigest: digest,
        operation,
        phase: "waiting",
        foremanId: principal.foremanId,
        authorityRevision: principal.authorityRevision,
        membershipRevision: group.membershipRevision,
        checkoutRevision: group.checkoutRevision,
        originalCheckoutId: source.id,
        sourceCheckoutId: input.sourceCheckoutId ?? source.id,
        branch: `foreman/${createHash("sha256").update(`${goal.id}:${input.requestId}`).digest("hex").slice(0, 32)}`,
        retryCount: 0,
        nextAttemptAt: timestamp,
        deadline: new Date(
          Math.min(Date.parse(goal.expiresAt), this.now().getTime() + 600_000),
        ).toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp,
        bound: false,
        stops: [],
        starts: [],
      };
      this.store.database
        .prepare("INSERT INTO foreman_preparations VALUES (?, ?, ?, ?, ?, ?)")
        .run(created.id, goal.id, group.id, input.requestId, digest, JSON.stringify(created));
      return created;
    });
    await this.tick();
    return this.#public(this.#records().find((item) => item.id === record.id)!);
  }

  #records(): Preparation[] {
    return this.store.database
      .prepare("SELECT data_json FROM foreman_preparations ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.data_json)) as Preparation);
  }

  #public(record: Preparation): ForemanPreparation {
    return ForemanPreparationSchema.strip().parse(record);
  }

  #save(record: Preparation, phase = record.phase, reason?: string) {
    const changed = phase !== record.phase || reason !== record.reason;
    record.phase = phase;
    if (reason === undefined) delete record.reason;
    else record.reason = reason;
    record.updatedAt = this.now().toISOString();
    record.nextAttemptAt = new Date(this.now().getTime() + 1000).toISOString();
    this.store.database
      .prepare("UPDATE foreman_preparations SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(record), record.id);
    if (changed)
      this.goals.notify(`preparation:${record.id}:${phase}:${reason ?? ""}`, {
        kind: "health",
        goalId: record.goalId,
        summary: `Team ${record.groupId} preparation ${phase}${reason ? `: ${reason}` : ""}`,
      });
  }

  #principal(record: Preparation): McpForemanPrincipal {
    const run = this.store.getActiveForemanRun(record.foremanId);
    if (!run)
      throw new DomainError("foreman_unavailable", "Foreman must be running to prepare work", 409);
    return {
      kind: "foreman",
      foremanId: record.foremanId,
      runId: run.id,
      generation: run.generation,
      authorityRevision: record.authorityRevision,
    };
  }

  #fence(record: Preparation) {
    if (Date.parse(record.deadline) <= this.now().getTime())
      throw new DomainError("preparation_deadline_exceeded", "Preparation deadline exceeded", 409);
    const authorized = this.goals.authorizePreparation(this.#principal(record), record.goalId);
    const group = this.store.getGroup(record.groupId);
    if (
      group.membershipRevision !== record.membershipRevision ||
      group.checkoutRevision !== record.checkoutRevision ||
      this.store.getEffectiveGroupCheckout(group.id)?.id !==
        (record.bound ? record.checkoutId : record.originalCheckoutId)
    )
      throw new DomainError(
        "foreman_preparation_stale",
        "Team membership or checkout changed during preparation",
        409,
      );
    const blocked = this.goals
      .assessTeam(group.id)
      .blockers.find((item) =>
        [
          "human_controlled",
          "team_reserved",
          "unsettled_work",
          "runtime_checkout_changed",
          "no_members",
        ].includes(item.code),
      );
    if (blocked) throw new DomainError(blocked.code, blocked.message, 409);
    for (const member of this.store.listActiveMemberships(group.id)) {
      const latest = this.store.getLatestRunForMembership(group.id, member.memberId);
      if (latest?.desiredState !== "stopped") continue;
      const owner = this.#records().find(
        (item) =>
          item.goalId === record.goalId &&
          item.groupId === group.id &&
          latest.recoveryReason === `foreman-preparation:${item.id}` &&
          item.stops.some(
            (step) =>
              step.runId === latest.id &&
              step.generation === latest.generation &&
              (step.state === "done" || (item.id === record.id && latest.status === "stopping")),
          ),
      );
      if (!owner)
        throw new DomainError(
          "foreman_human_stop",
          "An explicit or unclassified stopped run requires Human reconciliation",
          409,
        );
    }
    const decisions = this.goals.workspace(record.goalId).decisions;
    if (
      decisions.some(
        (item) => item.id !== record.decisionId && item.blocking && item.state === "pending",
      )
    )
      throw new DomainError(
        "foreman_human_decision_pending",
        "Goal is waiting for a Human decision",
        409,
      );
    if (record.decisionId) {
      const decision = decisions.find((item) => item.id === record.decisionId);
      if (
        !decision ||
        decision.state !== "resolved" ||
        decision.answer !== "approve" ||
        decision.goalRevision !== authorized.goal.revision ||
        !decision.decidedBy ||
        decision.decidedBy.startsWith("foreman-policy:")
      )
        throw new DomainError(
          "foreman_preparation_approval_required",
          "Preparation needs its scoped Human approval",
          403,
        );
    } else if (!authorized.automatic) {
      throw new DomainError(
        "foreman_preparation_approval_required",
        "Preparation requires Human approval",
        403,
      );
    }
    return authorized;
  }

  tick(): Promise<void> {
    if (this.#closing) return Promise.resolve();
    if (this.#pending) return this.#pending;
    this.#pending = this.#reconcile().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async close() {
    this.#closing = true;
    await this.#pending;
  }

  async #reconcile() {
    for (const record of this.#records()) {
      if (finished.has(record.phase) || Date.parse(record.nextAttemptAt) > this.now().getTime())
        continue;
      if (this.#reconcileDelegation(record)) continue;
      const goal = this.goals.get(record.goalId);
      if (["completed", "cancelled"].includes(goal.state)) {
        this.#save(record, "cancelled", "goal_stopped");
        continue;
      }
      if (Date.parse(record.deadline) <= this.now().getTime()) {
        this.#save(record, "expired", "preparation_deadline_exceeded");
        continue;
      }
      if (goal.state !== "running") {
        this.#save(record, "waiting", "goal_paused");
        continue;
      }
      try {
        await this.#advance(record);
      } catch (error) {
        if (this.#reconcileDelegation(record)) continue;
        const currentGoal = this.goals.get(record.goalId);
        if (currentGoal.state !== "running") {
          this.#save(
            record,
            ["completed", "cancelled"].includes(currentGoal.state) ? "cancelled" : "waiting",
            "goal_stopped",
          );
          continue;
        }
        record.retryCount++;
        const code = error instanceof DomainError ? error.code : "preparation_effect_uncertain";
        const waiting = [
          "foreman_unavailable",
          "team_reserved",
          "unsettled_work",
          "foreman_human_decision_pending",
        ].includes(code);
        this.#save(
          record,
          code === "preparation_deadline_exceeded" ? "expired" : waiting ? "waiting" : "held",
          code,
        );
      }
    }
  }

  #reconcileDelegation(record: Preparation) {
    const delegation = this.goals
      .delegations()
      .find((item) => item.requestId === record.id && item.goalId === record.goalId);
    if (!delegation) return false;
    if (
      delegation.groupId !== record.groupId ||
      delegation.memberId !== record.memberId ||
      delegation.brief !== record.brief ||
      delegation.checkoutId !== record.checkoutId
    )
      throw new DomainError(
        "foreman_preparation_conflict",
        "Retained delegation does not match preparation",
        409,
      );
    record.delegationId = delegation.id;
    this.#save(record, delegation.state === "cancelled" ? "cancelled" : "delegated");
    return true;
  }

  async #advance(record: Preparation) {
    const principal = this.#principal(record);
    const { automatic, goal } = this.goals.authorizePreparation(principal, record.goalId);
    const prior = this.#records().find(
      (item) => item.groupId === record.groupId && !finished.has(item.phase),
    );
    if (prior?.id !== record.id) return this.#save(record, "waiting", "team_preparation_reserved");
    if (
      this.goals
        .workspace(goal.id)
        .delegations.filter((item) => !["completed", "cancelled"].includes(item.state)).length >=
      goal.grant.maxTeamsPerGoal
    )
      return this.#save(record, "waiting", "goal_team_capacity");

    const sourceId = record.sourceCheckoutId!;
    await this.checkouts.refresh(sourceId);
    const source = this.store.getCheckout(sourceId);
    record.sourceDirty = source.dirty;
    if (source.kind === "bare" || !source.head)
      throw new DomainError(
        "foreman_source_commit_missing",
        "Preparation requires a non-bare source with a committed base",
        409,
      );
    if (source.repositoryId !== this.store.getCheckout(record.originalCheckoutId).repositoryId)
      throw new DomainError(
        "foreman_repository_mismatch",
        "Source must belong to the team's repository",
        409,
      );
    if (!record.sourceHead) {
      record.sourceHead = source.head;
      this.#save(record);
    }

    if (!automatic && !record.decisionId) {
      const decision = this.goals.requestPreparationApproval(principal, {
        requestId: record.id,
        goalId: record.goalId,
        question: `Approve one scoped ${record.operation} plan for team ${record.groupId}, owner ${record.memberId}? Workspace ${record.workspace}, source ${sourceId} at ${record.sourceHead}, target ${record.checkoutId ?? record.branch}. Allow isolated worktree preparation, stopping only verified idle team runs, checkout assignment${record.operation === "assign" ? ", routine member startup and outcome delegation" : ""}. Explicit Human holds, dirty work and provider permissions remain protected. Request digest: ${record.requestDigest}. Outcome (full scope in preparation): ${record.brief.slice(0, 4000)}`,
        options: ["approve", "deny"],
        blocking: true,
      });
      record.decisionId = decision.id;
      return this.#save(record, "needs-approval", "scoped_plan_approval_required");
    }
    if (record.decisionId) {
      const decision = this.goals
        .workspace(goal.id)
        .decisions.find((item) => item.id === record.decisionId)!;
      if (decision.state === "pending")
        return this.#save(record, "needs-approval", "scoped_plan_approval_required");
      if (decision.answer === "deny") return this.#save(record, "cancelled", "plan_denied");
    }

    if (
      record.assignmentPending &&
      !record.bound &&
      record.checkoutId &&
      this.store.getEffectiveGroupCheckout(record.groupId)?.id === record.checkoutId &&
      this.store.getGroup(record.groupId).checkoutRevision === record.checkoutRevision + 1
    ) {
      record.checkoutRevision++;
      record.bound = true;
      this.#save(record);
    }
    if (
      record.stops.some((step) => step.state === "intent") ||
      record.starts.some((step) => step.state === "intent")
    )
      throw new DomainError(
        "foreman_runtime_effect_uncertain",
        "Interrupted runtime effects require inspection; they will not be replayed",
        409,
      );
    this.#fence(record);
    const blockers = this.goals.assessTeam(record.groupId).blockers;
    if (blockers.some((item) => item.code === "runtime_not_ready"))
      return this.#save(record, "waiting", "runtime_not_ready");

    if (!record.checkoutId) {
      if (record.originalCheckoutId !== sourceId)
        await this.checkouts.refresh(record.originalCheckoutId);
      const current = this.store.getCheckout(record.originalCheckoutId);
      const managed = this.store
        .listWorktrees(source.repositoryId)
        .find((item) => item.checkoutId === current.id && item.state === "ready");
      if (
        record.workspace === "existing" ||
        (record.workspace === "auto" &&
          current.kind === "linked" &&
          !current.dirty &&
          current.head === record.sourceHead &&
          managed)
      ) {
        record.checkoutId = current.id;
      } else {
        record.createdWorkspace = true;
        this.#save(record, "preparing");
        const result = await this.worktrees.create(
          { sourceCheckoutId: sourceId, branch: record.branch, base: record.sourceHead },
          {
            provenanceToken: record.requestDigest,
            beforeEffect: () => {
              this.#fence(record);
            },
          },
        );
        if (!result.checkout)
          throw new DomainError(
            "foreman_workspace_incomplete",
            "Worktree creation has no checkout receipt",
            409,
          );
        record.checkoutId = result.checkout.id;
      }
      this.#save(record);
    }
    await this.checkouts.refresh(record.checkoutId);
    if (record.checkoutId !== sourceId) await this.checkouts.refresh(sourceId);
    const refreshedSource = this.store.getCheckout(sourceId);
    record.sourceDirty = refreshedSource.dirty;
    if (
      refreshedSource.repositoryId !== source.repositoryId ||
      refreshedSource.checkoutKey !== source.checkoutKey ||
      refreshedSource.path !== source.path
    )
      throw new DomainError(
        "foreman_source_changed",
        "Source identity changed during preparation; Human reconciliation is required",
        409,
      );
    this.#fence(record);
    const target = this.store.getCheckout(record.checkoutId);
    if (target.repositoryId !== source.repositoryId || target.kind !== "linked" || target.dirty)
      throw new DomainError(
        "foreman_workspace_unsuitable",
        "Workspace must be a clean linked checkout in the same repository",
        409,
      );
    if (!record.bound && target.head !== record.sourceHead)
      throw new DomainError(
        "foreman_workspace_base_changed",
        "Prepared workspace no longer matches the pinned source commit",
        409,
      );
    if (
      this.store
        .getSnapshot()
        .groups.some(
          (item) =>
            item.id !== record.groupId &&
            this.store.getEffectiveGroupCheckout(item.id)?.id === target.id,
        ) ||
      this.goals
        .delegations()
        .some(
          (item) =>
            item.checkoutId === target.id && !["completed", "cancelled"].includes(item.state),
        ) ||
      this.#records().some(
        (item) =>
          item.id !== record.id && item.checkoutId === target.id && !finished.has(item.phase),
      )
    )
      return this.#save(record, "waiting", "checkout_reserved");

    this.store.validateGroupCheckoutAssignment(record.groupId, target.id, record.checkoutRevision);
    if (!record.bound && target.id !== record.originalCheckoutId) {
      for (const run of this.store.listGroupRunsRequiringStop(record.groupId)) {
        if (record.stops.some((step) => step.memberId === run.memberId && step.state === "intent"))
          throw new DomainError(
            "foreman_stop_uncertain",
            "An interrupted stop requires inspection; it will not be replayed",
            409,
          );
        const step: RuntimeStep = {
          memberId: run.memberId,
          runId: run.id,
          generation: run.generation,
          state: "intent",
        };
        record.stops.push(step);
        this.#save(record, "stopping");
        await this.coordinator.stopRun(record.groupId, run.memberId, {
          reason: `foreman-preparation:${record.id}`,
          beforeFinalize: () => {
            this.#fence(record);
          },
          beforeEffect: () => {
            this.#fence(record);
            const current = this.store.getLatestRunForMembership(record.groupId, run.memberId);
            const status = this.store.getAgentStatus(record.groupId, run.memberId);
            if (
              current?.id !== run.id ||
              current.generation !== run.generation ||
              current.desiredState !== "running" ||
              (this.store.getActiveRun(record.groupId, run.memberId) &&
                (status.state !== "idle" || status.staleAuthority || !status.interactiveReady))
            )
              throw new DomainError(
                "foreman_runtime_changed",
                "Runtime changed before preparation stop",
                409,
              );
          },
        });
        step.state = "done";
        this.#save(record);
      }
      record.assignmentPending = true;
      this.#save(record, "assigning");
      const result = await this.coordinator.assignGroupCheckout(
        record.groupId,
        {
          checkoutId: target.id,
          expectedCheckoutRevision: record.checkoutRevision,
          switchPolicy: "require-stopped",
        },
        () => {
          this.#fence(record);
        },
      );
      record.checkoutRevision = result.group.checkoutRevision;
    }
    record.bound = true;
    this.#save(record);
    if (record.operation === "prepare") return this.#save(record, "ready");

    for (const member of this.store.listActiveMemberships(record.groupId)) {
      if (this.store.getActiveRun(record.groupId, member.memberId)) continue;
      const previous = this.store.getLatestRunForMembership(record.groupId, member.memberId);
      if (record.starts.some((step) => step.memberId === member.memberId))
        throw new DomainError(
          "foreman_start_uncertain",
          "A prior start needs inspection; it will not be replayed",
          409,
        );
      const step: RuntimeStep = { memberId: member.memberId, state: "intent" };
      record.starts.push(step);
      this.#save(record, "starting");
      const result = await this.coordinator.startRun(
        record.groupId,
        member.memberId,
        { cols: 120, rows: 36 },
        () => {
          this.#fence(record);
          const latest = this.store.getLatestRunForMembership(record.groupId, member.memberId);
          if (
            latest?.id !== previous?.id ||
            latest?.generation !== previous?.generation ||
            latest?.desiredState !== previous?.desiredState
          )
            throw new DomainError(
              "foreman_runtime_changed",
              "Runtime changed before preparation start",
              409,
            );
        },
      );
      if (result.status !== "started") {
        this.#save(record, "held", `provider_launch_${result.status}`);
        return;
      }
      step.runId = result.run.id;
      step.generation = result.run.generation;
      step.state = "done";
      this.#save(record);
    }
    this.#fence(record);
    const readiness = this.goals.assessTeam(record.groupId).blockers[0];
    if (readiness) return this.#save(record, "waiting", readiness.code);
    if (
      this.store.listActiveMemberships(record.groupId).some((member) => {
        const status = this.store.getAgentStatus(record.groupId, member.memberId);
        return status.authorityKind !== "reporter" || status.processState !== "present";
      })
    )
      return this.#save(record, "waiting", "reporter_readiness_required");

    this.#save(record, "delegating");
    const group = this.store.getGroup(record.groupId);
    const delegation = this.goals.delegatePrepared(
      this.#principal(record),
      {
        requestId: record.id,
        goalId: record.goalId,
        groupId: record.groupId,
        memberId: record.memberId,
        brief: record.brief,
        rationale: "Accountable outcome assignment after durable workspace and runtime preparation",
        expectedRevision: this.goals.get(record.goalId).revision,
        expectedMembershipRevision: group.membershipRevision,
        expectedCheckoutRevision: group.checkoutRevision,
      },
      record.decisionId,
    );
    record.delegationId = delegation.id;
    this.#save(record, "delegated");
  }
}
