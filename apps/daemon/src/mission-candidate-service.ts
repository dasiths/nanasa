import { createHash, randomUUID } from "node:crypto";
import {
  type IntegrateMissionCommand,
  IntegrateMissionCommandSchema,
  type MissionCandidate,
  MissionCandidateSchema,
} from "@nanasa/contracts";
import type { GitCommandAdapter } from "./git/git-command-adapter.js";
import type { WorktreeService } from "./git/worktree-service.js";
import type { McpForemanPrincipal } from "./mcp-auth.js";
import type { MissionRepository } from "./mission-repository.js";
import type { MissionTeamService } from "./mission-team-service.js";
import {
  type MissionVerificationService,
  runMissionVerification,
} from "./mission-verification-service.js";
import { DomainError, NanasaStore } from "./store.js";

export class MissionCandidateService {
  #tail: Promise<unknown> = Promise.resolve();
  public constructor(
    private readonly store: NanasaStore,
    private readonly missions: MissionRepository,
    private readonly teams: MissionTeamService,
    private readonly evidence: MissionVerificationService,
    private readonly worktrees: Pick<WorktreeService, "create">,
    private readonly git: Pick<GitCommandAdapter, "run">,
  ) {}

  public get(missionId: string): MissionCandidate | undefined {
    const row = this.store.database
      .prepare("SELECT * FROM mission_candidates WHERE mission_id = ?")
      .get(missionId);
    return row === undefined
      ? undefined
      : MissionCandidateSchema.parse({
          id: row.id,
          missionId: row.mission_id,
          branch: row.branch,
          checkoutId: row.checkout_id ?? undefined,
          worktreeId: row.worktree_id ?? undefined,
          commit: row.candidate_commit ?? undefined,
          state: row.state,
          taskCommits: JSON.parse(String(row.task_commits_json)),
          checks: JSON.parse(String(row.checks_json)),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
  }
  public recoverInterrupted(): void {
    this.store.database
      .prepare(
        "UPDATE mission_candidates SET state = 'blocked', updated_at = ? WHERE state IN ('creating', 'verifying')",
      )
      .run(new Date().toISOString());
  }
  public integrate(
    principal: McpForemanPrincipal,
    command: IntegrateMissionCommand,
  ): Promise<MissionCandidate> {
    const input = IntegrateMissionCommandSchema.parse(command);
    const pending = this.#tail.then(() => this.#integrate(principal, input));
    this.#tail = pending.catch(() => undefined);
    return pending;
  }
  public async close(): Promise<void> {
    await this.#tail;
  }

  public async assertCurrent(missionId: string): Promise<void> {
    const candidate = this.get(missionId);
    if (
      candidate?.state !== "passed" ||
      candidate.checkoutId === undefined ||
      candidate.commit === undefined
    )
      throw new DomainError(
        "mission_candidate_required",
        "An integrated verified candidate is required",
        409,
      );
    await this.evidence.assertAcceptanceCurrent(missionId);
    const checkout = this.store.getCheckout(candidate.checkoutId);
    const head = await this.git.run(["-C", checkout.path, "rev-parse", "HEAD"]);
    const status = await this.git.run([
      "-C",
      checkout.path,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (head.stdout.trim() !== candidate.commit || status.stdout.trim() !== "")
      throw new DomainError(
        "mission_candidate_changed",
        "Integrated candidate changed after verification",
        409,
      );
  }

  async #integrate(
    principal: McpForemanPrincipal,
    input: IntegrateMissionCommand,
  ): Promise<MissionCandidate> {
    const mission = this.missions.assertForeman(
      principal,
      input.missionId,
      input.expectedGrantRevision,
      true,
      ["verifying", "awaiting-acceptance"],
    );
    const existing = this.get(mission.id);
    if (existing !== undefined) {
      if (existing.state === "passed") {
        await this.assertCurrent(mission.id);
        return existing;
      }
      throw new DomainError(
        "mission_candidate_blocked",
        "Interrupted candidate integration requires human inspection; no Git operation will be replayed",
        409,
      );
    }
    await this.evidence.assertAcceptanceCurrent(mission.id);
    const tasks = this.missions.workspace(mission.id).tasks;
    const allEvidence = this.evidence.list(mission.id);
    const commits = [
      ...new Set(
        tasks.map(
          (task) =>
            allEvidence
              .filter((record) => record.taskId === task.id && record.state === "passed")
              .at(-1)!.candidateCommit,
        ),
      ),
    ];
    const allocations = this.teams.list(mission.id);
    const first = allocations[0];
    if (
      first === undefined ||
      allocations.some(
        (allocation) =>
          allocation.sourceCheckoutId !== first.sourceCheckoutId ||
          allocation.baseCommit !== first.baseCommit,
      )
    )
      throw new DomainError(
        "mission_candidate_sources_conflict",
        "Mission teams must share a pinned integration base",
        409,
      );
    if (mission.verification.length === 0)
      throw new DomainError(
        "mission_recipe_missing",
        "Integration verification recipes are required",
        409,
      );
    if (
      !this.missions.requestApproval(
        mission,
        "verification",
        `integrate:${createHash("sha256").update(JSON.stringify(commits)).digest("hex")}`,
        `Integrate ${commits.length} verified task commits from base ${first.baseCommit}`,
      )
    )
      throw new DomainError(
        "mission_approval_required",
        "Operator approval is required to integrate this candidate",
        403,
      );
    const id = `candidate_${randomUUID()}`;
    const branch = `nanasa/${id}`;
    const timestamp = new Date().toISOString();
    this.store.database
      .prepare(
        "INSERT INTO mission_candidates (id, mission_id, request_id, branch, state, task_commits_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'creating', ?, ?, ?)",
      )
      .run(id, mission.id, input.requestId, branch, JSON.stringify(commits), timestamp, timestamp);
    try {
      this.missions.assertForeman(principal, mission.id, input.expectedGrantRevision, true, [
        "verifying",
      ]);
      const created = await this.worktrees.create({
        sourceCheckoutId: first.sourceCheckoutId,
        base: first.baseCommit,
        branch,
      });
      if (
        created.operation.kind !== "create-worktree" ||
        created.worktree?.state !== "ready" ||
        created.checkout === undefined
      )
        throw new DomainError(
          "mission_candidate_not_owned",
          "Integration did not create an owned candidate worktree",
          409,
        );
      const checkout = created.checkout;
      this.store.database
        .prepare(
          "UPDATE mission_candidates SET checkout_id = ?, worktree_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(checkout.id, created.worktree.id, new Date().toISOString(), id);
      for (const commit of commits) {
        this.missions.assertForeman(principal, mission.id, input.expectedGrantRevision, true, [
          "verifying",
        ]);
        await this.git.run([
          "-C",
          checkout.path,
          "-c",
          "user.name=Nanasa Foreman",
          "-c",
          "user.email=nanasa@localhost",
          "merge",
          "--no-edit",
          "--no-ff",
          commit,
        ]);
      }
      const candidateCommit = (
        await this.git.run(["-C", checkout.path, "rev-parse", "HEAD"])
      ).stdout.trim();
      this.store.database
        .prepare(
          "UPDATE mission_candidates SET state = 'verifying', candidate_commit = ?, updated_at = ? WHERE id = ?",
        )
        .run(candidateCommit, new Date().toISOString(), id);
      const checks: MissionCandidate["checks"] = [];
      for (const recipe of mission.verification) {
        this.missions.assertForeman(principal, mission.id, input.expectedGrantRevision, true, [
          "verifying",
        ]);
        const result = await runMissionVerification(recipe, checkout.path);
        checks.push({ recipeId: recipe.id, ...result });
        this.store.database
          .prepare("UPDATE mission_candidates SET checks_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(checks), new Date().toISOString(), id);
        if (result.exitCode !== 0)
          throw new DomainError(
            "mission_integration_check_failed",
            "Integrated candidate verification failed",
            409,
          );
      }
      const head = await this.git.run(["-C", checkout.path, "rev-parse", "HEAD"]);
      const status = await this.git.run([
        "-C",
        checkout.path,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (head.stdout.trim() !== candidateCommit || status.stdout.trim() !== "")
        throw new DomainError(
          "mission_candidate_changed",
          "Integrated candidate changed during verification",
          409,
        );
      this.store.atomic(() => {
        this.missions.assertForeman(principal, mission.id, input.expectedGrantRevision, true, [
          "verifying",
        ]);
        this.store.database
          .prepare("UPDATE mission_candidates SET state = 'passed', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), id);
        this.store.database
          .prepare(
            "UPDATE missions SET state = 'awaiting-acceptance', revision = revision + 1, grant_revision = grant_revision + 1, updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), mission.id);
      });
      return this.get(mission.id)!;
    } catch (error) {
      this.store.database
        .prepare("UPDATE mission_candidates SET state = 'blocked', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      throw error;
    }
  }
}
