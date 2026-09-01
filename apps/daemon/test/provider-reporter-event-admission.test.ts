import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNanasaDatabase } from "../src/persistence/database.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { ProviderProcessIncarnationRepository } from "../src/providers/provider-process-incarnation-repository.js";
import { ProviderReporterEventAdmission } from "../src/providers/provider-reporter-event-admission.js";
import { ProviderRunBindingRepository } from "../src/providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";
import { ProviderTurnCycleRepository } from "../src/providers/provider-turn-cycle-repository.js";

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

describe("snapshot-bound reporter event admission", () => {
  it("accepts exact events idempotently and rejects stale or mismatched authority", async () => {
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
    database
      .prepare(
        `INSERT INTO provider_authority_fences
          (record_type,record_id,binding_id,run_id,generation,snapshot_digest,
           process_incarnation_digest,created_at)
         VALUES ('reporter-session',?,?,?,?,?,?,?)`,
      )
      .run(
        "reporter-session-one",
        binding.id,
        binding.runId,
        binding.generation,
        binding.snapshotDigest,
        process.digest,
        now,
      );
    database
      .prepare(
        `INSERT INTO provider_reporter_sessions
          (id,binding_id,run_id,generation,snapshot_digest,process_incarnation_digest,
           reporter_id,source_id,reporter_epoch,root_session_id,state,opened_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'active',?)`,
      )
      .run(
        "reporter-session-one",
        binding.id,
        binding.runId,
        binding.generation,
        binding.snapshotDigest,
        process.digest,
        "copilot-hooks",
        "copilot",
        "epoch-one",
        "root-one",
        now,
      );
    const event = {
      version: 3 as const,
      eventId: "event-one",
      integrationId: "copilot",
      providerId: "copilot",
      adapterId: "nanasa.copilot-v2",
      snapshotDigest: builtIn.snapshot.digest,
      processIncarnationDigest: process.digest,
      reporterSessionId: "reporter-session-one",
      reporterId: "copilot-hooks",
      source: "copilot",
      reporterEpoch: "epoch-one",
      runId: "run-one",
      generation: 1,
      sourceSequence: 1,
      event: "session.ready" as const,
      occurredAt: now,
      data: {},
    };
    const admission = new ProviderReporterEventAdmission(database);
    expect(admission.admit(binding, builtIn.resolved, event, now)).toMatchObject({
      duplicate: false,
    });
    expect(admission.admit(binding, builtIn.resolved, event, now)).toMatchObject({
      duplicate: true,
    });
    expect(
      database.prepare("SELECT count(*) AS count FROM provider_reporter_event_receipts").get(),
    ).toEqual({ count: 1 });
    expect(() =>
      admission.admit(binding, builtIn.resolved, { ...event, event: "turn.started" }, now),
    ).toThrow(/reused with a different payload/);
    expect(() =>
      admission.admit(
        binding,
        builtIn.resolved,
        { ...event, eventId: "undeclared", event: "reporter.ready", sourceSequence: 2 },
        now,
      ),
    ).toThrow(/not admitted/);
    expect(() =>
      admission.admit(
        binding,
        builtIn.resolved,
        { ...event, eventId: "reordered", sourceSequence: 1 },
        now,
      ),
    ).toThrow(/reordered/);
    expect(() =>
      admission.admit(
        binding,
        builtIn.resolved,
        {
          ...event,
          eventId: "wrong-process",
          sourceSequence: 2,
          processIncarnationDigest: "f".repeat(64),
        },
        now,
      ),
    ).toThrow(/not authoritative/);
    expect(() =>
      admission.admit(
        binding,
        builtIn.resolved,
        { ...event, eventId: "wrong-epoch", reporterEpoch: "epoch-two", sourceSequence: 2 },
        now,
      ),
    ).toThrow(/identity or epoch is not active/);
    expect(() =>
      admission.admit(
        binding,
        builtIn.resolved,
        {
          ...event,
          eventId: "wrong-root",
          event: "turn.started",
          sourceSequence: 2,
          rootSessionId: "root-two",
          turnId: "turn-one",
        },
        now,
      ),
    ).toThrow(/root session does not match/);

    const cycles = new ProviderTurnCycleRepository(database);
    const turnEvent = (input: {
      eventId: string;
      sourceSequence: number;
      event:
        | "turn.started"
        | "turn.settled"
        | "tool.started"
        | "tool.finished"
        | "wait.opened"
        | "wait.closed"
        | "session.ended";
      operationId?: string;
      requestId?: string;
      data?: Record<string, unknown>;
      turnId?: string;
    }) => ({
      ...event,
      ...input,
      rootSessionId: "root-one",
      turnId: input.turnId ?? "turn-one",
      data: input.data ?? {},
    });
    const apply = (input: Parameters<typeof turnEvent>[0]) =>
      cycles.apply(binding, admission.admit(binding, builtIn.resolved, turnEvent(input), now));
    expect(
      apply({ eventId: "turn-start", sourceSequence: 2, event: "turn.started" }),
    ).toMatchObject({
      state: "open",
      completionRevision: 0,
    });
    apply({
      eventId: "tool-start",
      sourceSequence: 3,
      event: "tool.started",
      operationId: "tool-one",
    });
    expect(
      apply({
        eventId: "wait-open",
        sourceSequence: 4,
        event: "wait.opened",
        requestId: "wait-one",
        data: {
          waitKind: "permission",
          summary: "Permission required",
          transportId: "terminal",
        },
      }),
    ).toMatchObject({ state: "waiting", openToolCount: 1, openWaitCount: 1 });
    expect(
      apply({ eventId: "turn-settled", sourceSequence: 5, event: "turn.settled" }),
    ).toMatchObject({ state: "settling", completionRevision: 0 });
    const wrongWaitClose = turnEvent({
      eventId: "wrong-wait-close",
      sourceSequence: 6,
      event: "wait.closed",
      requestId: "other-wait",
    });
    const wrongAdmission = admission.admit(binding, builtIn.resolved, wrongWaitClose, now);
    expect(() => cycles.apply(binding, wrongAdmission)).toThrow(/does not match an open wait/);
    apply({
      eventId: "wait-close",
      sourceSequence: 7,
      event: "wait.closed",
      requestId: "wait-one",
    });
    const finishedEvent = turnEvent({
      eventId: "tool-finish",
      sourceSequence: 8,
      event: "tool.finished",
      operationId: "tool-one",
    });
    const finishedAdmission = admission.admit(binding, builtIn.resolved, finishedEvent, now);
    const completed = cycles.apply(binding, finishedAdmission);
    expect(completed).toMatchObject({
      state: "closed",
      openToolCount: 0,
      openWaitCount: 0,
      completionRevision: 1,
    });
    expect(
      cycles.apply(binding, admission.admit(binding, builtIn.resolved, finishedEvent, now)),
    ).toEqual(completed);
    const second = apply({
      eventId: "second-turn",
      sourceSequence: 9,
      event: "turn.started",
      turnId: "turn-two",
    });
    expect(second).toMatchObject({ state: "open", completionRevision: 1 });
    apply({
      eventId: "session-end",
      sourceSequence: 10,
      event: "session.ended",
      turnId: "turn-two",
    });
    expect(cycles.get(second!.id)).toMatchObject({ state: "abandoned", completionRevision: 1 });

    database
      .prepare("UPDATE provider_reporter_sessions SET root_session_id = NULL WHERE id = ?")
      .run("reporter-session-one");
    const qualifiedSnapshot = {
      ...builtIn.resolved,
      body: {
        ...builtIn.resolved.body,
        capabilities: builtIn.resolved.body.capabilities.map((capability) =>
          capability.id === "reporter"
            ? {
                ...capability,
                payload: { ...capability.payload, rootSessionPolicy: "qualified-root" },
              }
            : capability,
        ),
      },
    } as typeof builtIn.resolved;
    expect(() =>
      admission.admit(
        binding,
        qualifiedSnapshot,
        {
          ...event,
          eventId: "null-qualified-root",
          event: "turn.started",
          sourceSequence: 11,
          rootSessionId: "root-one",
          turnId: "turn-three",
        },
        now,
      ),
    ).toThrow(/no admitted root identity/);
  });
});
