import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNanasaDatabase } from "../src/persistence/database.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import {
  ProviderOperationAuditRepository,
  ProviderOperationSelector,
} from "../src/providers/provider-operation-service.js";
import { ProviderProcessIncarnationRepository } from "../src/providers/provider-process-incarnation-repository.js";
import { ProviderRunBindingRepository } from "../src/providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";

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

describe("provider operation selection and auditing", () => {
  it("selects exact transports and journals only process-fenced digests", async () => {
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
    const incarnations = new ProviderProcessIncarnationRepository(database);
    const process = incarnations.record(
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
    const selector = new ProviderOperationSelector(builtIn.resolved);
    const waitReply = selector.select("wait-reply", "terminal");
    expect(waitReply).toMatchObject({
      operationId: "terminal.wait-reply",
      transport: "terminal",
      acknowledgement: "reporter",
    });
    expect(() => selector.select("wait-reply", "hook")).toThrow(/exact transport/);

    const audits = new ProviderOperationAuditRepository(database);
    const request = {
      binding,
      processIncarnationDigest: process.digest,
      operation: waitReply,
      idempotencyKey: "reply-wait-one",
      targetHandles: ["wait-one"],
      input: { reply: "SENSITIVE-REPLY-VALUE" },
      startedAt: now,
    } as const;
    const started = audits.begin(request);
    expect(started).toMatchObject({
      operationId: "terminal.wait-reply",
      state: "started",
      processIncarnationDigest: process.digest,
      targetHandles: ["wait-one"],
    });
    expect(audits.begin(request)).toEqual(started);
    expect(database.prepare("SELECT input_digest FROM provider_operation_audits").get()).toEqual({
      input_digest: started.inputDigest,
    });
    expect(
      JSON.stringify(database.prepare("SELECT * FROM provider_operation_audits").get()),
    ).not.toContain("SENSITIVE-REPLY-VALUE");
    expect(() => audits.begin({ ...request, input: { reply: "different" } })).toThrow(
      /does not match the original request/,
    );

    const completed = audits.complete(started.id, "succeeded", {
      output: { accepted: true },
      completedAt: "2026-09-01T00:00:01.000Z",
    });
    expect(completed).toMatchObject({
      state: "succeeded",
      completedAt: "2026-09-01T00:00:01.000Z",
    });
    expect(
      audits.complete(started.id, "succeeded", {
        output: { accepted: true },
        completedAt: "2026-09-01T00:00:01.000Z",
      }),
    ).toEqual(completed);
    expect(() => audits.complete(started.id, "failed")).toThrow(/different outcome/);
  });
});
