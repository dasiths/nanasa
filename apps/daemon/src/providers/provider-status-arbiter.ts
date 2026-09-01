import {
  canonicalJson,
  type EffectiveAgentStatusV3,
  EffectiveAgentStatusV3Schema,
  type ProviderAuthorityFence,
  type StatusSourceClaimV3,
  StatusSourceClaimV3Schema,
} from "@nanasa/contracts";
import { providerStatusPolicy } from "./provider-status-policy.js";
import type { ResolvedProviderAdapter } from "./resolved-provider-adapter.js";

export interface ProviderStatusArbitrationInput {
  readonly snapshot: ResolvedProviderAdapter;
  readonly fence: ProviderAuthorityFence;
  readonly policyDigest: string;
  readonly desiredState: "running" | "stopped";
  readonly claims: readonly unknown[];
  readonly previous?: EffectiveAgentStatusV3;
  readonly completionRevision: number;
  readonly rootTurnOpenedAt?: string;
  readonly now?: string;
}

export interface ProviderStatusArbitration {
  readonly status: EffectiveAgentStatusV3;
  readonly reporterHealth: "healthy" | "degraded" | "unavailable" | "unknown";
}

function sameFence(left: ProviderAuthorityFence, right: ProviderAuthorityFence): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function newest(claims: readonly StatusSourceClaimV3[]): StatusSourceClaimV3 | undefined {
  return [...claims].sort(
    (left, right) =>
      right.sourceSequence - left.sourceSequence ||
      Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
  )[0];
}

function waitPhase(reasonCode: string): EffectiveAgentStatusV3["phase"] {
  if (reasonCode.includes("plan")) return "plan-approval";
  if (reasonCode.includes("question") || reasonCode.includes("elicitation")) return "question";
  return "permission";
}

function meaningfulStatus(status: EffectiveAgentStatusV3): unknown {
  return {
    runId: status.runId,
    generation: status.generation,
    providerId: status.providerId,
    snapshotDigest: status.snapshotDigest,
    processIncarnationDigest: status.processIncarnationDigest,
    policyDigest: status.policyDigest,
    projection: status.projection,
    semanticState: status.semanticState,
    phase: status.phase,
    outcome: status.outcome,
    confidence: status.confidence,
    completionRevision: status.completionRevision,
  };
}

export function arbitrateProviderStatus(
  input: ProviderStatusArbitrationInput,
): ProviderStatusArbitration {
  const now = input.now ?? new Date().toISOString();
  const nowTime = Date.parse(now);
  const policy = providerStatusPolicy(input.snapshot).semantic;
  const claims = input.claims
    .map((claim) => StatusSourceClaimV3Schema.safeParse(claim))
    .filter((result) => result.success)
    .map((result) => result.data)
    .filter(
      (claim) =>
        sameFence(claim.fence, input.fence) &&
        claim.policyDigest === input.policyDigest &&
        (claim.expiresAt === undefined || Date.parse(claim.expiresAt) > nowTime),
    );
  const process = newest(claims.filter((claim) => claim.claimType === "process-liveness"));
  const reporterHealthClaim = newest(
    claims.filter((claim) => claim.source === "reporter" && claim.claimType === "observer-health"),
  );
  const reporterHealth =
    reporterHealthClaim === undefined
      ? "unknown"
      : reporterHealthClaim.reasonCode.includes("healthy")
        ? "healthy"
        : reporterHealthClaim.reasonCode.includes("unavailable")
          ? "unavailable"
          : "degraded";
  const exactWait = newest(claims.filter((claim) => claim.claimType === "exact-wait"));
  const fatalFailure = newest(claims.filter((claim) => claim.claimType === "fatal-failure"));
  const sourceRank = new Map(policy.authorityOrder.map((source, index) => [source, index]));
  const semanticClaims = claims
    .filter((claim) => claim.claimType === "semantic-state")
    .sort(
      (left, right) =>
        (sourceRank.get(left.source) ?? Number.MAX_SAFE_INTEGER) -
          (sourceRank.get(right.source) ?? Number.MAX_SAFE_INTEGER) ||
        right.sourceSequence - left.sourceSequence ||
        Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
    );
  const semantic = semanticClaims[0];
  const phase = claims
    .filter((claim) => claim.claimType === "phase")
    .sort(
      (left, right) =>
        (semantic === undefined || left.source !== semantic.source ? 1 : 0) -
          (semantic === undefined || right.source !== semantic.source ? 1 : 0) ||
        (sourceRank.get(left.source) ?? Number.MAX_SAFE_INTEGER) -
          (sourceRank.get(right.source) ?? Number.MAX_SAFE_INTEGER) ||
        right.sourceSequence - left.sourceSequence,
    )[0];
  const rootTurnTime =
    input.rootTurnOpenedAt === undefined ? undefined : Date.parse(input.rootTurnOpenedAt);
  const outcome = newest(
    claims.filter(
      (claim) =>
        claim.claimType === "outcome" &&
        ["reporter", "status-api"].includes(claim.source) &&
        (rootTurnTime === undefined || Date.parse(claim.receivedAt) >= rootTurnTime),
    ),
  );

  let winning = semantic;
  let semanticState: EffectiveAgentStatusV3["semanticState"] = "unknown";
  let projection: EffectiveAgentStatusV3["projection"] = "unknown";
  let effectivePhase: EffectiveAgentStatusV3["phase"] = "startup";
  let confidence: EffectiveAgentStatusV3["confidence"] = "low";
  if (process?.processState === "dead" || process?.processState === "missing") {
    winning = process;
    semanticState = input.desiredState === "running" ? "failed" : "stopped";
    projection = semanticState;
    effectivePhase = "exited";
    confidence = process.confidence;
  } else if (exactWait !== undefined) {
    winning = exactWait;
    semanticState = "blocked";
    projection = "blocked";
    effectivePhase = waitPhase(exactWait.reasonCode);
    confidence = exactWait.confidence;
  } else if (fatalFailure !== undefined) {
    winning = fatalFailure;
    semanticState = "failed";
    projection = "failed";
    effectivePhase = phase?.phase ?? "settled";
    confidence = fatalFailure.confidence;
  } else if (semantic?.semanticState !== undefined) {
    semanticState = semantic.semanticState;
    effectivePhase =
      phase?.phase ??
      (semanticState === "idle"
        ? "settled"
        : semanticState === "failed" || semanticState === "stopped"
          ? "exited"
          : "model");
    const threshold = policy.thresholdsMs[effectivePhase];
    const occurredAt = semantic.sourceOccurredAt ?? semantic.receivedAt;
    if (
      semanticState === "working" &&
      threshold !== undefined &&
      nowTime - Date.parse(occurredAt) >= threshold
    ) {
      semanticState = "suspected-stuck";
    }
    projection = semanticState;
    confidence = semantic.confidence;
  } else if (process?.processState === "present") {
    winning = process;
    projection = policy.processOnlyProjection;
    semanticState = "unknown";
    effectivePhase = "startup";
    confidence = process.confidence;
  }

  const draft = EffectiveAgentStatusV3Schema.parse({
    runId: input.fence.runId,
    generation: input.fence.generation,
    providerId: input.fence.providerId,
    snapshotDigest: input.fence.snapshotDigest,
    processIncarnationDigest: input.fence.processIncarnationDigest,
    policyDigest: input.policyDigest,
    projection,
    semanticState,
    phase: effectivePhase,
    outcome: outcome?.outcome ?? "unknown",
    confidence,
    ...(winning === undefined ? {} : { winningClaimId: winning.id }),
    activeClaimIds: claims.map((claim) => claim.id).sort(),
    statusRevision: (input.previous?.statusRevision ?? 0) + 1,
    completionRevision: input.completionRevision,
    observedAt: now,
  });
  const unchanged =
    input.previous !== undefined &&
    canonicalJson(meaningfulStatus(input.previous)) === canonicalJson(meaningfulStatus(draft));
  const status = unchanged
    ? EffectiveAgentStatusV3Schema.parse({
        ...draft,
        statusRevision: input.previous!.statusRevision,
        observedAt: input.previous!.observedAt,
      })
    : draft;
  return Object.freeze({ status: Object.freeze(status), reporterHealth });
}
