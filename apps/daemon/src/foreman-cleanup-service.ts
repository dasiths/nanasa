import { createHash, randomUUID } from "node:crypto";
import {
  ApproveForemanCleanupCommandSchema,
  CleanupForemanCommandSchema,
  type CleanupForemanResult,
  canonicalJson,
  type ForemanCleanupRequest,
  ForemanCleanupRequestSchema,
  type ForemanConversationRequest,
  RequestForemanCleanupCommandSchema,
} from "@nanasa/contracts";
import type { ForemanGoalService } from "./foreman-goal-service.js";
import { DomainError, type NanasaStore } from "./store.js";

const terminalGoals = new Set(["completed", "cancelled"]);
const settledActions = new Set(["completed", "cancelled", "rejected", "expired", "superseded"]);

type PreparationRuntimeEffects = {
  groupId: string;
  checkoutId?: string;
  starts?: { memberId: string; runId?: string; state: "intent" | "done" }[];
  stops?: { memberId: string; runId?: string; state: "intent" | "done" }[];
};

export class ForemanCleanupService {
  constructor(
    private readonly store: NanasaStore,
    private readonly goals: ForemanGoalService,
  ) {}

  requests(foremanId?: string, id?: string): ForemanCleanupRequest[] {
    return this.store.database
      .prepare("SELECT data_json FROM foreman_cleanup_requests ORDER BY rowid")
      .all()
      .map((row) => ForemanCleanupRequestSchema.parse(JSON.parse(String(row.data_json))))
      .filter(
        (request) =>
          (foremanId === undefined || request.foremanId === foremanId) &&
          (id === undefined ? request.state === "pending" : request.id === id),
      );
  }

  request(foremanId: string, command: unknown): ForemanCleanupRequest {
    const input = RequestForemanCleanupCommandSchema.parse(command);
    const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
    return this.store.atomic(() => {
      const previous = this.store.database
        .prepare(
          "SELECT data_json FROM foreman_cleanup_requests WHERE foreman_id = ? AND request_id = ?",
        )
        .get(foremanId, input.requestId);
      if (previous) {
        const receipt = ForemanCleanupRequestSchema.parse(JSON.parse(String(previous.data_json)));
        if (receipt.digest !== digest)
          throw new DomainError(
            "foreman_cleanup_conflict",
            "Cleanup request ID was reused with different content",
            409,
          );
        return receipt;
      }
      const request: ForemanCleanupRequest = {
        id: randomUUID(),
        foremanId,
        command: input,
        digest,
        state: "pending",
        createdAt: new Date().toISOString(),
      };
      this.store.database
        .prepare("INSERT INTO foreman_cleanup_requests VALUES (?, ?, ?, ?)")
        .run(request.id, foremanId, input.requestId, JSON.stringify(request));
      return request;
    });
  }

  approve(operatorId: string, command: unknown): ForemanCleanupRequest {
    const input = ApproveForemanCleanupCommandSchema.parse(command);
    return this.store.atomic(() => {
      const request = this.requests(undefined, input.id)[0];
      if (!request)
        throw new DomainError("foreman_cleanup_not_found", "Cleanup request is unavailable", 404);
      if (request.digest !== input.digest)
        throw new DomainError(
          "foreman_cleanup_conflict",
          "Cleanup scope differs from the confirmed request",
          409,
        );
      if (request.state === "approved") return request;
      const result = this.execute(operatorId, {
        ...request.command,
        requestId: request.id,
        confirmation: true,
      });
      const approved: ForemanCleanupRequest = {
        ...request,
        state: "approved",
        operatorId,
        approvedAt: new Date().toISOString(),
        result,
      };
      this.store.database
        .prepare("UPDATE foreman_cleanup_requests SET data_json = ? WHERE id = ?")
        .run(JSON.stringify(approved), request.id);
      return approved;
    });
  }

  isRemoved(goalId: string): boolean {
    return (
      this.store.database
        .prepare("SELECT 1 FROM foreman_removed_goals WHERE goal_id = ?")
        .get(goalId) !== undefined
    );
  }

  listGoals() {
    return this.goals.list().filter((goal) => !this.isRemoved(goal.id));
  }

  visibleConversations(conversations: ForemanConversationRequest[]) {
    const hidden = new Set(
      this.store.database
        .prepare(`
      WITH RECURSIVE hidden(id) AS (
        SELECT id FROM foreman_conversations
        WHERE id IN (SELECT conversation_id FROM foreman_cleared_conversations)
          OR json_extract(data_json, '$.sourceMessageId') IN (SELECT message_id FROM foreman_cleared_messages)
        UNION
        SELECT conversation.id FROM foreman_conversations conversation
        JOIN hidden ON json_extract(conversation.data_json, '$.replyTo') = hidden.id
      ) SELECT id FROM hidden
    `)
        .all()
        .map((row) => String(row.id)),
    );
    return conversations.filter((conversation) => !hidden.has(conversation.id));
  }

  pendingEffects(goalIds?: string[]): CleanupForemanResult["pendingEffects"] {
    const actions = new Map(this.store.listAgentActions().map((action) => [action.id, action]));
    return this.store.database
      .prepare("SELECT goal_id, data_json FROM foreman_cleanup_effects")
      .all()
      .filter((row) => goalIds === undefined || goalIds.includes(String(row.goal_id)))
      .flatMap((row) => {
        const recorded = JSON.parse(
          String(row.data_json),
        ) as CleanupForemanResult["pendingEffects"][number];
        const owned = this.#ownedEffects(String(row.goal_id));
        const actionIds = recorded.actionIds.filter((id) => {
          const action = actions.get(id);
          return (
            (owned === undefined || owned.actionIds.has(id)) &&
            action !== undefined &&
            !settledActions.has(action.state)
          );
        });
        const runIds = recorded.runIds.filter(
          (id) =>
            (owned === undefined || owned.runIds.has(id)) &&
            this.store.database
              .prepare(
                "SELECT 1 FROM runs WHERE id = ? AND status IN ('starting', 'running', 'stopping')",
              )
              .get(id) !== undefined,
        );
        return actionIds.length || runIds.length
          ? [{ goalId: recorded.goalId, actionIds, runIds }]
          : [];
      });
  }

  reconcileRemovedEffects(goalIds?: string[]): void {
    this.store.atomic(() => {
      const removed = this.store.database
        .prepare(`
          SELECT removed.goal_id, removed.operator_id FROM foreman_removed_goals removed
          JOIN foreman_coordination_records goal ON goal.id = removed.goal_id
          WHERE goal.kind = 'goal' AND json_extract(goal.data_json, '$.state') = 'cancelled'
        `)
        .all();
      for (const row of removed) {
        const goalId = String(row.goal_id);
        if (goalIds !== undefined && !goalIds.includes(goalId)) continue;
        for (const action of this.#ownedActions(goalId)) {
          if (settledActions.has(action.state)) continue;
          const target = action.target;
          if (
            !this.store.database
              .prepare(`
                SELECT 1 FROM runs WHERE id = ? AND group_id = ? AND member_id = ?
                  AND generation = ? AND desired_state = 'stopped' AND status = 'stopped'
              `)
              .get(target.runId, target.groupId, target.memberId, target.generation)
          )
            continue;
          this.store.transitionAgentAction(action.id, [action.state], "superseded", {
            ...(action.result === undefined ? {} : { result: action.result }),
            error: {
              code: "foreman_removed_goal",
              retryable: false,
              message:
                "Operator removed the cancelled goal and the exact target runtime is explicitly stopped. Prior effects remain unconfirmed; they are not undone or certified complete.",
            },
          });
          this.store.database
            .prepare(
              "INSERT INTO audits (id, principal_id, action, resource_type, resource_id, metadata_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              `audit_${randomUUID()}`,
              String(row.operator_id),
              "foreman.retire-removed-goal-effect",
              "agent-action",
              action.id,
              JSON.stringify({
                goalId,
                target,
                priorState: action.state,
                priorError: action.error,
              }),
              new Date().toISOString(),
            );
        }
      }
    });
  }

  #ownedActions(goalId: string) {
    const linkedActionIds = new Set(
      this.store.database
        .prepare(`
          SELECT link.action_id FROM delegation_actions link
          JOIN foreman_coordination_records delegation ON delegation.id = link.delegation_id
          WHERE delegation.kind = 'delegation' AND delegation.goal_id = ?
        `)
        .all(goalId)
        .map((row) => String(row.action_id)),
    );
    return this.store
      .listAgentActions()
      .filter(
        (action) =>
          linkedActionIds.has(action.id) ||
          (action.principal.kind === "foreman" && action.principal.goalId === goalId),
      );
  }

  #ownedEffects(goalId: string) {
    if (
      !this.store.database
        .prepare("SELECT 1 FROM foreman_coordination_records WHERE kind = 'goal' AND id = ?")
        .get(goalId)
    )
      return undefined;
    const delegations = this.goals.delegations().filter((item) => item.goalId === goalId);
    const actions = this.#ownedActions(goalId);
    const runIds = new Set(actions.map((action) => action.target.runId));
    for (const delegation of delegations) if (delegation.runId) runIds.add(delegation.runId);
    if (
      this.store.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'foreman_preparations'",
        )
        .get()
    ) {
      const preparations = this.store.database
        .prepare("SELECT data_json FROM foreman_preparations WHERE goal_id = ?")
        .all(goalId);
      for (const row of preparations) {
        const preparation = JSON.parse(String(row.data_json)) as PreparationRuntimeEffects;
        if (!Array.isArray(preparation.starts) || !Array.isArray(preparation.stops))
          return undefined;
        for (const step of [...preparation.stops, ...preparation.starts]) {
          if (step.runId) runIds.add(step.runId);
          else if (step.state === "intent") {
            for (const run of this.store.listGroupRunsRequiringStop(preparation.groupId))
              if (
                run.memberId === step.memberId &&
                (preparation.checkoutId === undefined || run.checkoutId === preparation.checkoutId)
              )
                runIds.add(run.id);
          }
        }
      }
    }
    return { actionIds: new Set(actions.map((action) => action.id)), runIds };
  }

  #captureEffects(goalId: string): CleanupForemanResult["pendingEffects"][number] {
    const owned = this.#ownedEffects(goalId);
    const actionIds = [...(owned?.actionIds ?? [])].filter(
      (id) => !settledActions.has(this.store.getAgentAction(id).state),
    );
    const runIds = [...(owned?.runIds ?? [])].filter(
      (id) =>
        this.store.database
          .prepare(
            "SELECT 1 FROM runs WHERE id = ? AND status IN ('starting', 'running', 'stopping')",
          )
          .get(id) !== undefined,
    );
    return { goalId, actionIds, runIds };
  }

  execute(operatorId: string, command: unknown): CleanupForemanResult {
    const input = CleanupForemanCommandSchema.parse(command);
    const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
    return this.store.atomic(() => {
      const receipt = this.store.database
        .prepare(
          "SELECT request_digest, result_json FROM foreman_cleanup_receipts WHERE operator_id = ? AND request_id = ?",
        )
        .get(operatorId, input.requestId);
      if (receipt) {
        if (receipt.request_digest !== digest)
          throw new DomainError(
            "foreman_cleanup_conflict",
            "Cleanup request ID was reused with different content",
            409,
          );
        return JSON.parse(String(receipt.result_json)) as CleanupForemanResult;
      }
      let messagesCleared = 0;
      let clearedThrough: number | undefined;
      if (input.scope === "channel") {
        for (const id of input.conversationIds ?? []) {
          if (
            !this.store.database.prepare("SELECT 1 FROM foreman_conversations WHERE id = ?").get(id)
          )
            throw new DomainError(
              "foreman_cleanup_stale",
              "Selected conversation is unavailable",
              409,
            );
          this.store.database
            .prepare("INSERT OR IGNORE INTO foreman_cleared_conversations VALUES (?)")
            .run(id);
        }
        const latest = Number(
          this.store.database
            .prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM foreman_messages")
            .get()!.value,
        );
        if (input.throughSequence > latest)
          throw new DomainError(
            "foreman_cleanup_stale",
            "Channel cutoff is beyond the latest message",
            409,
          );
        const changed = this.store.database
          .prepare(`
          WITH RECURSIVE cleared(id) AS (
            SELECT id FROM foreman_messages WHERE sequence <= ?
            UNION
            SELECT message.id FROM foreman_messages message JOIN cleared ON message.reply_to = cleared.id
          )
          INSERT OR IGNORE INTO foreman_cleared_messages (message_id) SELECT id FROM cleared
        `)
          .run(input.throughSequence);
        messagesCleared = Number(changed.changes);
        this.store.database
          .prepare(
            "UPDATE foreman_channel_visibility SET cleared_through = MAX(cleared_through, ?) WHERE singleton = 1",
          )
          .run(input.throughSequence);
        clearedThrough = Number(
          this.store.database
            .prepare("SELECT cleared_through FROM foreman_channel_visibility WHERE singleton = 1")
            .get()!.cleared_through,
        );
      }
      const selections =
        input.scope === "goal" ? [input.goal] : input.scope === "finished-goals" ? input.goals : [];
      const removedGoalIds: string[] = [];
      for (const selection of selections) {
        if (this.isRemoved(selection.id)) continue;
        const goal = this.goals.get(selection.id);
        if (goal.revision !== selection.expectedRevision)
          throw new DomainError(
            "foreman_cleanup_stale",
            "Goal revision changed; refresh before removing",
            409,
          );
        if (!terminalGoals.has(goal.state)) {
          if (input.scope !== "goal" || !input.cancel)
            throw new DomainError(
              "foreman_cleanup_active",
              "Active goals require cancel and remove",
              409,
            );
          this.goals.control(operatorId, { ...selection, action: "cancel" });
        }
        this.store.database
          .prepare(
            "INSERT INTO foreman_removed_goals (goal_id, operator_id, removed_at) VALUES (?, ?, ?)",
          )
          .run(goal.id, operatorId, new Date().toISOString());
        this.store.database
          .prepare("INSERT INTO foreman_cleanup_effects VALUES (?, ?)")
          .run(goal.id, JSON.stringify(this.#captureEffects(goal.id)));
        removedGoalIds.push(goal.id);
      }
      this.reconcileRemovedEffects(removedGoalIds);
      const result: CleanupForemanResult = {
        scope: input.scope,
        removedGoalIds,
        messagesCleared,
        ...(clearedThrough === undefined ? {} : { clearedThrough }),
        retained: true,
        pendingEffects: this.pendingEffects(removedGoalIds),
      };
      this.store.database
        .prepare("INSERT INTO foreman_cleanup_receipts VALUES (?, ?, ?, ?, ?)")
        .run(operatorId, input.requestId, digest, JSON.stringify(result), new Date().toISOString());
      return result;
    });
  }
}
