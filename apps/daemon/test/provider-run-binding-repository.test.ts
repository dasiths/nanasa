import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedOverlayTransaction } from "../src/generated-overlay-transaction.js";
import { openNanasaDatabase } from "../src/persistence/database.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { ProviderOverlayRepository } from "../src/providers/provider-overlay-repository.js";
import { ProviderRunBindingRepository } from "../src/providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotEvaluator } from "../src/providers/provider-snapshot-evaluator.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";

const now = "2026-09-01T00:00:00.000Z";
const digest = (character: string): string => character.repeat(64);
const launchPlan = {
  configuredCommand: ["copilot"],
  command: ["copilot"],
  overlayArguments: [],
  environmentNames: [],
  stateStorageReference: "/state/copilot",
  modelResumePolicy: "preserve-session",
} as const;

let database: DatabaseSync;
const directories: string[] = [];

function seedRun(): void {
  database
    .prepare(
      `INSERT INTO groups
        (id,name,order_index,membership_revision,message_sequence,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run("group-one", "Group", 0, 0, 0, now, now);
  database
    .prepare(
      `INSERT INTO agent_profiles
        (id,name,agent_type,kind,command,args_json,working_directory,environment_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run("profile-one", "Copilot", "copilot", "copilot", "copilot", "[]", null, "{}", now, now);
  database
    .prepare(
      `INSERT INTO runs
        (id,group_id,member_id,agent_profile_id,generation,status,desired_state,recovery_phase,
         recovery_attempts,launch_kind,requested_model_source,started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      "run-one",
      "group-one",
      "member-one",
      "profile-one",
      1,
      "starting",
      "running",
      "idle",
      0,
      "fresh",
      "provider-default",
      now,
    );
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

describe("run provider binding repository", () => {
  it("persists one exact snapshot-derived binding and rejects a changed retry", async () => {
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    const builtIn = await buildTrustedBuiltinCopilotPackage();
    await index.registerTrustedBuiltin(builtIn, now);
    const bindings = new ProviderRunBindingRepository(database, index, snapshots);
    const input = {
      runId: "run-one",
      generation: 1,
      integrationId: "copilot",
      providerId: "copilot",
      snapshotDigest: builtIn.snapshot.digest,
      providerStateId: "state-one",
      overlayId: "overlay-one",
      credentialSlots: { "github-token": "credential-profile-one" },
      launchPlan,
      launchDigest: digest("1"),
      permissionFloorDigest: digest("2"),
      repositoryTrustDigest: digest("3"),
      createdAt: now,
    } as const;

    const created = await bindings.create(input);
    expect(created).toMatchObject({
      runId: "run-one",
      generation: 1,
      providerId: "copilot",
      adapterId: "nanasa.copilot-v2",
      snapshotDigest: builtIn.snapshot.digest,
      providerBinary: builtIn.snapshot.body.providerBinaryCompatibility,
    });
    expect(created.processRecognitionDigest).toHaveLength(64);
    expect(created.statusPolicyDigest).toHaveLength(64);
    expect(await bindings.create(input)).toEqual(created);
    await expect(bindings.create({ ...input, overlayId: "overlay-two" })).rejects.toThrow(
      /does not match immutable persisted selection/,
    );
    expect(database.prepare("SELECT count(*) AS count FROM run_provider_bindings").get()).toEqual({
      count: 1,
    });
  });

  it("recovers from the pinned snapshot after current activation is superseded", async () => {
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    const builtIn = await buildTrustedBuiltinCopilotPackage();
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
      launchPlan,
      launchDigest: digest("4"),
      permissionFloorDigest: digest("5"),
      repositoryTrustDigest: digest("6"),
      createdAt: now,
    });

    database
      .prepare("UPDATE provider_activations SET state = 'superseded' WHERE id = ?")
      .run(binding.activationId);
    index.refresh();
    expect(() => index.get("copilot")).toThrow(/not active/);

    const recovered = await bindings.requireForRecovery("run-one", 1);
    expect(recovered.binding).toEqual(binding);
    expect(recovered.snapshot).toMatchObject(builtIn.snapshot);
    expect(
      recovered.snapshot.assets
        .list()
        .toSorted((left, right) => left.digest.localeCompare(right.digest)),
    ).toEqual(
      builtIn.resolved.assets
        .list()
        .toSorted((left, right) => left.digest.localeCompare(right.digest)),
    );
    await expect(bindings.requireForRecovery("missing-run", 1)).rejects.toThrow(
      /binding is unavailable/,
    );
    database
      .prepare("UPDATE provider_activations SET state = 'revoked' WHERE id = ?")
      .run(binding.activationId);
    await expect(bindings.requireForRecovery("run-one", 1)).rejects.toThrow(/authority is revoked/);
  });

  it("commits after binding and recovers only an exact drift-free overlay", async () => {
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    const builtIn = await buildTrustedBuiltinCopilotPackage();
    await index.registerTrustedBuiltin(builtIn, now);
    const bindings = new ProviderRunBindingRepository(database, index, snapshots);
    const directory = mkdtempSync(join(tmpdir(), "nanasa-pinned-overlay-"));
    directories.push(directory);
    const transaction = new GeneratedOverlayTransaction(directory);
    const overlayId = "overlay-one";
    const revision = 1;
    const overlayRoot = transaction.overlayRoot(overlayId, revision);
    const evaluator = new ProviderSnapshotEvaluator(builtIn.resolved, builtIn.reporterDrivers);
    const plan = evaluator.planOverlay({
      membershipId: "membership-one",
      memberAlias: "Reviewer One",
      stateRoot: "/state/copilot",
      overlayRoot,
      statusEndpointUrl: "http://127.0.0.1:3210/status",
      prompt: {
        roleId: "reviewer",
        role: { name: "Reviewer", instructions: [], permissionPolicy: "read-only" },
        text: "SENSITIVE-PROMPT-MUST-NOT-ENTER-SQLITE\n",
        revision: digest("a"),
        sources: [{ scope: "builtin", reference: "builtin:test" }],
      },
      readOnly: true,
    });
    const binding = await bindings.create({
      runId: "run-one",
      generation: 1,
      integrationId: "copilot",
      providerId: "copilot",
      snapshotDigest: builtIn.snapshot.digest,
      providerStateId: "state-one",
      overlayId,
      credentialSlots: { "github-token": "credential-reference-only" },
      launchPlan,
      launchDigest: digest("7"),
      permissionFloorDigest: digest("8"),
      repositoryTrustDigest: digest("9"),
      createdAt: now,
    });
    expect(database.prepare("SELECT count(*) AS count FROM provider_overlays").get()).toEqual({
      count: 0,
    });

    const overlays = new ProviderOverlayRepository(database, transaction);
    const committed = overlays.commit({
      binding,
      snapshot: builtIn.resolved,
      adapterVersion: "2.0.0",
      files: plan.files,
      revision,
    });
    expect(committed.root).toBe(overlayRoot);
    expect(database.prepare("SELECT count(*) AS count FROM provider_overlays").get()).toEqual({
      count: 1,
    });
    const persisted = database
      .prepare("SELECT ledger_json FROM provider_overlays WHERE id = ?")
      .get(overlayId) as { ledger_json: string };
    expect(persisted.ledger_json).not.toContain("SENSITIVE-PROMPT-MUST-NOT-ENTER-SQLITE");
    expect(persisted.ledger_json).not.toContain("credential-reference-only");

    database
      .prepare("UPDATE provider_activations SET state = 'superseded' WHERE id = ?")
      .run(binding.activationId);
    index.refresh();
    const recoveredBinding = await bindings.requireForRecovery("run-one", 1);
    expect(overlays.requireForRecovery(recoveredBinding)).toEqual(committed);

    writeFileSync(join(committed.root, committed.ledger.entries[0]!.relativePath), "tampered");
    expect(() => overlays.requireForRecovery(recoveredBinding)).toThrow(/drift detected/);
  });
});
