import { createHash } from "node:crypto";
import {
  canonicalJson,
  type PortalSnapshot,
  PortalSnapshotSchema,
  type RestartAdvisory,
} from "@nanasa/contracts";
import type { ConfigRepository } from "./config-repository.js";
import { resolveEffectiveProviderPolicy } from "./provider-policy-resolver.js";
import type { ProviderRunBindingRepository } from "./providers/provider-run-binding-repository.js";
import type { ProviderRuntimeIndex } from "./providers/provider-runtime-index.js";
import type { NanasaStore } from "./store.js";

export interface SnapshotRestartAdvisoryOptions {
  readonly configRepository: ConfigRepository;
  readonly providerBindings: ProviderRunBindingRepository;
  readonly providerRuntimeIndex: ProviderRuntimeIndex;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function resolveRestartAdvisories(
  snapshot: PortalSnapshot,
  options: SnapshotRestartAdvisoryOptions,
): RestartAdvisory[] {
  const loaded = options.configRepository.load();
  const advisories: RestartAdvisory[] = [];
  for (const run of snapshot.runs) {
    if (!["starting", "running"].includes(run.status)) continue;
    const binding = options.providerBindings.getForRun(run.id, run.generation);
    if (binding === undefined) continue;
    const reasons = new Set<RestartAdvisory["reasons"][number]>();
    if (
      loaded.status.revision !== undefined &&
      binding.launchPlan.configRevision !== loaded.status.revision
    ) {
      reasons.add("configuration-changed");
    }
    try {
      if (
        options.providerRuntimeIndex.get(binding.providerId).snapshotDigest !==
        binding.snapshotDigest
      ) {
        reasons.add("provider-changed");
      }
    } catch {
      reasons.add("provider-changed");
    }

    const membership = snapshot.memberships.find(
      (candidate) => candidate.groupId === run.groupId && candidate.memberId === run.memberId,
    );
    const agent =
      membership === undefined
        ? undefined
        : loaded.config.groups[run.groupId]?.agents[membership.id];
    if (membership !== undefined && agent !== undefined) {
      try {
        const current = resolveEffectiveProviderPolicy({
          repoRoot: loaded.repoRoot,
          config: loaded.config,
          membership,
          profile: { agentType: agent.integrationId },
          allowAutonomous: true,
          allowProviderFiles: true,
          ...(loaded.status.revision === undefined
            ? {}
            : { configRevision: loaded.status.revision }),
        });
        const currentExecutionProfile =
          current.executionProfileId === undefined || current.executionProfile === undefined
            ? undefined
            : { id: current.executionProfileId, digest: digest(current.executionProfile) };
        if (
          canonicalJson(currentExecutionProfile) !==
          canonicalJson(binding.launchPlan.executionProfile)
        ) {
          reasons.add("configuration-changed");
        }
        const currentProviderFiles = current.providerFiles.map((file) => ({
          path: file.sourcePath,
          scope: file.scope,
          digest: file.digest,
        }));
        if (
          canonicalJson(currentProviderFiles) !==
          canonicalJson(binding.launchPlan.providerFiles ?? [])
        ) {
          reasons.add("provider-files-changed");
        }
      } catch {
        reasons.add("provider-files-changed");
      }
    } else {
      reasons.add("configuration-changed");
    }

    if (reasons.size > 0) {
      advisories.push({
        runId: run.id,
        groupId: run.groupId,
        memberId: run.memberId,
        reasons: [
          ...(
            ["configuration-changed", "provider-files-changed", "provider-changed"] as const
          ).filter((reason) => reasons.has(reason)),
        ],
      });
    }
  }
  return advisories;
}

export class SnapshotReadModel {
  public constructor(
    private readonly store: NanasaStore,
    private readonly authority: { instanceId: string; daemonEpoch: number },
    private readonly restartAdvisoryOptions?: SnapshotRestartAdvisoryOptions,
  ) {}

  public read(operatorId: string): PortalSnapshot {
    const snapshot = this.store.getSnapshot(this.authority, operatorId);
    if (this.restartAdvisoryOptions === undefined) return snapshot;
    const loaded = this.restartAdvisoryOptions.configRepository.load();
    return PortalSnapshotSchema.parse({
      ...snapshot,
      config: loaded.config,
      configStatus: loaded.status,
      restartAdvisories: resolveRestartAdvisories(snapshot, this.restartAdvisoryOptions),
    });
  }
}
