import { randomUUID } from "node:crypto";
import type { NanasaConfig } from "@nanasa/contracts";
import { assertMissionGrantWithin, type MissionRepository } from "./mission-repository.js";
import type { NanasaStore } from "./store.js";

export class MissionRecoveryPolicy {
  public constructor(
    private readonly store: NanasaStore,
    private readonly missions: MissionRepository,
    private readonly config: () => NanasaConfig,
    private readonly hasController: (runId: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public authorize(groupId: string, memberId: string): boolean {
    const allocation = this.store.database
      .prepare(
        "SELECT mission_id, checkout_id, state FROM mission_team_allocations WHERE group_id = ?",
      )
      .get(groupId);
    if (allocation === undefined) return true;
    return this.store.atomic(() => {
      const mission = this.missions.get(String(allocation.mission_id));
      const configured = this.config().foreman;
      const run = this.store.getLatestRunForMembership(groupId, memberId);
      const now = this.now();
      if (
        allocation.state !== "ready" ||
        mission.state !== "running" ||
        mission.grant.mode !== "bounded" ||
        !mission.grant.recovery.restartMissionOwnedAgents ||
        configured?.enabled !== true ||
        configured.id !== mission.foremanId ||
        run === undefined ||
        run.desiredState !== "running" ||
        run.checkoutId !== allocation.checkout_id ||
        this.hasController(run.id) ||
        Date.parse(mission.expiresAt) <= now.getTime()
      )
        return false;
      try {
        assertMissionGrantWithin(mission.grant, configured.autonomy);
      } catch {
        return false;
      }
      const incident = this.store.database
        .prepare(
          "SELECT * FROM mission_recovery_incidents WHERE mission_id = ? AND group_id = ? AND member_id = ?",
        )
        .get(mission.id, groupId, memberId);
      const attempts = Number(incident?.attempts ?? 0);
      if (
        attempts >= mission.grant.recovery.maxAttemptsPerIncident ||
        mission.recoveryAttempts >= mission.grant.recovery.maxAttemptsPerMission ||
        (incident !== undefined && Date.parse(String(incident.next_allowed_at)) > now.getTime())
      )
        return false;
      this.store.database
        .prepare(`INSERT INTO mission_recovery_incidents (id, mission_id, group_id, member_id, attempts, previous_run_id, next_allowed_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(mission_id, group_id, member_id) DO UPDATE SET attempts = attempts + 1,
        previous_run_id = excluded.previous_run_id, next_allowed_at = excluded.next_allowed_at, updated_at = excluded.updated_at`)
        .run(
          `recovery_${randomUUID()}`,
          mission.id,
          groupId,
          memberId,
          run.id,
          new Date(now.getTime() + mission.grant.recovery.cooldownSeconds * 1000).toISOString(),
          now.toISOString(),
        );
      this.store.database
        .prepare(
          "UPDATE missions SET recovery_attempts = recovery_attempts + 1, updated_at = ? WHERE id = ?",
        )
        .run(now.toISOString(), mission.id);
      return true;
    });
  }
}
