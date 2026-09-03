import { createHash } from "node:crypto";
import type { OpenWaitReply } from "@nanasa/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { EffectiveAgentPrompt } from "../src/instruction-resolver.js";
import { openNanasaDatabase } from "../src/persistence/database.js";
import {
  buildTrustedBuiltinCopilotPackage,
  type TrustedBuiltInProviderPackage,
} from "../src/providers/builtin-provider-packages.js";
import {
  ProviderNamespaceOwnership,
  ProviderPermissionPolicy,
} from "../src/providers/provider-capability-negotiator.js";
import { ProviderReporterDriverRegistry } from "../src/providers/provider-reporter-driver-registry.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotEvaluator } from "../src/providers/provider-snapshot-evaluator.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";
import { providerStatusPolicy } from "../src/providers/provider-status-policy.js";
import { assertFunctionFreeProviderSnapshot } from "../src/providers/resolved-provider-adapter.js";

const prompt: EffectiveAgentPrompt = {
  roleId: "reviewer",
  role: {
    name: "Reviewer",
    instructions: [],
    permissionPolicy: "read-only",
  },
  text: "Coordinate through Nanasa.\nReview without editing.\n",
  revision: "a".repeat(64),
  sources: [{ scope: "builtin", reference: "builtin:nanasa-coordination-v1" }],
};

const overlayContext = {
  membershipId: "membership-one",
  memberAlias: "Reviewer One",
  stateRoot: "/state/copilot",
  overlayRoot: "/overlay/copilot",
  mcpEndpointUrl: "https://127.0.0.1:3210/mcp",
  statusEndpointUrl: "http://127.0.0.1:3210/api/v1/agent-status/events",
  prompt,
  readOnly: true,
} as const;

const waitReplies = [
  { kind: "allow-once" },
  { kind: "answer", text: "answer" },
  { kind: "select", option: "choice" },
  { kind: "approve-plan" },
] as const satisfies readonly OpenWaitReply[];

let builtIn: TrustedBuiltInProviderPackage;
let evaluator: ProviderSnapshotEvaluator;

beforeAll(async () => {
  builtIn = await buildTrustedBuiltinCopilotPackage();
  evaluator = new ProviderSnapshotEvaluator(builtIn.resolved, builtIn.reporterDrivers);
});

describe("Copilot provider snapshot conformance", () => {
  it("builds byte-identical, function-free snapshots through public capability schemas", async () => {
    const repeated = await buildTrustedBuiltinCopilotPackage();
    expect(repeated.snapshot.digest).toBe(builtIn.snapshot.digest);
    expect(repeated.snapshot.canonicalBytes).toBe(builtIn.snapshot.canonicalBytes);
    expect(builtIn.snapshot.body.capabilities.map((capability) => capability.id)).toEqual([
      "compatibility",
      "control",
      "credentials",
      "health",
      "identity",
      "launch",
      "mcp",
      "models",
      "prompt",
      "recognition",
      "reporter",
      "screen",
      "semantic-status",
      "sessions",
      "state",
    ]);
    expect(() => assertFunctionFreeProviderSnapshot(builtIn.snapshot.body)).not.toThrow();
    expect(Object.isFrozen(builtIn.snapshot.body)).toBe(true);
    expect(Object.isFrozen(builtIn.snapshot.body.capabilities)).toBe(true);
    expect(Object.isFrozen(builtIn.snapshot.body.capabilities[0]?.payload)).toBe(true);
  });

  it("evaluates exact Copilot launch, overlay, session, and control capabilities", () => {
    const snapshotOverlay = evaluator.planOverlay(overlayContext);
    const reporterSource = snapshotOverlay.files.find(
      (file) => file.relativePath === "copilot-status-plugin/status-hook.mjs",
    );
    const reporterRecipe = (
      builtIn.snapshot.body.capabilities.find((capability) => capability.id === "launch")
        ?.payload as { files: Array<{ recipeId: string; assetDigest?: string }> }
    ).files.find((file) => file.recipeId === "copilot.reporter.source");
    expect(reporterRecipe?.assetDigest).toBe(
      createHash("sha256")
        .update(reporterSource?.content ?? "")
        .digest("hex"),
    );
    expect(evaluator.stateEnvironment(overlayContext.stateRoot)).toEqual({
      COPILOT_HOME: overlayContext.stateRoot,
      COPILOT_CACHE_HOME: `${overlayContext.stateRoot}/cache`,
    });
    expect(evaluator.modelArguments("provider/model-one")).toEqual([
      "--model",
      "provider/model-one",
    ]);
    expect(evaluator.credentialEnvironmentNames()).toEqual([
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]);

    const snapshotSession = evaluator.normalizeNativeSession({
      source: "copilot",
      referenceKind: "id",
      referenceValue: "session-one",
    });
    expect(evaluator.resumeArguments(snapshotSession)).toEqual(["--resume=session-one"]);

    const fresh = evaluator.launch({
      ...overlayContext,
      configuredCommand: ["copilot"],
      model: "provider/model-one",
    });
    expect(fresh.command).toEqual([
      "copilot",
      ...snapshotOverlay.commandArguments,
      ...evaluator.modelArguments("provider/model-one"),
    ]);
    const resumed = evaluator.launch({
      ...overlayContext,
      configuredCommand: ["copilot"],
      model: "provider/model-one",
      nativeSession: snapshotSession,
      enforceConfiguredModelOnResume: true,
    });
    expect(resumed.command).toEqual([
      "copilot",
      ...snapshotOverlay.commandArguments,
      ...evaluator.resumeArguments(snapshotSession),
      ...evaluator.modelArguments("provider/model-one"),
    ]);

    const control = evaluator.controlPolicy();
    expect(control).toMatchObject({
      waitReplyChannels: ["terminal"],
      supportsPromptAcknowledgement: false,
      supportsCancellation: false,
      terminalSubmitSequence: "\u001b[I\r",
    });
    for (const reply of waitReplies) {
      expect(evaluator.encodeWaitReply(reply).length).toBeGreaterThan(0);
    }
  });

  it("augments arbitrary commands while keeping process recognition strict", () => {
    expect(evaluator.matchesObservedProcess(["copilot"], "/opt/bin/copilot")).toBe(true);
    expect(evaluator.matchesObservedProcess(["node", "worker.mjs"], "/usr/bin/node")).toBe(false);
    expect(evaluator.augmentConfiguredCommand(["node", "worker.mjs"], ["--model", "x"])).toEqual([
      "node",
      "worker.mjs",
      "--model",
      "x",
    ]);
  });

  it("exposes Copilot reporter, semantic status, and Herdr-adapted screen policy as data", () => {
    expect(evaluator.reporterPolicy()).toMatchObject({
      driverId: "copilot-hooks",
      sourceId: "copilot",
      events: expect.arrayContaining(["turn.started", "wait.opened", "session.ended"]),
    });
    const policy = providerStatusPolicy(builtIn.resolved);
    expect(policy.semantic).toMatchObject({
      processOnlyProjection: "running",
      turnCycle: "reporter-root",
      maximumHintConfidence: "medium",
    });
    expect(policy.screen).toMatchObject({ startupGraceMs: 3_000, confirmationCount: 3 });
    expect(policy.screenManifest).toMatchObject({
      noMatch: "no-claim",
      rules: expect.arrayContaining([
        expect.objectContaining({ id: "selection_blocker", visibleBlocker: true }),
      ]),
    });
  });

  it("persists immutable bytes before publishing one deterministic runtime-index entry", async () => {
    const database = openNanasaDatabase(":memory:");
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    const activated = await index.registerTrustedBuiltin(builtIn);
    expect(activated).toMatchObject({
      indexGeneration: 1,
      providerId: "copilot",
      snapshotDigest: builtIn.snapshot.digest,
      state: "active",
    });
    expect(index.list()).toEqual([activated]);
    expect(await snapshots.getSnapshot(builtIn.snapshot.digest)).toEqual(builtIn.snapshot);
    const durable = await snapshots.getResolvedSnapshot(builtIn.snapshot.digest);
    expect(
      durable?.assets.list().toSorted((left, right) => left.digest.localeCompare(right.digest)),
    ).toEqual(
      builtIn.resolved.assets
        .list()
        .toSorted((left, right) => left.digest.localeCompare(right.digest)),
    );
    expect(
      new ProviderSnapshotEvaluator(
        durable!,
        ProviderReporterDriverRegistry.fromSnapshot(durable!),
      ).planOverlay(overlayContext),
    ).toEqual(evaluator.planOverlay(overlayContext));
    expect(await index.registerTrustedBuiltin(builtIn)).toEqual(activated);
    expect(database.prepare("SELECT count(*) AS count FROM provider_snapshots").get()).toEqual({
      count: 1,
    });
    expect(database.prepare("SELECT count(*) AS count FROM provider_assets").get()).toEqual({
      count: builtIn.resolved.assets.list().length,
    });
    expect(() =>
      database
        .prepare("UPDATE provider_snapshots SET provider_id = 'other' WHERE digest = ?")
        .run(builtIn.snapshot.digest),
    ).toThrow(/immutable/);
    database.close();
  });

  it("refuses snapshot publication before every immutable asset is durable", async () => {
    const database = openNanasaDatabase(":memory:");
    const snapshots = new ProviderSnapshotRepository(database);
    snapshots.storePackage(builtIn.packageRecord);
    await expect(snapshots.storeSnapshot(builtIn.snapshot)).rejects.toThrow(
      /snapshot asset is unavailable/,
    );
    expect(database.prepare("SELECT count(*) AS count FROM provider_snapshots").get()).toEqual({
      count: 0,
    });
    database.close();
  });

  it("rejects namespace takeover without treating launch grants as command allowlists", () => {
    const namespaces = new ProviderNamespaceOwnership();
    expect(() =>
      namespaces.assertManifest({
        ...builtIn.packageRecord.manifest,
        generation: {
          ...builtIn.packageRecord.manifest.generation,
          publisherId: "attacker",
          namespaceClaims: ["copilot"],
        },
      }),
    ).toThrow(/not owned|already owned/);

    const policy = new ProviderPermissionPolicy();
    expect(
      policy.resolve(builtIn.snapshot.body.capabilities, [
        {
          permission: "runtime.launch",
          parameters: { executableNames: ["bash"] },
        },
      ]),
    ).toEqual([
      {
        permission: "runtime.launch",
        parameters: { executableNames: ["bash"] },
      },
    ]);
  });
});
