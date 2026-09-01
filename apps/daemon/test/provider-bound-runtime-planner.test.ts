import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedOverlayTransaction } from "../src/generated-overlay-transaction.js";
import { openNanasaDatabase } from "../src/persistence/database.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { ProviderBoundRuntimePlanner } from "../src/providers/provider-bound-runtime-planner.js";
import { ProviderOverlayRepository } from "../src/providers/provider-overlay-repository.js";
import { ProviderReporterDriverRegistry } from "../src/providers/provider-reporter-driver-registry.js";
import { ProviderRunBindingRepository } from "../src/providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotEvaluator } from "../src/providers/provider-snapshot-evaluator.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";

const now = "2026-09-01T00:00:00.000Z";
const directories: string[] = [];
let database: DatabaseSync;

function seedRun(): void {
  database.exec(`
    INSERT INTO groups
      (id,name,order_index,membership_revision,message_sequence,created_at,updated_at)
    VALUES ('group-one','Group',0,0,0,'${now}','${now}');
    INSERT INTO agent_profiles
      (id,name,agent_type,kind,command,args_json,working_directory,environment_json,created_at,updated_at)
    VALUES ('profile-one','Copilot','copilot','copilot','copilot','[]','/repo','{}','${now}','${now}');
    INSERT INTO runs
      (id,group_id,member_id,agent_profile_id,generation,status,desired_state,recovery_phase,
       recovery_attempts,launch_kind,requested_model_source,started_at)
    VALUES ('run-one','group-one','member-one','profile-one',1,'starting','running','idle',
            0,'fresh','integration','${now}');
  `);
}

beforeEach(() => {
  database = openNanasaDatabase(":memory:");
  seedRun();
});

afterEach(() => {
  database.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("snapshot-bound provider runtime planning", () => {
  it("persists binding before overlay effects and recovers the exact launch selection", async () => {
    const builtIn = await buildTrustedBuiltinCopilotPackage();
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    await index.registerTrustedBuiltin(builtIn, now);
    const bindings = new ProviderRunBindingRepository(database, index, snapshots);
    const directory = mkdtempSync(join(tmpdir(), "nanasa-bound-runtime-"));
    directories.push(directory);
    let observedBindingBeforeOverlay = false;
    const transaction = new GeneratedOverlayTransaction(directory, {
      beforeLedgerCommit: () => {
        observedBindingBeforeOverlay =
          (
            database.prepare("SELECT count(*) AS count FROM run_provider_bindings").get() as {
              count: number;
            }
          ).count === 1 &&
          (
            database.prepare("SELECT count(*) AS count FROM provider_overlays").get() as {
              count: number;
            }
          ).count === 0;
      },
    });
    const overlays = new ProviderOverlayRepository(database, transaction);
    const planner = new ProviderBoundRuntimePlanner(bindings, overlays);
    const bound = await planner.bindAndCommit({
      runId: "run-one",
      generation: 1,
      integrationId: "copilot",
      providerId: "copilot",
      providerStateId: "state-one",
      overlayId: "overlay-one",
      credentialSlots: { "github-token": "credential-reference" },
      repositoryTrustDigest: "9".repeat(64),
      membershipId: "membership-one",
      memberAlias: "Reviewer One",
      stateRoot: "/state/copilot",
      statusEndpointUrl: "http://127.0.0.1:3210/status",
      prompt: {
        roleId: "reviewer",
        role: { name: "Reviewer", instructions: [], permissionPolicy: "read-only" },
        text: "SENSITIVE-PROMPT-VALUE\n",
        revision: "a".repeat(64),
        sources: [{ scope: "builtin", reference: "builtin:test" }],
      },
      readOnly: true,
      configuredCommand: ["copilot"],
      model: "provider/model-one",
      modelResumePolicy: "enforce-configured",
      workingDirectory: "/repo",
      createdAt: now,
    });

    expect(observedBindingBeforeOverlay).toBe(true);
    expect(bound.binding.snapshotDigest).toBe(builtIn.snapshot.digest);
    expect(bound.binding.launchPlan.command).toEqual(bound.command);
    expect(bound.binding.launchPlan.environmentNames).toEqual(
      Object.keys(bound.environment).sort(),
    );
    const persisted = database
      .prepare(
        `SELECT binding.launch_plan_json, overlay.ledger_json
         FROM run_provider_bindings AS binding
         JOIN provider_overlays AS overlay ON overlay.binding_id = binding.id`,
      )
      .get() as { launch_plan_json: string; ledger_json: string };
    expect(persisted.launch_plan_json).not.toContain("SENSITIVE-PROMPT-VALUE");
    expect(persisted.ledger_json).not.toContain("SENSITIVE-PROMPT-VALUE");

    database
      .prepare("UPDATE provider_activations SET state = 'superseded' WHERE id = ?")
      .run(bound.binding.activationId);
    index.refresh();
    expect(() => index.get("copilot")).toThrow(/not active/);
    const recovered = await planner.recover("run-one", 1);
    expect(recovered.launchPlan).toEqual(bound.binding.launchPlan);
    expect(recovered.overlay.root).toBe(bound.overlay.root);

    const evaluator = new ProviderSnapshotEvaluator(
      recovered.recoveredBinding.snapshot,
      ProviderReporterDriverRegistry.fromSnapshot(recovered.recoveredBinding.snapshot),
    );
    const nativeSession = evaluator.normalizeNativeSession({
      source: "copilot",
      referenceKind: "id",
      referenceValue: "session-one",
    });
    expect(planner.resumeCommand(recovered, nativeSession)).toEqual([
      "copilot",
      ...bound.binding.launchPlan.overlayArguments,
      "--resume=session-one",
      "--model",
      "provider/model-one",
    ]);
  });
});
