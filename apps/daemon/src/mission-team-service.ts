import { createHash, randomUUID } from "node:crypto";
import {
  type ConfiguredGroup,
  ConfiguredGroupSchema,
  canonicalJson,
  type MissionTeamAllocation,
  MissionTeamAllocationSchema,
  type ProvisionMissionTeamCommand,
  ProvisionMissionTeamCommandSchema,
} from "@nanasa/contracts";
import type { ConfigRepository } from "./config-repository.js";
import type { GitCommandAdapter } from "./git/git-command-adapter.js";
import type { WorktreeService } from "./git/worktree-service.js";
import { validateInstructionFiles } from "./instruction-resolver.js";
import type { McpForemanPrincipal } from "./mcp-auth.js";
import type { MissionRepository } from "./mission-repository.js";
import type { ProviderRunBindingRepository } from "./providers/provider-run-binding-repository.js";
import type { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
import { DomainError, NanasaStore } from "./store.js";

export function runtimeMissionGroups(store: NanasaStore): Record<string, ConfiguredGroup> {
  return Object.fromEntries(
    store.database
      .prepare("SELECT group_id, group_json FROM mission_team_allocations WHERE state = 'ready'")
      .all()
      .map((row) => [
        String(row.group_id),
        ConfiguredGroupSchema.parse(JSON.parse(String(row.group_json))),
      ]),
  );
}

export class MissionTeamService {
  #tail: Promise<unknown> = Promise.resolve();
  public constructor(
    private readonly store: NanasaStore,
    private readonly missions: MissionRepository,
    private readonly config: ConfigRepository,
    private readonly worktrees: Pick<WorktreeService, "create">,
    private readonly git: Pick<GitCommandAdapter, "run">,
    private readonly coordinator: Pick<RunRuntimeCoordinator, "assignGroupCheckout">,
    private readonly bindings: Pick<ProviderRunBindingRepository, "resolveActiveSnapshot">,
  ) {}

  public list(missionId: string): MissionTeamAllocation[] {
    this.missions.get(missionId);
    return this.store.database
      .prepare(
        "SELECT * FROM mission_team_allocations WHERE mission_id = ? ORDER BY created_at, id",
      )
      .all(missionId)
      .map((row) => this.#hydrate(row));
  }

  public provision(
    principal: McpForemanPrincipal,
    missionId: string,
    command: ProvisionMissionTeamCommand,
  ): Promise<MissionTeamAllocation> {
    const input = ProvisionMissionTeamCommandSchema.parse(command);
    const pending = this.#tail.then(() => this.#provision(principal, missionId, input));
    this.#tail = pending.catch(() => undefined);
    return pending;
  }

  public recoverInterrupted(): void {
    this.store.database
      .prepare(
        "UPDATE mission_team_allocations SET state = 'blocked', updated_at = ? WHERE state = 'creating'",
      )
      .run(new Date().toISOString());
  }

  public async close(): Promise<void> {
    await this.#tail;
  }

  async #provision(
    principal: McpForemanPrincipal,
    missionId: string,
    input: ProvisionMissionTeamCommand,
  ): Promise<MissionTeamAllocation> {
    const mission = this.missions.assertForeman(principal, missionId, input.expectedGrantRevision);
    if (mission.state !== "running")
      throw new DomainError(
        "mission_provision_approval_required",
        "Team creation requires a running bounded mission grant",
        403,
      );
    const loaded = this.config.load();
    if (loaded.status.revision !== input.expectedConfigRevision)
      throw new DomainError(
        "config_revision_conflict",
        "Configuration changed before provisioning",
        409,
      );
    const template = loaded.config.teamTemplates?.[input.templateId];
    if (!mission.grant.permittedTeamTemplates.includes(input.templateId) || template === undefined)
      throw new DomainError(
        "mission_template_forbidden",
        "Team template is not approved for this mission",
        403,
      );
    validateInstructionFiles(loaded.repoRoot, loaded.config);
    const approvalKey = createHash("sha256")
      .update(
        canonicalJson({
          requestId: input.requestId,
          templateId: input.templateId,
          sourceCheckoutId: input.sourceCheckoutId,
          baseCommit: input.baseCommit,
          configRevision: input.expectedConfigRevision,
        }),
      )
      .digest("hex");
    if (
      !this.missions.requestApproval(
        mission,
        "provision",
        approvalKey,
        `Provision template ${input.templateId} at ${input.baseCommit} from checkout ${input.sourceCheckoutId}`,
      )
    )
      throw new DomainError(
        "mission_approval_required",
        "Operator approval is required for this exact team allocation",
        403,
      );
    const source = this.store.getCheckout(input.sourceCheckoutId);
    if (source.kind === "bare")
      throw new DomainError(
        "mission_checkout_invalid",
        "Mission source must be a working checkout",
        409,
      );
    const digest = createHash("sha256")
      .update(
        canonicalJson({
          templateId: input.templateId,
          sourceCheckoutId: input.sourceCheckoutId,
          baseCommit: input.baseCommit,
        }),
      )
      .digest("hex");
    let row = this.store.database
      .prepare("SELECT * FROM mission_team_allocations WHERE mission_id = ? AND request_id = ?")
      .get(missionId, input.requestId);
    if (row !== undefined) {
      if (row.request_digest !== digest)
        throw new DomainError(
          "mission_allocation_conflict",
          "Allocation request ID was reused for different content",
          409,
        );
      if (row.state === "ready") return this.#hydrate(row);
      if (row.state !== "prepared")
        throw new DomainError(
          "mission_allocation_blocked",
          "Interrupted allocation requires human inspection; no creation will be replayed",
          409,
        );
    }
    for (const member of Object.values(template.members)) {
      const integration = loaded.config.integrations[member.integrationId];
      if (integration?.commandSource !== "builtin")
        throw new DomainError(
          "mission_provider_consent_required",
          "Mission templates require authorized built-in provider commands",
          403,
        );
      await this.bindings.resolveActiveSnapshot(integration.kind);
    }
    if (row === undefined) {
      const count = this.list(missionId).length;
      if (count >= mission.grant.maxTeamsPerMission)
        throw new DomainError("mission_team_limit", "Mission team budget is exhausted", 409);
      const id = `allocation_${randomUUID()}`;
      const suffix = createHash("sha256").update(id).digest("hex").slice(0, 16);
      const groupId = `mission-team-${suffix}`;
      const branch = `nanasa/mission-${suffix}`;
      const group = ConfiguredGroupSchema.parse({
        name: `${mission.title.slice(0, 65)} / ${input.templateId.slice(0, 25)}`,
        instructions: template.instructions,
        agents: Object.fromEntries(
          Object.entries(template.members).map(([slot, member], order) => {
            const memberId = `mission-${suffix}-${order}`;
            return [
              memberId,
              {
                ...member,
                memberId,
                name: member.name ?? loaded.config.roles[member.roleId]?.name ?? slot,
                order,
              },
            ];
          }),
        ),
      });
      if (loaded.config.groups[groupId] !== undefined)
        throw new DomainError("mission_group_collision", "Runtime team ID is already in use", 409);
      const timestamp = new Date().toISOString();
      this.store.database
        .prepare(`INSERT INTO mission_team_allocations
        (id, mission_id, request_id, request_digest, group_id, template_id, template_digest, group_json, source_checkout_id, base_commit, branch, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`)
        .run(
          id,
          missionId,
          input.requestId,
          digest,
          groupId,
          input.templateId,
          createHash("sha256").update(canonicalJson(template)).digest("hex"),
          JSON.stringify(group),
          source.id,
          input.baseCommit,
          branch,
          timestamp,
          timestamp,
        );
      row = this.store.database
        .prepare("SELECT * FROM mission_team_allocations WHERE id = ?")
        .get(id)!;
    }
    const allocation = this.#hydrate(row);
    const branch = await this.git.run(
      ["-C", source.path, "show-ref", "--verify", "--quiet", `refs/heads/${allocation.branch}`],
      { allowFailure: true },
    );
    if (branch.exitCode !== 1)
      throw new DomainError(
        "mission_branch_collision",
        "Mission branch exists or could not be checked; refusing adoption",
        409,
      );
    this.missions.assertForeman(principal, missionId, input.expectedGrantRevision);
    if (this.config.load().status.revision !== input.expectedConfigRevision)
      throw new DomainError(
        "config_revision_conflict",
        "Configuration changed before worktree creation",
        409,
      );
    this.store.database
      .prepare(
        "UPDATE mission_team_allocations SET state = 'creating', updated_at = ? WHERE id = ? AND state = 'prepared'",
      )
      .run(new Date().toISOString(), allocation.id);
    try {
      const result = await this.worktrees.create({
        sourceCheckoutId: source.id,
        branch: allocation.branch,
        base: input.baseCommit,
      });
      if (
        result.operation.kind !== "create-worktree" ||
        result.worktree?.state !== "ready" ||
        result.checkout === undefined ||
        result.checkout.repositoryId !== source.repositoryId
      )
        throw new DomainError(
          "mission_worktree_not_owned",
          "Creation did not produce a new owned mission worktree",
          409,
        );
      this.store.database
        .prepare(
          "UPDATE mission_team_allocations SET checkout_id = ?, worktree_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(result.checkout.id, result.worktree.id, new Date().toISOString(), allocation.id);
      this.missions.assertForeman(principal, missionId, input.expectedGrantRevision);
      if (this.config.load().status.revision !== input.expectedConfigRevision)
        throw new DomainError(
          "config_revision_conflict",
          "Configuration changed during worktree creation",
          409,
        );
      this.store.database
        .prepare("UPDATE mission_team_allocations SET state = 'ready', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), allocation.id);
      const current = this.config.load();
      this.store.reconcileTopology(current.config, current.status);
      const group = this.store.getGroup(allocation.groupId);
      await this.coordinator.assignGroupCheckout(allocation.groupId, {
        checkoutId: result.checkout.id,
        expectedCheckoutRevision: group.checkoutRevision,
        switchPolicy: "require-stopped",
      });
      return this.list(missionId).find((item) => item.id === allocation.id)!;
    } catch (error) {
      this.store.database
        .prepare(
          "UPDATE mission_team_allocations SET state = 'blocked', updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), allocation.id);
      throw error;
    }
  }

  #hydrate(row: Record<string, unknown>): MissionTeamAllocation {
    return MissionTeamAllocationSchema.parse({
      id: row.id,
      missionId: row.mission_id,
      groupId: row.group_id,
      templateId: row.template_id,
      templateDigest: row.template_digest,
      sourceCheckoutId: row.source_checkout_id,
      baseCommit: row.base_commit,
      branch: row.branch,
      checkoutId: row.checkout_id ?? undefined,
      worktreeId: row.worktree_id ?? undefined,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
