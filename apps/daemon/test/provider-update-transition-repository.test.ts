import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRun, ProviderUpdatePlan } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderUpdateTransitionRepository } from "../src/providers/provider-update-transition-repository.js";
import { NanasaStore } from "../src/store.js";

const directories: string[] = [];
const digest = (character: string): string => character.repeat(64);
const detectedAt = "2026-09-02T10:00:00.000Z";
const completedAt = "2026-09-02T10:00:01.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createRun(store: NanasaStore): AgentRun {
  const group = store.createGroup({ name: "Provider updates" });
  const profile = store.createInternalAgentProfile({
    name: "Engineer",
    agentType: "copilot",
    kind: "copilot",
    command: "copilot",
    args: [],
    environment: {},
  });
  const membership = store.addMembership(group.id, {
    memberId: "engineer-one",
    agentProfileId: profile.id,
    alias: "Engineer 1",
  });
  return store.createRun({
    id: "run-old",
    groupId: group.id,
    memberId: membership.memberId,
    agentProfileId: profile.id,
    generation: 1,
    status: "running",
    startedAt: "2026-09-02T09:00:00.000Z",
  });
}

function seedProviderAuthority(database: DatabaseSync, run: AgentRun): void {
  database
    .prepare(
      `INSERT INTO provider_packages
        (extension_generation,extension_id,version,package_digest,manifest_digest,publisher_id,
         namespace_claims_json,source_json,signatures_json,manifest_json,state,
         anti_rollback_sequence,imported_at,verified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      "nanasa.copilot@1.0.0+builtin.test",
      "nanasa.copilot",
      "1.0.0",
      digest("a"),
      digest("b"),
      "nanasa",
      '["copilot"]',
      '{"kind":"builtin","buildDigest":"test"}',
      "[]",
      '{"apiVersion":"nanasa.dev/provider-extension/v2"}',
      "resolved",
      1,
      detectedAt,
      detectedAt,
    );
  const insertSnapshot = database.prepare(
    `INSERT INTO provider_snapshots
      (digest,extension_generation,provider_id,adapter_id,canonical_bytes,
       manifest_protocol_json,adapter_protocol_json,interpreter_versions_json,
       capabilities_json,grants_json,assets_json,compatibility_json,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const snapshotDigest of [digest("c"), digest("d"), digest("e")]) {
    insertSnapshot.run(
      snapshotDigest,
      "nanasa.copilot@1.0.0+builtin.test",
      "copilot",
      "copilot-v1",
      Buffer.from("{}"),
      '{"major":2,"minor":0}',
      '{"major":2,"minor":0}',
      '{"core":"2.0"}',
      "[]",
      "[]",
      "[]",
      '{"state":"compatible"}',
      detectedAt,
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
      "activation-old",
      1,
      "copilot",
      "nanasa.copilot@1.0.0+builtin.test",
      digest("c"),
      digest("1"),
      digest("2"),
      "superseded",
      detectedAt,
      detectedAt,
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
      "binding-old",
      run.id,
      run.generation,
      "copilot",
      "copilot",
      "copilot-v1",
      digest("c"),
      "activation-old",
      digest("3"),
      digest("4"),
      "state-old",
      "overlay-old",
      "{}",
      '{"command":["copilot"]}',
      digest("5"),
      digest("6"),
      digest("7"),
      '{"state":"compatible"}',
      detectedAt,
    );
}

function updatePlan(currentSnapshotDigest = digest("d")): ProviderUpdatePlan {
  return {
    runId: "run-old",
    generation: 1,
    memberId: "engineer-one",
    providerId: "copilot",
    previousSnapshotDigest: digest("c"),
    currentSnapshotDigest,
    status: "outdated",
  };
}

describe("ProviderUpdateTransitionRepository", () => {
  it("fences the same digest pair across reopen and projects its replacement", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-provider-update-"));
    directories.push(directory);
    const path = join(directory, "nanasa.sqlite");
    let store = new NanasaStore(path);
    const oldRun = createRun(store);
    seedProviderAuthority(store.database, oldRun);
    let repository = new ProviderUpdateTransitionRepository(store.database);

    const first = repository.begin(updatePlan(), detectedAt);
    expect(first).toMatchObject({ created: true, transition: { state: "pending" } });
    expect(repository.begin(updatePlan(), completedAt)).toEqual({
      created: false,
      transition: first.transition,
    });
    store.close();

    store = new NanasaStore(path);
    repository = new ProviderUpdateTransitionRepository(store.database);
    expect(repository.begin(updatePlan(), completedAt)).toEqual({
      created: false,
      transition: first.transition,
    });
    repository.markInProgress(first.transition.id, "2026-09-02T10:00:00.500Z");
    const replacement = store.createRun({
      id: "run-replacement",
      groupId: oldRun.groupId,
      memberId: oldRun.memberId,
      agentProfileId: oldRun.agentProfileId,
      generation: 2,
      status: "starting",
      launchKind: "restarted",
      startedAt: completedAt,
    });
    const fenced = repository.recordReplacement(
      first.transition.id,
      replacement.id,
      "2026-09-02T10:00:00.750Z",
    );
    expect(fenced).toMatchObject({ state: "in-progress", replacementRunId: replacement.id });
    store.close();

    store = new NanasaStore(path);
    repository = new ProviderUpdateTransitionRepository(store.database);
    expect(repository.begin(updatePlan(), completedAt)).toMatchObject({
      created: false,
      transition: { state: "in-progress", replacementRunId: replacement.id },
    });
    expect(repository.recordReplacement(first.transition.id, replacement.id)).toEqual(fenced);
    const completed = repository.complete(first.transition.id, {
      outcome: "restarted",
      completedAt,
    });

    expect(completed).toMatchObject({
      state: "completed",
      outcome: "restarted",
      replacementRunId: replacement.id,
    });
    expect(store.getRun(oldRun.id).providerUpdate).toEqual(completed);
    expect(store.getRun(replacement.id).providerUpdate).toEqual(completed);
    expect(store.getAgentStatus(oldRun.groupId, oldRun.memberId).providerUpdate).toEqual(completed);
    expect(repository.listForRun(oldRun.id, oldRun.generation)).toEqual([completed]);
    expect(
      repository.complete(first.transition.id, {
        outcome: "restarted",
        replacementRunId: replacement.id,
      }),
    ).toEqual(completed);
    expect(() =>
      repository.complete(first.transition.id, {
        outcome: "restarted",
        replacementRunId: oldRun.id,
      }),
    ).toThrow(/different result/);
    store.close();
  });

  it("retains distinct update history and bounded safe failures", () => {
    const store = new NanasaStore(":memory:");
    const oldRun = createRun(store);
    seedProviderAuthority(store.database, oldRun);
    const repository = new ProviderUpdateTransitionRepository(store.database);
    repository.begin(updatePlan(), detectedAt);
    const next = repository.begin(updatePlan(digest("e")), completedAt);
    const failed = repository.complete(next.transition.id, {
      outcome: "failed",
      safeError: {
        code: "provider_update_launch_failed",
        message: "The replacement launch failed",
        retryable: true,
      },
      completedAt: "2026-09-02T10:00:02.000Z",
    });

    expect(repository.listForRun(oldRun.id, oldRun.generation)).toHaveLength(2);
    expect(failed.safeError).toEqual({
      code: "provider_update_launch_failed",
      message: "The replacement launch failed",
      retryable: true,
    });
    expect(() =>
      repository.complete(failed.id, {
        outcome: "failed",
        safeError: { code: "invalid", message: "x".repeat(1_001), retryable: false },
      }),
    ).toThrow();
    store.close();
  });
});
