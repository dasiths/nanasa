import { createHash, randomUUID } from "node:crypto";
import {
  type AgentActionPrincipal,
  canonicalJson,
  type InterveneMissionTaskCommand,
  InterveneMissionTaskCommandSchema,
  type ObserveMissionTaskCommand,
  ObserveMissionTaskCommandSchema,
  type OpenWait,
  type OpenWaitReply,
  type ReplyMissionWaitCommand,
  ReplyMissionWaitCommandSchema,
} from "@nanasa/contracts";
import type { AgentOpenWaitService } from "./actions/agent-open-wait-service.js";
import type { McpForemanPrincipal } from "./mcp-auth.js";
import type { MissionRepository } from "./mission-repository.js";
import type { MissionTeamService } from "./mission-team-service.js";
import { DomainError, NanasaStore } from "./store.js";
import type { TerminalInputArbiter } from "./terminal/terminal-input-arbiter.js";
import type { TerminalReadService } from "./terminal/terminal-read-service.js";
import type { TmuxRuntime } from "./tmux-runtime.js";

export class MissionObservationService {
  public constructor(
    private readonly store: NanasaStore,
    private readonly missions: MissionRepository,
    private readonly teams: Pick<MissionTeamService, "list">,
    private readonly reads: Pick<TerminalReadService, "read">,
    private readonly runtime: Pick<TmuxRuntime, "observeRun" | "pasteToRun">,
    private readonly arbiter: Pick<TerminalInputArbiter, "dispatchAutomated">,
    private readonly hasController: (runId: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  #target(
    principal: McpForemanPrincipal,
    input: Pick<ObserveMissionTaskCommand, "missionId" | "taskId" | "expectedGrantRevision">,
  ) {
    const mission = this.missions.assertForeman(
      principal,
      input.missionId,
      input.expectedGrantRevision,
      true,
    );
    const task = this.missions
      .workspace(mission.id)
      .tasks.find((candidate) => candidate.id === input.taskId);
    const allocation = this.teams
      .list(mission.id)
      .find((candidate) => candidate.groupId === task?.groupId && candidate.state === "ready");
    if (
      task?.runId === undefined ||
      task.groupId === undefined ||
      task.memberId === undefined ||
      allocation?.checkoutId === undefined
    )
      throw new DomainError(
        "mission_observation_forbidden",
        "Task has no mission-owned runtime",
        403,
      );
    const run = this.store.getActiveRun(task.groupId, task.memberId);
    if (
      run?.id !== task.runId ||
      run.generation !== task.generation ||
      run.checkoutId !== allocation.checkoutId
    )
      throw new DomainError("mission_observation_stale", "Task runtime has changed", 409);
    return { mission, task, run, status: this.store.getAgentStatus(task.groupId, task.memberId) };
  }

  public async observe(principal: McpForemanPrincipal, command: ObserveMissionTaskCommand) {
    const input = ObserveMissionTaskCommandSchema.parse(command);
    const target = this.#target(principal, input);
    const capture = await this.reads.read({
      runId: target.run.id,
      generation: target.run.generation,
      source: "history",
      maxLines: Math.min(input.maxLines, target.mission.grant.transcript.maxLines),
      maxBytes: target.mission.grant.transcript.maxBytes,
    });
    const current = this.#target(principal, input);
    if (
      current.run.id !== target.run.id ||
      current.status.statusRevision !== target.status.statusRevision
    )
      throw new DomainError(
        "mission_observation_changed",
        "Runtime changed during observation",
        409,
      );
    const id = `observation_${randomUUID()}`;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 30000).toISOString();
    const identity = {
      runId: current.run.id,
      generation: current.run.generation,
      statusRevision: current.status.statusRevision,
      reporterEpoch: current.status.reporterEpoch ?? null,
      processFingerprint: current.status.processFingerprint ?? null,
      terminal: current.run.terminal,
      grantRevision: target.mission.grantRevision,
    };
    this.store.database
      .prepare(
        "INSERT INTO mission_observations (id, mission_id, task_id, target_json, content_digest, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.missionId,
        input.taskId,
        JSON.stringify(identity),
        createHash("sha256").update(capture.text).digest("hex"),
        expiresAt,
        createdAt.toISOString(),
      );
    return {
      id,
      expiresAt,
      untrustedEvidence: true,
      capture,
      status: current.status,
      waits: this.store
        .listOpenWaits(current.run.groupId, current.run.memberId)
        .filter((wait) => wait.state === "open")
        .slice(0, 32),
    };
  }

  public authorizeWait(
    principal: Extract<AgentActionPrincipal, { kind: "foreman" }>,
    wait: OpenWait,
    reply: OpenWaitReply,
  ): void {
    const current = this.#target(principal, {
      missionId: principal.missionId,
      taskId: principal.taskId,
      expectedGrantRevision: principal.grantRevision,
    });
    if (
      current.mission.state !== "running" ||
      current.mission.grant.mode !== "bounded" ||
      !current.mission.grant.intervention.routineWaitReply ||
      current.run.id !== wait.runId ||
      current.run.generation !== wait.generation ||
      this.hasController(current.run.id) ||
      wait.kind === "permission" ||
      wait.kind === "plan_approval" ||
      !["answer", "select"].includes(reply.kind)
    )
      throw new DomainError(
        "mission_wait_forbidden",
        "Mission does not authorize this routine wait reply",
        403,
      );
  }

  public async replyWait(
    principal: McpForemanPrincipal,
    command: ReplyMissionWaitCommand,
    waits: AgentOpenWaitService,
  ) {
    const input = ReplyMissionWaitCommandSchema.parse(command);
    const caller = {
      ...principal,
      missionId: input.missionId,
      taskId: input.taskId,
      grantRevision: input.expectedGrantRevision,
    };
    const wait = this.store.getOpenWait(input.waitId);
    this.authorizeWait(caller, wait, input.reply);
    const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const previous = this.store.database
      .prepare(
        "SELECT id, state, request_digest FROM mission_interventions WHERE mission_id = ? AND request_id = ?",
      )
      .get(input.missionId, input.requestId);
    if (previous !== undefined) {
      if (previous.request_digest !== digest)
        throw new DomainError(
          "mission_intervention_conflict",
          "Intervention request ID was reused",
          409,
        );
      return { id: String(previous.id), state: String(previous.state) };
    }
    const observation = this.store.database
      .prepare("SELECT * FROM mission_observations WHERE id = ? AND mission_id = ? AND task_id = ?")
      .get(input.observationId, input.missionId, input.taskId);
    if (observation === undefined)
      throw new DomainError("mission_observation_expired", "Fresh observation required", 409);
    const target = JSON.parse(String(observation.target_json));
    const guard = () => {
      this.authorizeWait(caller, wait, input.reply);
      const current = this.#target(principal, input);
      if (
        Date.parse(String(observation.expires_at)) <= this.now().getTime() ||
        current.run.id !== target.runId ||
        current.run.generation !== target.generation ||
        current.status.reporterEpoch !== target.reporterEpoch ||
        current.status.processFingerprint !== target.processFingerprint
      )
        throw new DomainError(
          "mission_observation_expired",
          "Wait observation is no longer current",
          409,
        );
    };
    guard();
    const mission = this.missions.get(input.missionId);
    const count = this.store.database
      .prepare("SELECT COUNT(*) AS count FROM mission_interventions WHERE task_id = ?")
      .get(input.taskId) as { count: number };
    if (
      count.count >= mission.grant.intervention.maxPerIncident ||
      this.store.database
        .prepare(
          "SELECT id FROM mission_interventions WHERE task_id = ? AND state IN ('writing', 'ambiguous') LIMIT 1",
        )
        .get(input.taskId) !== undefined
    )
      throw new DomainError(
        "mission_intervention_limit",
        "Intervention is blocked by its budget or uncertain prior input",
        409,
      );
    const id = `intervention_${randomUUID()}`;
    const timestamp = this.now().toISOString();
    this.store.database
      .prepare(
        "INSERT INTO mission_interventions (id, mission_id, task_id, observation_id, request_id, request_digest, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'writing', ?, ?)",
      )
      .run(
        id,
        input.missionId,
        input.taskId,
        input.observationId,
        input.requestId,
        digest,
        timestamp,
        timestamp,
      );
    try {
      await waits.reply(
        caller,
        wait.id,
        {
          expectedRunId: target.runId,
          expectedGeneration: target.generation,
          expectedReporterEpoch: target.reporterEpoch,
          expectedStatusRevision: target.statusRevision,
          reply: input.reply,
        },
        guard,
      );
      this.store.database
        .prepare(
          "UPDATE mission_interventions SET state = 'submitted', updated_at = ? WHERE id = ?",
        )
        .run(this.now().toISOString(), id);
      return { id, state: "submitted" };
    } catch {
      this.store.database
        .prepare(
          "UPDATE mission_interventions SET state = 'ambiguous', updated_at = ? WHERE id = ?",
        )
        .run(this.now().toISOString(), id);
      return { id, state: "ambiguous" };
    }
  }

  public async intervene(principal: McpForemanPrincipal, command: InterveneMissionTaskCommand) {
    const input = InterveneMissionTaskCommandSchema.parse(command);
    const initial = this.#target(principal, input);
    if (
      initial.task.actionId === undefined ||
      !["stalled", "timed-out", "failed", "settled-unverified", "rejected"].includes(
        this.store.getAgentAction(initial.task.actionId).state,
      )
    )
      throw new DomainError(
        "mission_action_pending",
        "Intervention requires a settled or blocked prior task action",
        409,
      );
    if (
      initial.mission.state !== "running" ||
      initial.mission.grant.mode !== "bounded" ||
      !initial.mission.grant.intervention.idlePrompt
    )
      throw new DomainError(
        "mission_intervention_forbidden",
        "Mission does not authorize idle prompting",
        403,
      );
    const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const previous = this.store.database
      .prepare(
        "SELECT id, state, request_digest FROM mission_interventions WHERE mission_id = ? AND request_id = ?",
      )
      .get(input.missionId, input.requestId);
    if (previous !== undefined) {
      if (previous.request_digest !== digest)
        throw new DomainError(
          "mission_intervention_conflict",
          "Intervention request ID was reused",
          409,
        );
      return { id: String(previous.id), state: String(previous.state) };
    }
    const observation = this.store.database
      .prepare("SELECT * FROM mission_observations WHERE id = ? AND mission_id = ? AND task_id = ?")
      .get(input.observationId, input.missionId, input.taskId);
    if (
      observation === undefined ||
      Date.parse(String(observation.expires_at)) <= this.now().getTime()
    )
      throw new DomainError(
        "mission_observation_expired",
        "A fresh exact observation is required",
        409,
      );
    const target = JSON.parse(String(observation.target_json));
    const assertCurrent = () => {
      const current = this.#target(principal, input);
      const now = this.now().getTime();
      const status = current.status;
      if (
        Date.parse(String(observation.expires_at)) <= now ||
        this.hasController(current.run.id) ||
        current.mission.state !== "running" ||
        current.mission.grantRevision !== target.grantRevision ||
        status.state !== "idle" ||
        !status.interactiveReady ||
        status.staleAuthority ||
        status.authorityKind !== "reporter" ||
        status.processState !== "present" ||
        !(Date.parse(status.reporterLeaseExpiresAt ?? "") > now) ||
        !(Date.parse(status.transportLeaseExpiresAt ?? "") > now) ||
        status.statusRevision !== target.statusRevision ||
        status.reporterEpoch !== target.reporterEpoch ||
        status.processFingerprint !== target.processFingerprint ||
        canonicalJson(current.run.terminal) !== canonicalJson(target.terminal)
      )
        throw new DomainError(
          "mission_intervention_stale",
          "Observation no longer permits terminal input",
          409,
        );
      const count = this.store.database
        .prepare("SELECT COUNT(*) AS count FROM mission_interventions WHERE task_id = ?")
        .get(input.taskId) as { count: number };
      if (count.count > current.mission.grant.intervention.maxPerIncident)
        throw new DomainError("mission_intervention_limit", "Intervention budget exhausted", 409);
    };
    return this.arbiter.dispatchAutomated(initial.run.id, async () => {
      assertCurrent();
      const count = this.store.database
        .prepare("SELECT COUNT(*) AS count FROM mission_interventions WHERE task_id = ?")
        .get(input.taskId) as { count: number };
      if (count.count >= initial.mission.grant.intervention.maxPerIncident)
        throw new DomainError("mission_intervention_limit", "Intervention budget exhausted", 409);
      const uncertain = this.store.database
        .prepare(
          "SELECT id FROM mission_interventions WHERE task_id = ? AND state IN ('writing', 'ambiguous') LIMIT 1",
        )
        .get(input.taskId);
      if (uncertain !== undefined)
        throw new DomainError(
          "mission_intervention_ambiguous",
          "An earlier intervention requires human inspection",
          409,
        );
      const observed = await this.runtime.observeRun(initial.run);
      if (
        observed.state !== "present" ||
        observed.process?.expectedProviderMatch !== "match" ||
        observed.process.processFingerprint !== target.processFingerprint
      )
        throw new DomainError(
          "mission_process_unverified",
          "Target process identity is not current",
          409,
        );
      assertCurrent();
      const id = `intervention_${randomUUID()}`;
      const timestamp = this.now().toISOString();
      this.store.database
        .prepare(
          "INSERT INTO mission_interventions (id, mission_id, task_id, observation_id, request_id, request_digest, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'writing', ?, ?)",
        )
        .run(
          id,
          input.missionId,
          input.taskId,
          input.observationId,
          input.requestId,
          digest,
          timestamp,
          timestamp,
        );
      try {
        await this.runtime.pasteToRun(
          initial.run,
          `[Mission intervention ${id}; task ${input.taskId}]\n${input.prompt}`,
          assertCurrent,
        );
        this.store.database
          .prepare(
            "UPDATE mission_interventions SET state = 'submitted', updated_at = ? WHERE id = ?",
          )
          .run(this.now().toISOString(), id);
        return { id, state: "submitted" };
      } catch {
        this.store.database
          .prepare(
            "UPDATE mission_interventions SET state = 'ambiguous', updated_at = ? WHERE id = ?",
          )
          .run(this.now().toISOString(), id);
        return { id, state: "ambiguous" };
      }
    });
  }
}
