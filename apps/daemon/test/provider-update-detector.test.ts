import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalProviderSnapshotBytes,
  digestProviderSnapshot,
  ProviderPackageManifestSchema,
  ProviderPackageRecordSchema,
  ResolvedProviderAdapterSnapshotSchema,
} from "@nanasa/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNanasaDatabase } from "../src/persistence/database.js";
import {
  buildTrustedBuiltinCopilotPackage,
  type TrustedBuiltInProviderPackage,
} from "../src/providers/builtin-provider-packages.js";
import {
  HOST_PROVIDER_CAPABILITIES,
  negotiateProviderPackage,
} from "../src/providers/provider-capability-negotiator.js";
import { ProviderRunBindingRepository } from "../src/providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";
import {
  ProviderUpdateDetector,
  planProviderUpdate,
} from "../src/providers/provider-update-detector.js";
import { resolveProviderAdapter } from "../src/providers/resolved-provider-adapter.js";

const digest = (character: string): string => character.repeat(64);
const now = "2026-09-01T00:00:00.000Z";
const launchPlan = {
  configuredCommand: ["copilot"],
  command: ["copilot"],
  overlayArguments: [],
  environmentNames: [],
  stateStorageReference: "/state/copilot",
  modelResumePolicy: "preserve-session",
} as const;

let database: DatabaseSync;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

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

async function withChangedBuiltinContent(
  original: TrustedBuiltInProviderPackage,
): Promise<TrustedBuiltInProviderPackage> {
  const capabilities = original.packageRecord.manifest.capabilities.map((capability) =>
    capability.id === "health"
      ? {
          ...capability,
          payload: {
            ...(capability.payload as Record<string, unknown>),
            binaryNames: ["copilot", "copilot.exe", "copilot-next"],
          },
        }
      : capability,
  );
  const requestedGrants = original.packageRecord.manifest.requestedGrants;
  const assets = original.packageRecord.manifest.assets;
  const packageDigest = sha256(
    canonicalJsonBytes({ providerId: "copilot", capabilities, requestedGrants, assets }),
  );
  const extensionGeneration = `nanasa.copilot@1.0.0+builtin.${packageDigest.slice(0, 16)}`;
  const manifestDigest = sha256(
    canonicalJsonBytes({ packageDigest, capabilities, requestedGrants, assets }),
  );
  const generation = {
    ...original.packageRecord.generation,
    id: extensionGeneration,
    packageDigest,
    manifestDigest,
  };
  const unsignedManifest = {
    apiVersion: "nanasa.dev/provider-extension/v2" as const,
    kind: "ProviderExtension" as const,
    generation,
    displayName: original.packageRecord.manifest.displayName,
    description: original.packageRecord.manifest.description,
    providerId: "copilot",
    capabilities,
    requestedGrants,
    assets,
    antiRollbackSequence: 1,
  };
  const manifest = ProviderPackageManifestSchema.parse({
    ...unsignedManifest,
    signatures: [
      {
        algorithm: "ed25519",
        keyId: "nanasa-builtin-root",
        signature: createHash("sha512")
          .update(canonicalJsonBytes(unsignedManifest))
          .digest("base64url"),
        signedAt: now,
      },
    ],
  });
  const packageRecord = ProviderPackageRecordSchema.parse({
    generation,
    source: { kind: "builtin", buildDigest: packageDigest },
    manifest,
    state: "resolved",
    importedAt: now,
    verifiedAt: now,
  });
  const negotiated = negotiateProviderPackage(manifest, HOST_PROVIDER_CAPABILITIES);
  const body = {
    ...original.snapshot.body,
    packageDigest,
    extensionGeneration,
    capabilities: negotiated.capabilities,
    grants: negotiated.grants,
  };
  const canonicalBytes = canonicalProviderSnapshotBytes(body);
  const snapshot = ResolvedProviderAdapterSnapshotSchema.parse({
    digest: await digestProviderSnapshot(body),
    canonicalBytes: Buffer.from(canonicalBytes).toString("base64url"),
    body: JSON.parse(Buffer.from(canonicalBytes).toString("utf8")),
  });
  const resolved = await resolveProviderAdapter(snapshot, original.resolved.assets);
  return Object.freeze({
    packageRecord,
    snapshot: Object.freeze({
      digest: snapshot.digest,
      canonicalBytes: snapshot.canonicalBytes,
      body: resolved.body,
    }),
    resolved,
    reporterDrivers: original.reporterDrivers,
  });
}

beforeEach(() => {
  database = openNanasaDatabase(":memory:");
  seedRun();
});

afterEach(() => database.close());

describe("provider update detector", () => {
  it("classifies current and outdated bindings without resolving historical snapshots", () => {
    const requireForRecovery = vi.fn(() => {
      throw new Error("historical snapshot resolution must not run");
    });
    const bindings = {
      getForRun: vi.fn(() => ({ providerId: "copilot", snapshotDigest: digest("a") })),
      requireForRecovery,
    };
    const index = {
      get: vi.fn(() => ({ providerId: "copilot", snapshotDigest: digest("a") })),
    };
    const detector = new ProviderUpdateDetector(bindings, index);

    expect(detector.detect({ runId: "run-one", generation: 1, memberId: "member-one" })).toEqual({
      runId: "run-one",
      generation: 1,
      memberId: "member-one",
      providerId: "copilot",
      previousSnapshotDigest: digest("a"),
      currentSnapshotDigest: digest("a"),
      status: "current",
    });

    index.get.mockReturnValue({ providerId: "copilot", snapshotDigest: digest("b") });
    expect(detector.detect({ runId: "run-one", generation: 1, memberId: "member-one" })).toEqual({
      runId: "run-one",
      generation: 1,
      memberId: "member-one",
      providerId: "copilot",
      previousSnapshotDigest: digest("a"),
      currentSnapshotDigest: digest("b"),
      status: "outdated",
    });
    expect(requireForRecovery).not.toHaveBeenCalled();
  });

  it("rejects inconsistent plan status and missing bindings", () => {
    expect(() =>
      planProviderUpdate({
        runId: "run-one",
        generation: 1,
        memberId: "member-one",
        providerId: "copilot",
        previousSnapshotDigest: digest("a"),
        currentSnapshotDigest: digest("a"),
      }),
    ).not.toThrow();

    const detector = new ProviderUpdateDetector({ getForRun: () => undefined }, { get: vi.fn() });
    expect(() =>
      detector.detect({ runId: "run-one", generation: 1, memberId: "member-one" }),
    ).toThrow(/binding is unavailable/);
  });

  it("detects an outdated binding without parsing its unsupported historical snapshot", async () => {
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    const current = await buildTrustedBuiltinCopilotPackage();
    await index.registerTrustedBuiltin(current, now);
    const historicalBody = {
      ...current.snapshot.body,
      capabilities: current.snapshot.body.capabilities.map((capability) =>
        capability.id === "recognition"
          ? {
              ...capability,
              payload: {
                ...(capability.payload as Record<string, unknown>),
                configuredCommandMatchers: [
                  { executableNames: ["copilot"], requiredArgvLiterals: [] },
                ],
              },
            }
          : capability,
      ),
    };
    const historicalBytes = canonicalJsonBytes(historicalBody, {
      setLikePaths: ["/capabilities", "/grants", "/assets"],
    });
    const historicalDigest = sha256(historicalBytes);
    database
      .prepare(
        `INSERT INTO provider_snapshots
          (digest,extension_generation,provider_id,adapter_id,canonical_bytes,
           manifest_protocol_json,adapter_protocol_json,interpreter_versions_json,
           capabilities_json,grants_json,assets_json,compatibility_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        historicalDigest,
        historicalBody.extensionGeneration,
        historicalBody.providerId,
        historicalBody.adapterId,
        historicalBytes,
        canonicalJson(historicalBody.manifestProtocol),
        canonicalJson(historicalBody.adapterProtocol),
        canonicalJson(historicalBody.interpreterVersions),
        canonicalJson(historicalBody.capabilities),
        canonicalJson(historicalBody.grants),
        canonicalJson(historicalBody.assets),
        canonicalJson(historicalBody.providerBinaryCompatibility),
        now,
      );
    database
      .prepare(
        `INSERT INTO provider_activations
          (id,index_generation,provider_id,extension_generation,snapshot_digest,grants_digest,
           trust_digest,state,created_at,activated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "activation-historical",
        2,
        historicalBody.providerId,
        historicalBody.extensionGeneration,
        historicalDigest,
        digest("4"),
        digest("5"),
        "superseded",
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
        "binding-historical",
        "run-one",
        1,
        "copilot",
        historicalBody.providerId,
        historicalBody.adapterId,
        historicalDigest,
        "activation-historical",
        digest("6"),
        digest("7"),
        "state-one",
        "overlay-one",
        "{}",
        canonicalJson(launchPlan),
        digest("8"),
        digest("9"),
        digest("a"),
        canonicalJson(historicalBody.providerBinaryCompatibility),
        now,
      );

    const parseSnapshot = vi.spyOn(snapshots, "getSnapshot");
    await expect(snapshots.getSnapshot(historicalDigest)).rejects.toThrow();
    parseSnapshot.mockClear();
    const bindings = new ProviderRunBindingRepository(database, index, snapshots);
    const detector = new ProviderUpdateDetector(bindings, index);

    expect(detector.detect({ runId: "run-one", generation: 1, memberId: "member-one" })).toEqual({
      runId: "run-one",
      generation: 1,
      memberId: "member-one",
      providerId: "copilot",
      previousSnapshotDigest: historicalDigest,
      currentSnapshotDigest: current.snapshot.digest,
      status: "outdated",
    });
    expect(parseSnapshot).not.toHaveBeenCalled();
    expect(snapshots.getSnapshotArchiveRecord(historicalDigest)).toEqual({
      digest: historicalDigest,
      extensionGeneration: historicalBody.extensionGeneration,
      providerId: historicalBody.providerId,
      adapterId: historicalBody.adapterId,
      canonicalBytes: Buffer.from(historicalBytes).toString("base64url"),
    });
    expect(bindings.getForRun("run-one", 1)).toMatchObject({
      id: "binding-historical",
      snapshotDigest: historicalDigest,
      activationId: "activation-historical",
    });
  });

  it("keeps old bound snapshots when changed built-in content becomes active", async () => {
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    const original = await buildTrustedBuiltinCopilotPackage();
    await index.registerTrustedBuiltin(original, now);
    const bindings = new ProviderRunBindingRepository(database, index, snapshots);
    const binding = await bindings.create({
      runId: "run-one",
      generation: 1,
      integrationId: "copilot",
      providerId: "copilot",
      snapshotDigest: original.snapshot.digest,
      providerStateId: "state-one",
      overlayId: "overlay-one",
      credentialSlots: {},
      launchPlan,
      launchDigest: digest("1"),
      permissionFloorDigest: digest("2"),
      repositoryTrustDigest: digest("3"),
      createdAt: now,
    });
    const detector = new ProviderUpdateDetector(bindings, index);
    expect(
      detector.detect({ runId: "run-one", generation: 1, memberId: "member-one" }).status,
    ).toBe("current");

    const changed = await withChangedBuiltinContent(original);
    expect(changed.packageRecord.generation.version).toBe("1.0.0");
    expect(changed.packageRecord.manifest.antiRollbackSequence).toBe(1);
    expect(changed.packageRecord.generation.id).not.toBe(original.packageRecord.generation.id);
    expect(changed.snapshot.digest).not.toBe(original.snapshot.digest);
    await index.registerTrustedBuiltin(changed, "2026-09-01T00:00:01.000Z");

    const resolveHistorical = vi
      .spyOn(snapshots, "getResolvedSnapshot")
      .mockRejectedValue(new Error("historical snapshot must not be resolved"));
    expect(detector.detect({ runId: "run-one", generation: 1, memberId: "member-one" })).toEqual({
      runId: "run-one",
      generation: 1,
      memberId: "member-one",
      providerId: "copilot",
      previousSnapshotDigest: original.snapshot.digest,
      currentSnapshotDigest: changed.snapshot.digest,
      status: "outdated",
    });
    expect(resolveHistorical).not.toHaveBeenCalled();
    expect(bindings.getForRun("run-one", 1)).toEqual(binding);
    expect(await snapshots.getSnapshot(original.snapshot.digest)).toEqual(original.snapshot);
    expect(database.prepare("SELECT count(*) AS count FROM provider_packages").get()).toEqual({
      count: 2,
    });
    expect(database.prepare("SELECT count(*) AS count FROM provider_snapshots").get()).toEqual({
      count: 2,
    });
  });
});
