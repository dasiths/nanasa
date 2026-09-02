import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNanasaDatabase } from "../src/persistence/database.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { ProviderProcessIncarnationRepository } from "../src/providers/provider-process-incarnation-repository.js";
import { ProviderRunBindingRepository } from "../src/providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";
import { arbitrateProviderStatus } from "../src/providers/provider-status-arbiter.js";
import { ProviderStatusClaimRepository } from "../src/providers/provider-status-claim-repository.js";

const now = "2026-09-01T00:00:00.000Z";
let database: DatabaseSync;

beforeEach(() => {
  database = openNanasaDatabase(":memory:");
  database.exec(`
    INSERT INTO groups
      (id,name,order_index,membership_revision,message_sequence,created_at,updated_at)
    VALUES ('group-one','Group',0,0,0,'${now}','${now}');
    INSERT INTO agent_profiles
      (id,name,agent_type,kind,command,args_json,working_directory,environment_json,created_at,updated_at)
    VALUES ('profile-one','Copilot','copilot','copilot','copilot','[]',NULL,'{}','${now}','${now}');
    INSERT INTO runs
      (id,group_id,member_id,agent_profile_id,generation,status,desired_state,recovery_phase,
       recovery_attempts,launch_kind,requested_model_source,started_at)
    VALUES ('run-one','group-one','member-one','profile-one',1,'running','running','recovered',
            0,'fresh','provider-default','${now}');
  `);
});

afterEach(() => database.close());

describe("provider status claim persistence", () => {
  it("suppresses unchanged liveness writes and enforces source and process fences", async () => {
    const builtIn = await buildTrustedBuiltinCopilotPackage();
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    await index.registerTrustedBuiltin(builtIn, now);
    const bindings = new ProviderRunBindingRepository(database, index, snapshots);
    const binding = await bindings.create({
      runId: "run-one",
      generation: 1,
      integrationId: "copilot",
      providerId: "copilot",
      snapshotDigest: builtIn.snapshot.digest,
      providerStateId: "state-one",
      overlayId: "overlay-one",
      credentialSlots: {},
      launchPlan: {
        configuredCommand: ["copilot"],
        command: ["copilot"],
        overlayArguments: [],
        environmentNames: [],
        stateStorageReference: "/state/copilot",
        modelResumePolicy: "preserve-session",
      },
      launchDigest: "1".repeat(64),
      permissionFloorDigest: "2".repeat(64),
      repositoryTrustDigest: "3".repeat(64),
      createdAt: now,
    });
    const process = new ProviderProcessIncarnationRepository(database).record(
      binding,
      "%1",
      {
        foregroundPgid: 100,
        leaderPid: 100,
        pidStartIdentity: "100:50",
        executableFingerprint: "4".repeat(64),
        argvFingerprint: "5".repeat(64),
        processFingerprint: "6".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["copilot"],
      },
      now,
    );
    const claims = new ProviderStatusClaimRepository(database);
    const base = {
      fence: { ...process.fence, processIncarnationDigest: process.digest },
      policyDigest: binding.statusPolicyDigest,
      source: "process" as const,
      sourceId: "process-observer",
      claimType: "process-liveness" as const,
      processState: "present" as const,
      confidence: "high" as const,
      reasonCode: "process.present",
    };
    expect(
      claims.record({
        ...base,
        id: "claim-one",
        sourceSequence: 1,
        receivedAt: now,
      }),
    ).toMatchObject({ changed: true });
    const before = (database.prepare("SELECT total_changes() AS count").get() as { count: number })
      .count;
    const unchanged = claims.record({
      ...base,
      id: "claim-two",
      sourceSequence: 2,
      receivedAt: "2026-09-01T00:00:01.000Z",
    });
    const after = (database.prepare("SELECT total_changes() AS count").get() as { count: number })
      .count;
    expect(unchanged).toMatchObject({ changed: false, claim: { id: "claim-one" } });
    expect(after).toBe(before);
    expect(() =>
      claims.record({ ...base, id: "reordered", sourceSequence: 1, receivedAt: now }),
    ).toThrow(/reordered/);
    expect(() =>
      claims.record({
        ...base,
        id: "wrong-process",
        fence: { ...base.fence, processIncarnationDigest: "f".repeat(64) },
        sourceSequence: 3,
        receivedAt: "2026-09-01T00:00:02.000Z",
      }),
    ).toThrow(/authority fence is not current/);
    expect(
      claims.record({
        ...base,
        id: "claim-dead",
        processState: "dead",
        reasonCode: "process.dead",
        sourceSequence: 3,
        receivedAt: "2026-09-01T00:00:03.000Z",
      }),
    ).toMatchObject({ changed: true });

    const result = arbitrateProviderStatus({
      snapshot: builtIn.resolved,
      fence: base.fence,
      policyDigest: binding.statusPolicyDigest,
      desiredState: "running",
      claims: claims.list("run-one", 1),
      completionRevision: 0,
      now: "2026-09-01T00:00:03.000Z",
    });
    expect(result.status).toMatchObject({ projection: "failed", semanticState: "failed" });
  });
});
