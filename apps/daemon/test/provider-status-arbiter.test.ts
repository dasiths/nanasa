import { createHash } from "node:crypto";
import {
  canonicalJson,
  type ProviderAuthorityFence,
  type StatusSourceClaimV3,
} from "@nanasa/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { arbitrateProviderStatus } from "../src/providers/provider-status-arbiter.js";
import type { ResolvedProviderAdapter } from "../src/providers/resolved-provider-adapter.js";

const receivedAt = "2026-09-01T00:00:00.000Z";
const fence: ProviderAuthorityFence = {
  runId: "run-one",
  generation: 1,
  bindingId: "binding-one",
  providerId: "copilot",
  snapshotDigest: "1".repeat(64),
  processIncarnationDigest: "2".repeat(64),
};
let snapshot: ResolvedProviderAdapter;
let policyDigest: string;

beforeAll(async () => {
  snapshot = (await buildTrustedBuiltinCopilotPackage()).resolved;
  fence.snapshotDigest = snapshot.digest;
  const policy = snapshot.body.capabilities.find(
    (capability) => capability.id === "semantic-status",
  )!.payload;
  policyDigest = createHash("sha256").update(canonicalJson(policy)).digest("hex");
});

function claim(
  id: string,
  input: Partial<StatusSourceClaimV3> &
    Pick<StatusSourceClaimV3, "source" | "claimType" | "confidence" | "reasonCode">,
): StatusSourceClaimV3 {
  return {
    id,
    fence,
    policyDigest,
    sourceId: `${input.source}-source`,
    sourceSequence: 1,
    receivedAt,
    ...input,
  } as StatusSourceClaimV3;
}

describe("provider-aware status arbitration", () => {
  it("projects process-only presence as Running without semantic or revision churn", () => {
    const first = arbitrateProviderStatus({
      snapshot,
      fence,
      policyDigest,
      desiredState: "running",
      claims: [
        claim("process-one", {
          source: "process",
          claimType: "process-liveness",
          processState: "present",
          confidence: "high",
          reasonCode: "process.present",
        }),
      ],
      completionRevision: 0,
      now: receivedAt,
    });
    expect(first.status).toMatchObject({
      projection: "running",
      semanticState: "unknown",
      outcome: "unknown",
      statusRevision: 1,
    });

    const unchanged = arbitrateProviderStatus({
      snapshot,
      fence,
      policyDigest,
      desiredState: "running",
      claims: [
        claim("process-two", {
          source: "process",
          claimType: "process-liveness",
          processState: "present",
          confidence: "high",
          reasonCode: "process.present",
          sourceSequence: 2,
          receivedAt: "2026-09-01T00:00:01.000Z",
        }),
      ],
      previous: first.status,
      completionRevision: 0,
      now: "2026-09-01T00:00:01.000Z",
    });
    expect(unchanged.status.statusRevision).toBe(1);
    expect(unchanged.status.observedAt).toBe(receivedAt);
  });

  it("keeps reporter semantics above screen hints and exact waits above both", () => {
    const process = claim("process", {
      source: "process",
      claimType: "process-liveness",
      processState: "present",
      confidence: "high",
      reasonCode: "process.present",
    });
    const working = claim("reporter-working", {
      source: "reporter",
      claimType: "semantic-state",
      semanticState: "working",
      confidence: "high",
      reasonCode: "reporter.turn-active",
    });
    const screenIdle = claim("screen-idle", {
      source: "screen",
      claimType: "semantic-state",
      semanticState: "idle",
      confidence: "medium",
      reasonCode: "screen.prompt-visible",
    });
    const semantic = arbitrateProviderStatus({
      snapshot,
      fence,
      policyDigest,
      desiredState: "running",
      claims: [process, screenIdle, working],
      completionRevision: 0,
      now: receivedAt,
    });
    expect(semantic.status).toMatchObject({
      projection: "working",
      semanticState: "working",
      winningClaimId: "reporter-working",
    });

    const waiting = arbitrateProviderStatus({
      snapshot,
      fence,
      policyDigest,
      desiredState: "running",
      claims: [
        process,
        screenIdle,
        working,
        claim("wait-one", {
          source: "reporter",
          claimType: "exact-wait",
          waitRequestId: "request-one",
          confidence: "high",
          reasonCode: "wait.permission",
        }),
      ],
      completionRevision: 0,
      now: receivedAt,
    });
    expect(waiting.status).toMatchObject({
      projection: "blocked",
      semanticState: "blocked",
      phase: "permission",
      winningClaimId: "wait-one",
    });
  });

  it("projects process exit without inventing success or completion", () => {
    const result = arbitrateProviderStatus({
      snapshot,
      fence,
      policyDigest,
      desiredState: "running",
      claims: [
        claim("process-dead", {
          source: "process",
          claimType: "process-liveness",
          processState: "dead",
          confidence: "high",
          reasonCode: "process.dead",
        }),
      ],
      completionRevision: 4,
      now: receivedAt,
    });
    expect(result.status).toMatchObject({
      projection: "failed",
      semanticState: "failed",
      phase: "exited",
      outcome: "unknown",
      completionRevision: 4,
    });
  });

  it("uses phase thresholds, resets old outcomes, and separates reporter health", () => {
    const result = arbitrateProviderStatus({
      snapshot,
      fence,
      policyDigest,
      desiredState: "running",
      claims: [
        claim("working", {
          source: "reporter",
          claimType: "semantic-state",
          semanticState: "working",
          confidence: "high",
          reasonCode: "reporter.turn-active",
        }),
        claim("model-phase", {
          source: "reporter",
          claimType: "phase",
          phase: "model",
          confidence: "high",
          reasonCode: "reporter.model",
        }),
        claim("old-outcome", {
          source: "reporter",
          claimType: "outcome",
          outcome: "failed",
          confidence: "high",
          reasonCode: "reporter.failure",
        }),
        claim("reporter-health", {
          source: "reporter",
          claimType: "observer-health",
          confidence: "low",
          reasonCode: "reporter.transport-degraded",
        }),
      ],
      completionRevision: 2,
      rootTurnOpenedAt: "2026-09-01T00:00:01.000Z",
      now: "2026-09-01T00:02:00.000Z",
    });
    expect(result.status).toMatchObject({
      projection: "suspected-stuck",
      semanticState: "suspected-stuck",
      phase: "model",
      outcome: "unknown",
    });
    expect(result.reporterHealth).toBe("degraded");
  });

  it("rejects claims from another process incarnation", () => {
    const wrongFence = { ...fence, processIncarnationDigest: "f".repeat(64) };
    const result = arbitrateProviderStatus({
      snapshot,
      fence,
      policyDigest,
      desiredState: "running",
      claims: [
        claim("wrong-process", {
          fence: wrongFence,
          source: "reporter",
          claimType: "semantic-state",
          semanticState: "idle",
          confidence: "high",
          reasonCode: "reporter.idle",
        }),
      ],
      completionRevision: 0,
      now: receivedAt,
    });
    expect(result.status).toMatchObject({ projection: "unknown", semanticState: "unknown" });
    expect(result.status.activeClaimIds).toEqual([]);
  });
});
