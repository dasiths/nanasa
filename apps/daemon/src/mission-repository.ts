import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type CreateMissionCommand,
  CreateMissionCommandSchema,
  type CreateMissionTaskCommand,
  CreateMissionTaskCommandSchema,
  canonicalJson,
  type DecideMissionApprovalCommand,
  DecideMissionApprovalCommandSchema,
  type Mission,
  type MissionApproval,
  MissionApprovalSchema,
  type MissionControlCommand,
  MissionControlCommandSchema,
  type MissionGrant,
  MissionSchema,
  type MissionTask,
  MissionTaskSchema,
  type MissionWorkspace,
  type NanasaConfig,
} from "@nanasa/contracts";
import type { McpForemanPrincipal } from "./mcp-auth.js";
import { DomainError, NanasaStore } from "./store.js";

const terminalStates = new Set<Mission["state"]>(["completed", "cancelled", "revoked", "failed"]);

export function assertMissionGrantWithin(grant: MissionGrant, ceiling: MissionGrant): void {
  const numeric = [
    "maxActiveMissions",
    "maxTeamsPerMission",
    "maxConcurrentTasks",
    "maxMissionHours",
    "maxForemanTurns",
  ] as const;
  const exceeds =
    numeric.some((key) => grant[key] > ceiling[key]) ||
    (grant.mode === "bounded" && ceiling.mode !== "bounded") ||
    grant.permittedTeamTemplates.some((id) => !ceiling.permittedTeamTemplates.includes(id)) ||
    grant.transcript.maxLines > ceiling.transcript.maxLines ||
    grant.transcript.maxBytes > ceiling.transcript.maxBytes ||
    (grant.intervention.idlePrompt && !ceiling.intervention.idlePrompt) ||
    (grant.intervention.routineWaitReply && !ceiling.intervention.routineWaitReply) ||
    (grant.intervention.nativeInput !== "disabled" &&
      ceiling.intervention.nativeInput === "disabled") ||
    grant.intervention.maxPerIncident > ceiling.intervention.maxPerIncident ||
    (grant.recovery.restartMissionOwnedAgents && !ceiling.recovery.restartMissionOwnedAgents) ||
    grant.recovery.maxAttemptsPerIncident > ceiling.recovery.maxAttemptsPerIncident ||
    grant.recovery.maxAttemptsPerMission > ceiling.recovery.maxAttemptsPerMission ||
    grant.recovery.cooldownSeconds < ceiling.recovery.cooldownSeconds;
  if (exceeds)
    throw new DomainError(
      "mission_grant_exceeds_policy",
      "Mission authority exceeds repository policy",
      403,
    );
}

export class MissionRepository {
  readonly #database: DatabaseSync;
  public constructor(
    private readonly store: NanasaStore,
    private readonly config: () => NanasaConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#database = store.database;
  }

  public create(operatorId: string, command: CreateMissionCommand): Mission {
    const input = CreateMissionCommandSchema.parse(command);
    return this.#transaction(() => {
      const config = this.config();
      const foreman = config.foreman;
      if (foreman?.enabled !== true)
        throw new DomainError(
          "foreman_not_enabled",
          "Enable Foreman before creating a mission",
          409,
        );
      assertMissionGrantWithin(input.grant, foreman.autonomy);
      if (
        new Set(input.verification.map((recipe) => recipe.id)).size !== input.verification.length ||
        input.verification.some((recipe) =>
          recipe.acceptanceIndexes.some((index) => index >= input.acceptance.length),
        )
      )
        throw new DomainError(
          "mission_verification_invalid",
          "Verification recipes require unique IDs and existing acceptance criteria",
          400,
        );
      if (
        new Set(input.grant.permittedTeamTemplates).size !==
        input.grant.permittedTeamTemplates.length
      )
        throw new DomainError(
          "mission_template_duplicate",
          "Approved templates must be unique",
          400,
        );
      for (const id of input.grant.permittedTeamTemplates)
        if (config.teamTemplates?.[id] === undefined)
          throw new DomainError(
            "mission_template_missing",
            "Approved template is unavailable",
            409,
          );
      const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
      const existing = this.#database
        .prepare("SELECT * FROM missions WHERE operator_id = ? AND request_id = ?")
        .get(operatorId, input.requestId);
      if (existing !== undefined) {
        if (existing.request_digest !== digest)
          throw new DomainError(
            "mission_request_conflict",
            "Mission request ID was reused for different content",
            409,
          );
        return this.#hydrate(existing);
      }
      const count = this.#database
        .prepare(
          "SELECT COUNT(*) AS count FROM missions WHERE state NOT IN ('completed', 'cancelled', 'revoked', 'failed')",
        )
        .get() as { count: number };
      if (count.count >= foreman.autonomy.maxActiveMissions)
        throw new DomainError("mission_capacity_exhausted", "Active mission limit reached", 409);
      const now = this.now();
      const timestamp = now.toISOString();
      const id = `mission_${randomUUID()}`;
      this.#database
        .prepare(`INSERT INTO missions
        (id, foreman_id, operator_id, request_id, request_digest, title, objective, acceptance_json, grant_json, template_digests_json, verification_json,
         grant_revision, revision, state, next_review_at, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'planning', ?, ?, ?, ?)`)
        .run(
          id,
          foreman.id,
          operatorId,
          input.requestId,
          digest,
          input.title,
          input.objective,
          JSON.stringify(input.acceptance),
          JSON.stringify(input.grant),
          JSON.stringify(
            Object.fromEntries(
              input.grant.permittedTeamTemplates.map((id) => [
                id,
                createHash("sha256").update(canonicalJson(config.teamTemplates![id])).digest("hex"),
              ]),
            ),
          ),
          JSON.stringify(input.verification),
          timestamp,
          new Date(now.getTime() + input.grant.maxMissionHours * 3600000).toISOString(),
          timestamp,
          timestamp,
        );
      this.#audit(id, "created", operatorId, 0);
      return this.get(id);
    });
  }

  public get(id: string): Mission {
    const row = this.#database.prepare("SELECT * FROM missions WHERE id = ?").get(id);
    if (row === undefined) throw new DomainError("mission_not_found", "Mission not found", 404);
    return this.#hydrate(row);
  }

  public list(): Mission[] {
    return this.#database
      .prepare("SELECT * FROM missions ORDER BY created_at DESC, id DESC LIMIT 100")
      .all()
      .map((row) => this.#hydrate(row));
  }

  public queueDueReviews(): void {
    this.#transaction(() => {
      const now = this.now();
      const due = this.#database
        .prepare(
          "SELECT * FROM missions WHERE state = 'running' AND next_review_at <= ? ORDER BY next_review_at, id LIMIT 16",
        )
        .all(now.toISOString());
      for (const row of due) {
        const mission = this.#hydrate(row);
        try {
          this.#assertPolicy(mission);
        } catch {
          this.#database
            .prepare(
              "UPDATE missions SET state = 'blocked', revision = revision + 1, grant_revision = grant_revision + 1, updated_at = ? WHERE id = ?",
            )
            .run(now.toISOString(), mission.id);
          this.#database
            .prepare(
              "UPDATE foreman_inbox SET state = 'cancelled', updated_at = ? WHERE mission_id = ? AND state = 'queued'",
            )
            .run(now.toISOString(), mission.id);
          this.#audit(mission.id, "budget-or-policy-blocked", "daemon", mission.revision + 1);
          continue;
        }
        const pending = this.#database
          .prepare(
            "SELECT id FROM foreman_inbox WHERE mission_id = ? AND state IN ('queued', 'writing', 'submitted', 'ambiguous') LIMIT 1",
          )
          .get(mission.id);
        if (pending === undefined) {
          this.#database
            .prepare(`INSERT OR IGNORE INTO foreman_inbox
            (id, mission_id, dedupe_key, prompt, state, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
            .run(
              `inbox_${randomUUID()}`,
              mission.id,
              `review:${mission.id}:${mission.grantRevision}:${mission.nextReviewAt}`,
              `Review mission ${mission.id} under grant revision ${mission.grantRevision}. Use nanasa.foreman_get_mission to reconstruct current state, inspect only authorized resources, and plan the next bounded step. Do not infer completion from messages. Finish this review with nanasa.foreman_finish_review.`,
              now.toISOString(),
              now.toISOString(),
            );
        }
        const seconds = this.config().foreman?.supervision.reviewIntervalSeconds ?? 300;
        this.#database
          .prepare("UPDATE missions SET next_review_at = ? WHERE id = ?")
          .run(new Date(now.getTime() + seconds * 1000).toISOString(), mission.id);
      }
    });
  }

  public claimReview(
    principal: McpForemanPrincipal,
    missionId: string,
    inboxId: string,
    target: unknown,
  ): boolean {
    return this.#transaction(() => {
      const mission = this.get(missionId);
      this.assertForeman(principal, missionId, mission.grantRevision);
      if (mission.state !== "running") return false;
      const claim = this.#database
        .prepare(
          "UPDATE foreman_inbox SET state = 'writing', target_json = ?, updated_at = ? WHERE id = ? AND mission_id = ? AND state = 'queued'",
        )
        .run(JSON.stringify(target), this.now().toISOString(), inboxId, missionId);
      if (claim.changes !== 1) return false;
      this.#database
        .prepare("UPDATE missions SET turns_used = turns_used + 1, updated_at = ? WHERE id = ?")
        .run(this.now().toISOString(), missionId);
      this.#audit(missionId, "review-write-intent", principal.foremanId, mission.revision);
      return true;
    });
  }

  public finishReview(
    principal: McpForemanPrincipal,
    missionId: string,
    expectedGrantRevision: number,
  ): Mission {
    return this.#transaction(() => {
      const mission = this.assertForeman(principal, missionId, expectedGrantRevision, true);
      this.#database
        .prepare(`UPDATE foreman_inbox SET state = 'answered', updated_at = ? WHERE mission_id = ?
        AND state IN ('writing', 'submitted', 'ambiguous') AND json_extract(target_json, '$.runId') = ? AND json_extract(target_json, '$.generation') = ?`)
        .run(this.now().toISOString(), missionId, principal.runId, principal.generation);
      this.#audit(missionId, "review-finished", principal.foremanId, mission.revision);
      return mission;
    });
  }

  public workspace(id: string): MissionWorkspace {
    return {
      mission: this.get(id),
      tasks: this.#database
        .prepare("SELECT * FROM mission_tasks WHERE mission_id = ? ORDER BY created_at, id")
        .all(id)
        .map((row) => this.#task(row)),
    };
  }

  public approvals(missionId: string): MissionApproval[] {
    return this.#database
      .prepare(
        "SELECT * FROM mission_approvals WHERE mission_id = ? ORDER BY created_at, id LIMIT 256",
      )
      .all(missionId)
      .map((row) =>
        MissionApprovalSchema.parse({
          id: row.id,
          missionId: row.mission_id,
          grantRevision: row.grant_revision,
          operation: row.operation,
          operationKey: row.operation_key,
          summary: row.summary,
          state: row.state,
          createdAt: row.created_at,
          decidedAt: row.decided_at ?? undefined,
        }),
      );
  }

  public requestApproval(
    mission: Mission,
    operation: MissionApproval["operation"],
    key: string,
    summary: string,
  ): boolean {
    if (mission.grant.mode === "bounded") return true;
    const existing = this.#database
      .prepare(
        "SELECT id FROM mission_approvals WHERE mission_id = ? AND grant_revision = ? AND operation = ? AND operation_key = ?",
      )
      .get(mission.id, mission.grantRevision, operation, key);
    const count = this.#database
      .prepare("SELECT COUNT(*) AS count FROM mission_approvals WHERE mission_id = ?")
      .get(mission.id) as { count: number };
    if (existing === undefined && count.count >= 256)
      throw new DomainError(
        "mission_approval_limit",
        "Mission approval request limit reached",
        409,
      );
    this.#database
      .prepare(
        "INSERT OR IGNORE INTO mission_approvals (id, mission_id, grant_revision, operation, operation_key, summary, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(
        `approval_${randomUUID()}`,
        mission.id,
        mission.grantRevision,
        operation,
        key,
        summary.slice(0, 2000),
        this.now().toISOString(),
      );
    const row = this.#database
      .prepare(
        "SELECT state FROM mission_approvals WHERE mission_id = ? AND grant_revision = ? AND operation = ? AND operation_key = ?",
      )
      .get(mission.id, mission.grantRevision, operation, key);
    return row?.state === "approved";
  }

  public decideApproval(
    operatorId: string,
    approvalId: string,
    command: DecideMissionApprovalCommand,
  ): MissionApproval {
    const input = DecideMissionApprovalCommandSchema.parse(command);
    return this.#transaction(() => {
      const row = this.#database
        .prepare("SELECT * FROM mission_approvals WHERE id = ?")
        .get(approvalId);
      if (row === undefined)
        throw new DomainError("mission_approval_not_found", "Mission approval not found", 404);
      const mission = this.get(String(row.mission_id));
      if (
        mission.grantRevision !== input.expectedGrantRevision ||
        row.grant_revision !== mission.grantRevision ||
        row.state !== "pending" ||
        (mission.state !== "running" &&
          !(
            ["verifying", "awaiting-acceptance"].includes(mission.state) &&
            row.operation === "verification"
          ))
      )
        throw new DomainError(
          "mission_approval_stale",
          "Approval no longer matches the current mission grant",
          409,
        );
      this.#assertPolicy(mission, true);
      this.#database
        .prepare(
          "UPDATE mission_approvals SET state = ?, decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'",
        )
        .run(input.decision, this.now().toISOString(), operatorId, approvalId);
      this.#audit(mission.id, `approval-${input.decision}`, operatorId, mission.revision);
      return this.approvals(mission.id).find((approval) => approval.id === approvalId)!;
    });
  }

  public control(operatorId: string, id: string, command: MissionControlCommand): Mission {
    const input = MissionControlCommandSchema.parse(command);
    return this.#transaction(() => {
      const mission = this.get(id);
      if (mission.revision !== input.expectedRevision)
        throw new DomainError(
          "mission_revision_conflict",
          "Mission changed; refresh before applying control",
          409,
        );
      if (terminalStates.has(mission.state))
        throw new DomainError("mission_terminal", "Mission is already terminal", 409);
      let state: Mission["state"];
      switch (input.action) {
        case "pause":
          state = "paused";
          break;
        case "cancel":
          state = "cancelled";
          break;
        case "revoke":
          state = "revoked";
          break;
        case "accept":
          if (mission.state !== "awaiting-acceptance")
            throw new DomainError(
              "mission_evidence_required",
              "Verified acceptance evidence is required",
              409,
            );
          state = "completed";
          break;
        case "start":
          if (mission.state !== "planning")
            throw new DomainError(
              "mission_transition_invalid",
              "Only a planned mission may start",
              409,
            );
          this.#assertPolicy(mission);
          state = "running";
          break;
        case "resume":
          if (!["paused", "blocked"].includes(mission.state))
            throw new DomainError(
              "mission_transition_invalid",
              "Only a paused or blocked mission may resume",
              409,
            );
          this.#assertPolicy(mission);
          state = "running";
          break;
      }
      const revision = mission.revision + 1;
      this.#database
        .prepare(
          "UPDATE missions SET state = ?, revision = ?, grant_revision = grant_revision + 1, updated_at = ?, next_review_at = ? WHERE id = ?",
        )
        .run(state, revision, this.now().toISOString(), this.now().toISOString(), id);
      if (["cancelled", "revoked"].includes(state))
        this.#database
          .prepare(
            "UPDATE mission_tasks SET state = 'cancelled', revision = revision + 1, updated_at = ? WHERE mission_id = ? AND state NOT IN ('accepted', 'failed', 'cancelled')",
          )
          .run(this.now().toISOString(), id);
      this.#database
        .prepare(
          "UPDATE foreman_inbox SET state = 'cancelled', updated_at = ? WHERE mission_id = ? AND state = 'queued'",
        )
        .run(this.now().toISOString(), id);
      this.#audit(id, input.action, operatorId, revision);
      this.#database
        .prepare(
          "UPDATE mission_approvals SET state = 'stale' WHERE mission_id = ? AND state IN ('pending', 'approved')",
        )
        .run(id);
      return this.get(id);
    });
  }

  public pauseForTakeover(runId: string): void {
    this.#transaction(() => {
      const run = this.store.getRuntimeRun(runId);
      const missionIds =
        "foremanId" in run
          ? this.#database
              .prepare(
                "SELECT id FROM missions WHERE foreman_id = ? AND state IN ('running', 'verifying')",
              )
              .all(run.foremanId)
              .map((row) => String(row.id))
          : this.#database
              .prepare(
                "SELECT m.id FROM missions m JOIN mission_team_allocations a ON a.mission_id = m.id WHERE a.group_id = ? AND m.state IN ('running', 'verifying')",
              )
              .all(run.groupId)
              .map((row) => String(row.id));
      for (const id of missionIds)
        this.control("operator-terminal", id, {
          expectedRevision: this.get(id).revision,
          action: "pause",
        });
    });
  }

  public assertForeman(
    principal: McpForemanPrincipal,
    missionId: string,
    expectedGrantRevision: number,
    allowSpentTurn = false,
    allowedStates: readonly Mission["state"][] = ["planning", "running"],
  ): Mission {
    const actor = this.store.getForeman(principal.foremanId);
    const run = this.store.getActiveForemanRun(actor.id);
    const mission = this.get(missionId);
    if (
      !actor.enabled ||
      actor.authorityRevision !== principal.authorityRevision ||
      run?.id !== principal.runId ||
      run.generation !== principal.generation ||
      run.desiredState !== "running" ||
      !["starting", "running"].includes(run.status) ||
      mission.foremanId !== actor.id
    )
      throw new DomainError("mission_principal_revoked", "Foreman authority is not current", 403);
    if (mission.grantRevision !== expectedGrantRevision)
      throw new DomainError("mission_grant_stale", "Mission grant changed", 409);
    if (!allowedStates.includes(mission.state))
      throw new DomainError("mission_not_active", "Mission does not allow new work", 409);
    this.#assertPolicy(mission, allowSpentTurn);
    return mission;
  }

  public createTask(
    principal: McpForemanPrincipal,
    missionId: string,
    command: CreateMissionTaskCommand,
  ): MissionTask {
    const input = CreateMissionTaskCommandSchema.parse(command);
    return this.#transaction(() => {
      const mission = this.assertForeman(principal, missionId, input.expectedGrantRevision, true);
      const { requestId } = input;
      const digest = createHash("sha256")
        .update(
          canonicalJson({
            title: input.title,
            instructions: input.instructions,
            roleId: input.roleId,
            templateId: input.templateId,
            dependencies: input.dependencies,
            acceptanceIndexes: input.acceptanceIndexes,
          }),
        )
        .digest("hex");
      const existing = this.#database
        .prepare("SELECT * FROM mission_tasks WHERE mission_id = ? AND request_id = ?")
        .get(missionId, requestId);
      if (existing !== undefined) {
        if (existing.request_digest !== digest)
          throw new DomainError(
            "mission_task_conflict",
            "Task request ID was reused for different content",
            409,
          );
        return this.#task(existing);
      }
      const config = this.config();
      const template = config.teamTemplates?.[input.templateId];
      if (
        !mission.grant.permittedTeamTemplates.includes(input.templateId) ||
        template === undefined ||
        !Object.values(template.members).some((member) => member.roleId === input.roleId)
      )
        throw new DomainError(
          "mission_role_forbidden",
          "Task role is not available in an approved template",
          403,
        );
      if (
        new Set(input.acceptanceIndexes).size !== input.acceptanceIndexes.length ||
        input.acceptanceIndexes.some((index) => index >= mission.acceptance.length)
      )
        throw new DomainError(
          "mission_acceptance_invalid",
          "Task must reference existing acceptance criteria",
          400,
        );
      if (new Set(input.dependencies).size !== input.dependencies.length)
        throw new DomainError(
          "mission_dependencies_invalid",
          "Task dependencies must be unique",
          400,
        );
      for (const dependency of input.dependencies)
        if (
          this.#database
            .prepare("SELECT id FROM mission_tasks WHERE id = ? AND mission_id = ?")
            .get(dependency, missionId) === undefined
        )
          throw new DomainError(
            "mission_dependency_missing",
            "Dependencies must reference prior tasks in this mission",
            400,
          );
      const count = this.#database
        .prepare("SELECT COUNT(*) AS count FROM mission_tasks WHERE mission_id = ?")
        .get(missionId) as { count: number };
      if (count.count >= 256)
        throw new DomainError("mission_task_limit", "Mission task limit reached", 409);
      const id = `task_${randomUUID()}`;
      const timestamp = this.now().toISOString();
      this.#database
        .prepare(`INSERT INTO mission_tasks
        (id, mission_id, request_id, request_digest, title, instructions, role_id, template_id, dependencies_json, acceptance_indexes_json, state, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`)
        .run(
          id,
          missionId,
          requestId,
          digest,
          input.title,
          input.instructions,
          input.roleId,
          input.templateId,
          JSON.stringify(input.dependencies),
          JSON.stringify(input.acceptanceIndexes),
          timestamp,
          timestamp,
        );
      this.#audit(missionId, "task-created", principal.foremanId, mission.revision);
      return this.#task(
        this.#database.prepare("SELECT * FROM mission_tasks WHERE id = ?").get(id)!,
      );
    });
  }

  #assertPolicy(mission: Mission, allowSpentTurn = false): void {
    const config = this.config();
    const foreman = config.foreman;
    if (foreman?.enabled !== true || foreman.id !== mission.foremanId)
      throw new DomainError(
        "mission_foreman_disabled",
        "Mission Foreman is disabled or changed",
        403,
      );
    assertMissionGrantWithin(mission.grant, foreman.autonomy);
    for (const [id, digest] of Object.entries(mission.templateDigests)) {
      const template = config.teamTemplates?.[id];
      if (
        template === undefined ||
        createHash("sha256").update(canonicalJson(template)).digest("hex") !== digest
      )
        throw new DomainError(
          "mission_template_changed",
          "An approved team template changed; the existing mission grant is blocked",
          409,
        );
    }
    if (Date.parse(mission.expiresAt) <= this.now().getTime())
      throw new DomainError("mission_expired", "Mission time budget has expired", 409);
    if (!allowSpentTurn && mission.turnsUsed >= mission.grant.maxForemanTurns)
      throw new DomainError("mission_turn_limit", "Mission Foreman turn budget is exhausted", 409);
  }

  #hydrate(row: Record<string, unknown>): Mission {
    return MissionSchema.parse({
      id: row.id,
      foremanId: row.foreman_id,
      operatorId: row.operator_id,
      title: row.title,
      objective: row.objective,
      acceptance: JSON.parse(String(row.acceptance_json)),
      grant: JSON.parse(String(row.grant_json)),
      templateDigests: JSON.parse(String(row.template_digests_json)),
      verification: JSON.parse(String(row.verification_json)),
      grantRevision: row.grant_revision,
      revision: row.revision,
      state: row.state,
      turnsUsed: row.turns_used,
      recoveryAttempts: row.recovery_attempts,
      nextReviewAt: row.next_review_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  #task(row: Record<string, unknown>): MissionTask {
    return MissionTaskSchema.parse({
      id: row.id,
      missionId: row.mission_id,
      actionId: row.action_id ?? undefined,
      groupId: row.group_id ?? undefined,
      memberId: row.member_id ?? undefined,
      runId: row.run_id ?? undefined,
      generation: row.generation ?? undefined,
      title: row.title,
      instructions: row.instructions,
      roleId: row.role_id,
      templateId: row.template_id,
      dependencies: JSON.parse(String(row.dependencies_json)),
      acceptanceIndexes: JSON.parse(String(row.acceptance_indexes_json)),
      state: row.state,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  #audit(id: string, kind: string, principal: string, revision: number): void {
    this.#database
      .prepare(
        "INSERT INTO mission_audits (mission_id, kind, principal_id, revision, occurred_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, kind, principal, revision, this.now().toISOString());
  }
  #transaction<Result>(operation: () => Result): Result {
    return this.store.atomic(operation);
  }
}
