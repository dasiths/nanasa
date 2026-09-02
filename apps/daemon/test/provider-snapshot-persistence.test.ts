import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openNanasaDatabase } from "../src/persistence/database.js";

const directories: string[] = [];
const digest = (character: string): string => character.repeat(64);
const now = "2026-09-01T00:00:00.000Z";
const launchPlanJson = JSON.stringify({
  configuredCommand: ["agent"],
  command: ["agent"],
  overlayArguments: [],
  environmentNames: [],
  stateStorageReference: "/state/agent",
  modelResumePolicy: "preserve-session",
});

function fixture(): { path: string; database: DatabaseSync } {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-provider-persistence-"));
  directories.push(directory);
  const path = join(directory, "nanasa.sqlite");
  return { path, database: openNanasaDatabase(path) };
}

function seedTargetGraph(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO groups
          (id,name,order_index,membership_revision,message_sequence,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run("group_1", "Group", 0, 0, 0, now, now);
    database
      .prepare(
        `INSERT INTO agent_profiles
          (id,name,agent_type,kind,command,args_json,working_directory,environment_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run("profile_1", "Agent", "copilot", "copilot", "copilot", "[]", null, "{}", now, now);
    database
      .prepare(
        `INSERT INTO runs
          (id,group_id,member_id,agent_profile_id,generation,status,desired_state,recovery_phase,
           recovery_attempts,launch_kind,requested_model_source,started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "run_1",
        "group_1",
        "member_1",
        "profile_1",
        1,
        "running",
        "running",
        "recovered",
        0,
        "fresh",
        "provider-default",
        now,
      );
    database
      .prepare(
        `INSERT INTO provider_packages
          (extension_generation,extension_id,version,package_digest,manifest_digest,publisher_id,
           namespace_claims_json,source_json,signatures_json,manifest_json,state,
           anti_rollback_sequence,imported_at,verified_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "acme.agent-adapter@1.0.0+a",
        "acme.agent-adapter",
        "1.0.0",
        digest("a"),
        digest("b"),
        "acme",
        '["acme.agent"]',
        '{"kind":"upload"}',
        "[]",
        '{"apiVersion":"nanasa.dev/provider-extension/v2"}',
        "resolved",
        1,
        now,
        now,
      );
    const insertSnapshot = database.prepare(
      `INSERT INTO provider_snapshots
        (digest,extension_generation,provider_id,adapter_id,canonical_bytes,
         manifest_protocol_json,adapter_protocol_json,interpreter_versions_json,
         capabilities_json,grants_json,assets_json,compatibility_json,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const snapshotDigest of [digest("c"), digest("d")]) {
      insertSnapshot.run(
        snapshotDigest,
        "acme.agent-adapter@1.0.0+a",
        "acme.agent",
        "acme.agent-v1",
        Buffer.from("{}"),
        '{"major":2,"minor":0}',
        '{"major":2,"minor":0}',
        '{"core":"2.0"}',
        "[]",
        "[]",
        "[]",
        '{"state":"compatible"}',
        now,
      );
    }
    database
      .prepare(
        `INSERT INTO provider_activations
          (id,index_generation,provider_id,extension_generation,snapshot_digest,grants_digest,
           trust_digest,state,created_at,activated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "activation_1",
        1,
        "acme.agent",
        "acme.agent-adapter@1.0.0+a",
        digest("c"),
        digest("e"),
        digest("f"),
        "active",
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO run_provider_bindings
          (id,run_id,generation,integration_id,provider_id,adapter_id,snapshot_digest,
           activation_id,process_recognition_digest,status_policy_digest,provider_state_id,
           overlay_id,credential_slots_json,launch_plan_json,launch_digest,permission_floor_digest,
           repository_trust_digest,provider_binary_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "binding_1",
        "run_1",
        1,
        "reviewer",
        "acme.agent",
        "acme.agent-v1",
        digest("c"),
        "activation_1",
        digest("1"),
        digest("2"),
        "state_1",
        "overlay_1",
        "{}",
        launchPlanJson,
        digest("3"),
        digest("4"),
        digest("5"),
        '{"state":"compatible"}',
        now,
      );
    database
      .prepare(
        `INSERT INTO provider_process_incarnations
          (digest,binding_id,run_id,generation,snapshot_digest,pane_id,foreground_pgid,
           leader_pid,pid_start_identity,observed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(digest("6"), "binding_1", "run_1", 1, digest("c"), "%1", 100, 101, "start-1", now);
    database
      .prepare(
        `INSERT INTO provider_authority_fences
          (record_type,record_id,binding_id,run_id,generation,snapshot_digest,
           process_incarnation_digest,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        "reporter-session",
        "reporter_1",
        "binding_1",
        "run_1",
        1,
        digest("c"),
        digest("6"),
        now,
      );
    database
      .prepare(
        `INSERT INTO status_source_claims
          (id,binding_id,run_id,generation,snapshot_digest,process_incarnation_digest,
           status_policy_digest,source,source_id,claim_type,value_json,confidence,reason_code,
           source_sequence,received_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "claim_1",
        "binding_1",
        "run_1",
        1,
        digest("c"),
        digest("6"),
        digest("2"),
        "process",
        "process-observer",
        "process-liveness",
        '{"state":"present"}',
        "high",
        "process.present",
        1,
        now,
      );
    database
      .prepare(
        `INSERT INTO reporter_turn_cycles
          (id,binding_id,run_id,generation,snapshot_digest,process_incarnation_digest,
           reporter_session_id,root_session_id,turn_id,state,open_tool_count,open_wait_count,
           completion_revision,opened_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "cycle_1",
        "binding_1",
        "run_1",
        1,
        digest("c"),
        digest("6"),
        "reporter_1",
        "root_1",
        "turn_1",
        "open",
        0,
        0,
        0,
        now,
      );
    database
      .prepare(
        `INSERT INTO provider_operation_audits
          (id,operation_id,idempotency_key,snapshot_digest,binding_id,run_id,generation,
           process_incarnation_digest,target_handles_json,state,input_digest,started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "audit_1",
        "wait/reply",
        "reply-1",
        digest("c"),
        "binding_1",
        "run_1",
        1,
        digest("6"),
        '["wait_1"]',
        "started",
        digest("7"),
        now,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("immutable provider snapshot persistence", () => {
  it("persists the complete inert target graph and reopens idempotently", () => {
    const { path, database } = fixture();
    seedTargetGraph(database);
    expect(
      database
        .prepare(
          `SELECT
             (SELECT count(*) FROM provider_packages) AS packages,
             (SELECT count(*) FROM provider_snapshots) AS snapshots,
             (SELECT count(*) FROM provider_activations) AS activations,
             (SELECT count(*) FROM run_provider_bindings) AS bindings,
             (SELECT count(*) FROM provider_operation_audits) AS audits,
             (SELECT count(*) FROM status_source_claims) AS claims,
             (SELECT count(*) FROM reporter_turn_cycles) AS cycles`,
        )
        .get(),
    ).toEqual({
      packages: 1,
      snapshots: 2,
      activations: 1,
      bindings: 1,
      audits: 1,
      claims: 1,
      cycles: 1,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
    openNanasaDatabase(path).close();
    openNanasaDatabase(path).close();
  });

  it("makes snapshots and run bindings append-only", () => {
    const { database } = fixture();
    seedTargetGraph(database);
    expect(() =>
      database
        .prepare("UPDATE provider_snapshots SET adapter_id = ? WHERE digest = ?")
        .run("other-adapter", digest("c")),
    ).toThrow(/provider snapshots are immutable/);
    expect(() =>
      database
        .prepare("UPDATE run_provider_bindings SET provider_id = ? WHERE id = ?")
        .run("other.provider", "binding_1"),
    ).toThrow(/run provider bindings are immutable/);
    database.close();
  });

  it("rejects cross-snapshot and cross-process dependent authority", () => {
    const { database } = fixture();
    seedTargetGraph(database);
    database
      .prepare(
        `INSERT INTO runs
          (id,group_id,member_id,agent_profile_id,generation,status,desired_state,recovery_phase,
           recovery_attempts,launch_kind,requested_model_source,started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "run_2",
        "group_1",
        "member_2",
        "profile_1",
        1,
        "starting",
        "running",
        "idle",
        0,
        "fresh",
        "provider-default",
        now,
      );
    expect(() =>
      database
        .prepare(
          `INSERT INTO run_provider_bindings
            (id,run_id,generation,integration_id,provider_id,adapter_id,snapshot_digest,
             activation_id,process_recognition_digest,status_policy_digest,provider_state_id,
             overlay_id,credential_slots_json,launch_plan_json,launch_digest,permission_floor_digest,
             repository_trust_digest,provider_binary_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "binding_wrong_activation",
          "run_2",
          1,
          "reviewer",
          "acme.agent",
          "acme.agent-v1",
          digest("d"),
          "activation_1",
          digest("1"),
          digest("2"),
          "state_2",
          "overlay_2",
          "{}",
          launchPlanJson,
          digest("3"),
          digest("4"),
          digest("5"),
          '{"state":"compatible"}',
          now,
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      database
        .prepare(
          `INSERT INTO status_source_claims
            (id,binding_id,run_id,generation,snapshot_digest,process_incarnation_digest,
             status_policy_digest,source,source_id,claim_type,value_json,confidence,reason_code,
             source_sequence,received_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "claim_wrong_snapshot",
          "binding_1",
          "run_1",
          1,
          digest("d"),
          digest("6"),
          digest("2"),
          "process",
          "process-observer-2",
          "process-liveness",
          '{"state":"present"}',
          "high",
          "process.present",
          1,
          now,
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      database
        .prepare(
          `INSERT INTO provider_authority_fences
            (record_type,record_id,binding_id,run_id,generation,snapshot_digest,
             process_incarnation_digest,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          "action",
          "action_wrong_process",
          "binding_1",
          "run_1",
          1,
          digest("c"),
          digest("9"),
          now,
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);
    database.close();
  });
});
