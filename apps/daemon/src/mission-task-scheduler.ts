import {
  type AgentAction,
  type AgentActionPrincipal,
  type CreateAgentActionCommand,
  CreateAgentActionCommandSchema,
} from "@nanasa/contracts";
import type { AgentActionService } from "./actions/agent-action-service.js";
import type { MissionRepository } from "./mission-repository.js";
import type { MissionTeamService } from "./mission-team-service.js";
import type { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
import { DomainError, NanasaStore } from "./store.js";

export class MissionTaskScheduler {
  #timer: NodeJS.Timeout | undefined;
  #pending: Promise<void> | undefined;
  #closed = false;
  public constructor(
    private readonly store: NanasaStore,
    private readonly missions: MissionRepository,
    private readonly teams: Pick<MissionTeamService, "list">,
    private readonly actions: AgentActionService,
    private readonly coordinator: Pick<RunRuntimeCoordinator, "startRun">,
    private readonly hasController: (runId: string) => boolean,
  ) {}

  public authorize(
    principal: Extract<AgentActionPrincipal, { kind: "foreman" }>,
    command: CreateAgentActionCommand,
  ): void {
    const mission = this.missions.assertForeman(
      principal,
      principal.missionId,
      principal.grantRevision,
      true,
    );
    if (
      mission.state !== "running" ||
      !this.missions.requestApproval(
        mission,
        "task",
        principal.taskId,
        `Execute task ${principal.taskId}`,
      )
    )
      throw new DomainError(
        "mission_dispatch_forbidden",
        "Task execution requires a running bounded mission",
        403,
      );
    const workspace = this.missions.workspace(mission.id);
    const task = workspace.tasks.find((candidate) => candidate.id === principal.taskId);
    const allocation = this.teams
      .list(mission.id)
      .find(
        (candidate) =>
          candidate.groupId === command.groupId &&
          candidate.state === "ready" &&
          candidate.templateId === task?.templateId,
      );
    if (allocation === undefined || allocation.checkoutId === undefined || task === undefined)
      throw new DomainError(
        "mission_target_forbidden",
        "Task must target an owned allocated team",
        403,
      );
    const membership = this.store
      .listActiveMemberships(command.groupId)
      .find((member) => member.memberId === command.memberId);
    const run = this.store.getActiveRun(command.groupId, command.memberId);
    if (
      !["queued", "assigned", "running"].includes(task.state) ||
      membership?.roleId !== task.roleId ||
      run === undefined ||
      run.checkoutId !== allocation.checkoutId ||
      this.hasController(run.id)
    )
      throw new DomainError(
        "mission_target_forbidden",
        "Task target is not an available mission-owned role",
        403,
      );
    if (
      task.dependencies.some(
        (id) => workspace.tasks.find((dependency) => dependency.id === id)?.state !== "accepted",
      )
    )
      throw new DomainError(
        "mission_dependencies_pending",
        "Task dependencies are not accepted",
        409,
      );
  }

  public authorizeAction(action: AgentAction): void {
    const principal = action.principal;
    if (principal.kind !== "foreman") return;
    this.authorize(
      principal,
      CreateAgentActionCommandSchema.parse({
        kind: "prompt",
        groupId: action.target.groupId,
        memberId: action.target.memberId,
        prompt: action.prompt,
        allowWorking: false,
      }),
    );
    const task = this.missions
      .workspace(principal.missionId)
      .tasks.find((candidate) => candidate.id === principal.taskId);
    if (
      task?.actionId !== action.id ||
      task.runId !== action.target.runId ||
      task.generation !== action.target.generation
    )
      throw new DomainError("mission_action_fenced", "Task no longer owns this exact action", 409);
  }

  public start(): void {
    if (this.#timer !== undefined || this.#closed) return;
    this.#timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 1000);
    this.#timer.unref();
  }
  public tick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#pending !== undefined) return this.#pending;
    this.#pending = this.#schedule().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }
  public async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#pending;
  }

  async #schedule(): Promise<void> {
    for (const mission of this.missions.list()) {
      for (const task of this.missions.workspace(mission.id).tasks) {
        if (task.actionId === undefined || !["assigned", "running"].includes(task.state)) continue;
        const action = this.store.getAgentAction(task.actionId);
        const next =
          action.state === "completed"
            ? "verifying"
            : [
                  "failed",
                  "stalled",
                  "timed-out",
                  "settled-unverified",
                  "superseded",
                  "expired",
                  "rejected",
                  "cancelled",
                ].includes(action.state)
              ? "blocked"
              : ["accepted", "started", "blocked"].includes(action.state)
                ? "running"
                : task.state;
        if (next !== task.state)
          this.store.database
            .prepare(
              "UPDATE mission_tasks SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
            )
            .run(next, new Date().toISOString(), task.id);
      }
      if (mission.state !== "running") continue;
      let actor;
      try {
        actor = this.store.getForeman(mission.foremanId);
      } catch {
        continue;
      }
      const foreman = this.store.getActiveForemanRun(actor.id);
      if (foreman === undefined || !actor.enabled) continue;
      const principal = {
        kind: "foreman" as const,
        foremanId: actor.id,
        runId: foreman.id,
        generation: foreman.generation,
        authorityRevision: actor.authorityRevision,
        missionId: mission.id,
        grantRevision: mission.grantRevision,
      };
      try {
        this.missions.assertForeman(principal, mission.id, mission.grantRevision, true);
      } catch {
        continue;
      }
      let capacity = this.missions
        .workspace(mission.id)
        .tasks.filter((task) =>
          ["assigned", "running", "blocked", "verifying"].includes(task.state),
        ).length;
      for (const task of this.missions.workspace(mission.id).tasks) {
        if (capacity >= mission.grant.maxConcurrentTasks) break;
        if (
          task.state === "queued" &&
          !this.missions.requestApproval(
            mission,
            "task",
            task.id,
            `Execute ${task.title} as ${task.roleId} in template ${task.templateId}`,
          )
        )
          continue;
        if (
          task.state !== "queued" ||
          task.dependencies.some(
            (id) =>
              this.missions.workspace(mission.id).tasks.find((other) => other.id === id)?.state !==
              "accepted",
          )
        )
          continue;
        const allocation = this.teams
          .list(mission.id)
          .find((team) => team.state === "ready" && team.templateId === task.templateId);
        if (allocation === undefined) continue;
        if (
          this.store.database
            .prepare(
              "SELECT id FROM mission_tasks WHERE group_id = ? AND state IN ('assigned', 'running', 'blocked', 'verifying') LIMIT 1",
            )
            .get(allocation.groupId) !== undefined
        )
          continue;
        for (const member of this.store.listActiveMemberships(allocation.groupId)) {
          if (member.roleId !== task.roleId) continue;
          const reserved = this.store.database
            .prepare(
              "SELECT id FROM mission_tasks WHERE group_id = ? AND member_id = ? AND state IN ('assigned', 'running', 'blocked', 'verifying')",
            )
            .get(allocation.groupId, member.memberId);
          if (reserved !== undefined) continue;
          let run = this.store.getActiveRun(allocation.groupId, member.memberId);
          if (run === undefined) {
            if (
              this.store.getLatestRunForMembership(allocation.groupId, member.memberId) !==
              undefined
            )
              continue;
            this.missions.assertForeman(principal, mission.id, mission.grantRevision, true);
            await this.coordinator.startRun(allocation.groupId, member.memberId, {
              cols: 120,
              rows: 36,
            });
            run = this.store.getActiveRun(allocation.groupId, member.memberId);
          }
          if (run === undefined || this.hasController(run.id)) continue;
          const status = this.store.getAgentStatus(allocation.groupId, member.memberId);
          const now = Date.now();
          if (
            status.state !== "idle" ||
            !status.interactiveReady ||
            status.authorityKind !== "reporter" ||
            status.staleAuthority ||
            status.processState !== "present" ||
            !(Date.parse(status.reporterLeaseExpiresAt ?? "") > now) ||
            !(Date.parse(status.transportLeaseExpiresAt ?? "") > now) ||
            status.reporterEpoch === undefined
          )
            continue;
          const exactRun = run;
          this.store.atomic(() => {
            const command = CreateAgentActionCommandSchema.parse({
              kind: "prompt",
              groupId: allocation.groupId,
              memberId: member.memberId,
              prompt: `Mission ${mission.id}; task ${task.id}. Acceptance: ${task.acceptanceIndexes.map((index) => mission.acceptance[index]).join("; ")}\n${task.instructions}`,
              expectedRunId: exactRun.id,
              expectedGeneration: exactRun.generation,
              expectedStatusRevision: status.statusRevision,
              allowWorking: false,
            });
            const action = this.actions.create(
              { ...principal, taskId: task.id },
              command,
              `mission-task:${task.id}`,
            );
            this.store.database
              .prepare(
                "UPDATE mission_tasks SET state = 'assigned', action_id = ?, group_id = ?, member_id = ?, run_id = ?, generation = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND state = 'queued'",
              )
              .run(
                action.id,
                allocation.groupId,
                member.memberId,
                exactRun.id,
                exactRun.generation,
                new Date().toISOString(),
                task.id,
              );
          });
          capacity += 1;
          break;
        }
      }
    }
  }
}
