import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  type MissionEvidence,
  MissionEvidenceSchema,
  type MissionVerificationRecipe,
  type VerifyMissionTaskCommand,
  VerifyMissionTaskCommandSchema,
} from "@nanasa/contracts";
import type { GitCommandAdapter } from "./git/git-command-adapter.js";
import type { McpForemanPrincipal } from "./mcp-auth.js";
import type { MissionRepository } from "./mission-repository.js";
import type { MissionTeamService } from "./mission-team-service.js";
import { DomainError, NanasaStore } from "./store.js";

export function runMissionVerification(
  recipe: MissionVerificationRecipe,
  cwd: string,
): Promise<{ exitCode: number; outputDigest: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(recipe.command[0]!, recipe.command.slice(1), {
      cwd,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        CI: "true",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const hash = createHash("sha256");
    let bytes = 0;
    let failed = false;
    const kill = () => {
      failed = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(kill, recipe.timeoutSeconds * 1000);
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) kill();
      else hash.update(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new DomainError(
          "mission_verifier_unavailable",
          "Verification command could not be started",
          409,
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: failed ? -1 : (code ?? -1), outputDigest: hash.digest("hex") });
    });
  });
}

export class MissionVerificationService {
  #tail: Promise<unknown> = Promise.resolve();
  public constructor(
    private readonly store: NanasaStore,
    private readonly missions: MissionRepository,
    private readonly teams: Pick<MissionTeamService, "list">,
    private readonly git: Pick<GitCommandAdapter, "run">,
    private readonly execute = runMissionVerification,
  ) {}

  public list(missionId: string): MissionEvidence[] {
    this.missions.get(missionId);
    return this.store.database
      .prepare(
        "SELECT * FROM mission_evidence WHERE mission_id = ? ORDER BY created_at, id LIMIT 4096",
      )
      .all(missionId)
      .map((row) => this.#hydrate(row));
  }

  public recoverInterrupted(): void {
    this.store.database
      .prepare(
        "UPDATE mission_evidence SET state = 'ambiguous', completed_at = ? WHERE state = 'running'",
      )
      .run(new Date().toISOString());
  }

  public verify(
    principal: McpForemanPrincipal,
    command: VerifyMissionTaskCommand,
  ): Promise<MissionEvidence[]> {
    const input = VerifyMissionTaskCommandSchema.parse(command);
    const pending = this.#tail.then(() => this.#verify(principal, input));
    this.#tail = pending.catch(() => undefined);
    return pending;
  }
  public async close(): Promise<void> {
    await this.#tail;
  }

  async #assertCandidate(path: string, commit: string): Promise<void> {
    const head = await this.git.run(["-C", path, "rev-parse", "HEAD"]);
    const status = await this.git.run([
      "-C",
      path,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (head.stdout.trim() !== commit || status.stdout.trim() !== "")
      throw new DomainError(
        "mission_candidate_changed",
        "Verification requires the exact committed clean candidate",
        409,
      );
  }

  public async assertAcceptanceCurrent(missionId: string): Promise<void> {
    const workspace = this.missions.workspace(missionId);
    const evidence = this.list(missionId);
    if (workspace.tasks.length === 0 || workspace.tasks.some((task) => task.state !== "accepted"))
      throw new DomainError(
        "mission_evidence_required",
        "Every mission task must have accepted evidence",
        409,
      );
    for (const task of workspace.tasks) {
      const records = [
        ...new Map(
          evidence
            .filter((record) => record.taskId === task.id)
            .map((record) => [record.recipeId, record]),
        ).values(),
      ];
      if (records.length === 0)
        throw new DomainError("mission_evidence_required", "Task has no passing evidence", 409);
      for (const record of records) {
        if (record.state !== "passed")
          throw new DomainError(
            "mission_evidence_required",
            "Latest task verification did not pass",
            409,
          );
        await this.#assertCandidate(
          this.store.getCheckout(record.checkoutId).path,
          record.candidateCommit,
        );
      }
    }
  }

  async #verify(
    principal: McpForemanPrincipal,
    input: VerifyMissionTaskCommand,
  ): Promise<MissionEvidence[]> {
    const mission = this.missions.assertForeman(
      principal,
      input.missionId,
      input.expectedGrantRevision,
      true,
      ["running", "awaiting-acceptance"],
    );
    if (
      !this.missions.requestApproval(
        mission,
        "verification",
        `${input.taskId}:${input.candidateCommit}`,
        `Verify task ${input.taskId} at candidate ${input.candidateCommit}`,
      )
    )
      throw new DomainError(
        "mission_approval_required",
        "Operator approval is required for this exact verification",
        403,
      );
    const task = this.missions
      .workspace(mission.id)
      .tasks.find((candidate) => candidate.id === input.taskId);
    if (
      task === undefined ||
      !["verifying", "accepted"].includes(task.state) ||
      task.actionId === undefined
    )
      throw new DomainError(
        "mission_task_not_verifying",
        "Task must finish its exact action before verification",
        409,
      );
    const action = this.store.getAgentAction(task.actionId);
    if (
      action.state !== "completed" ||
      action.target.runId !== task.runId ||
      action.target.generation !== task.generation
    )
      throw new DomainError(
        "mission_action_unverified",
        "Task action has not completed with exact runtime evidence",
        409,
      );
    const allocation = this.teams
      .list(mission.id)
      .find((team) => team.groupId === task.groupId && team.state === "ready");
    if (allocation?.checkoutId === undefined)
      throw new DomainError("mission_checkout_unavailable", "Task has no owned checkout", 409);
    const checkout = this.store.getCheckout(allocation.checkoutId);
    await this.#assertCandidate(checkout.path, input.candidateCommit);
    const recipes = mission.verification.filter((recipe) =>
      recipe.acceptanceIndexes.some((index) => task.acceptanceIndexes.includes(index)),
    );
    if (
      recipes.length === 0 ||
      task.acceptanceIndexes.some(
        (index) => !recipes.some((recipe) => recipe.acceptanceIndexes.includes(index)),
      )
    )
      throw new DomainError(
        "mission_recipe_missing",
        "Operator-approved verification recipes must cover every task criterion",
        409,
      );
    for (const recipe of recipes) {
      this.missions.assertForeman(principal, mission.id, input.expectedGrantRevision, true, [
        "running",
        "awaiting-acceptance",
      ]);
      const existing = this.list(mission.id).find(
        (record) =>
          record.taskId === task.id &&
          record.candidateCommit === input.candidateCommit &&
          record.recipeId === recipe.id,
      );
      if (existing !== undefined) {
        if (existing.state === "passed") continue;
        throw new DomainError(
          "mission_verification_not_replayable",
          "Failed or interrupted verification requires a new candidate or human inspection",
          409,
        );
      }
      const id = `evidence_${randomUUID()}`;
      this.store.database
        .prepare(`INSERT INTO mission_evidence
        (id, mission_id, task_id, checkout_id, candidate_commit, recipe_id, recipe_digest, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
        .run(
          id,
          mission.id,
          task.id,
          checkout.id,
          input.candidateCommit,
          recipe.id,
          createHash("sha256").update(canonicalJson(recipe)).digest("hex"),
          new Date().toISOString(),
        );
      try {
        const result = await this.execute(recipe, checkout.path);
        this.missions.assertForeman(principal, mission.id, input.expectedGrantRevision, true, [
          "running",
          "awaiting-acceptance",
        ]);
        await this.#assertCandidate(checkout.path, input.candidateCommit);
        this.store.database
          .prepare(
            "UPDATE mission_evidence SET state = ?, output_digest = ?, exit_code = ?, completed_at = ? WHERE id = ?",
          )
          .run(
            result.exitCode === 0 ? "passed" : "failed",
            result.outputDigest,
            result.exitCode,
            new Date().toISOString(),
            id,
          );
        if (result.exitCode !== 0)
          throw new DomainError("mission_verification_failed", "Verification did not pass", 409);
      } catch (error) {
        this.store.database
          .prepare(
            "UPDATE mission_evidence SET state = 'ambiguous', completed_at = ? WHERE id = ? AND state = 'running'",
          )
          .run(new Date().toISOString(), id);
        throw error;
      }
    }
    this.store.atomic(() => {
      this.missions.assertForeman(principal, mission.id, input.expectedGrantRevision, true, [
        "running",
        "awaiting-acceptance",
      ]);
      this.store.database
        .prepare(
          "UPDATE mission_tasks SET state = 'accepted', revision = revision + 1, updated_at = ? WHERE id = ? AND state = 'verifying'",
        )
        .run(new Date().toISOString(), task.id);
      const workspace = this.missions.workspace(mission.id);
      const coverage = new Set(
        workspace.tasks
          .filter((candidate) => candidate.state === "accepted")
          .flatMap((candidate) => candidate.acceptanceIndexes),
      );
      if (
        workspace.tasks.every((candidate) => candidate.state === "accepted") &&
        mission.acceptance.every((_criterion, index) => coverage.has(index))
      ) {
        this.store.database
          .prepare(
            "UPDATE missions SET state = 'verifying', revision = revision + 1, grant_revision = grant_revision + 1, updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), mission.id);
        this.store.database
          .prepare(
            "UPDATE foreman_inbox SET state = 'cancelled', updated_at = ? WHERE mission_id = ? AND state = 'queued'",
          )
          .run(new Date().toISOString(), mission.id);
      }
    });
    return this.list(mission.id).filter((record) => record.taskId === task.id);
  }

  #hydrate(row: Record<string, unknown>): MissionEvidence {
    return MissionEvidenceSchema.parse({
      id: row.id,
      missionId: row.mission_id,
      taskId: row.task_id,
      checkoutId: row.checkout_id,
      candidateCommit: row.candidate_commit,
      recipeId: row.recipe_id,
      recipeDigest: row.recipe_digest,
      state: row.state,
      outputDigest: row.output_digest ?? undefined,
      exitCode: row.exit_code ?? undefined,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
    });
  }
}
