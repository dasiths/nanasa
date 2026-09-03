import type { AgentKind, OpenWaitReply } from "@nanasa/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { EffectiveAgentPrompt } from "../src/instruction-resolver.js";
import { openNanasaDatabase } from "../src/persistence/database.js";
import {
  buildTrustedBuiltinClaudeCodePackage,
  buildTrustedBuiltinCopilotPackage,
  buildTrustedBuiltinOpenCodePackage,
  buildTrustedBuiltinPiPackage,
  piMcpAdapterAssetDigest,
  type TrustedBuiltInProviderPackage,
} from "../src/providers/builtin-provider-packages.js";
import { resolveBuiltInProviderEvaluatorOptions } from "../src/providers/provider-runtime-assets.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotEvaluator } from "../src/providers/provider-snapshot-evaluator.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";
import { providerStatusPolicy } from "../src/providers/provider-status-policy.js";
import { assertFunctionFreeProviderSnapshot } from "../src/providers/resolved-provider-adapter.js";

const PI_MCP_ADAPTER_PATH = "/runtime/pi-mcp-adapter/index.ts";
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

const waitReplies = [
  { kind: "allow-once" },
  { kind: "answer", text: "answer" },
  { kind: "select", option: "choice" },
  { kind: "approve-plan" },
] as const satisfies readonly OpenWaitReply[];

interface Subject {
  readonly id: AgentKind;
  readonly package: TrustedBuiltInProviderPackage;
  readonly evaluator: ProviderSnapshotEvaluator;
  readonly command: readonly string[];
}

let subjects: readonly Subject[];

beforeAll(async () => {
  const packages = await Promise.all([
    buildTrustedBuiltinCopilotPackage(),
    buildTrustedBuiltinClaudeCodePackage(),
    buildTrustedBuiltinPiPackage(),
    buildTrustedBuiltinOpenCodePackage(),
  ]);
  subjects = packages.map((builtIn) => {
    const id = builtIn.snapshot.body.providerId as AgentKind;
    const runtimeAssetPaths =
      id === "pi" ? { [piMcpAdapterAssetDigest(builtIn)]: PI_MCP_ADAPTER_PATH } : undefined;
    return {
      id,
      package: builtIn,
      evaluator: new ProviderSnapshotEvaluator(builtIn.resolved, builtIn.reporterDrivers, {
        runtimeAssetPaths,
      }),
      command: [id === "claude-code" ? "claude" : id],
    };
  });
});

function overlayContext(
  id: AgentKind,
  options: {
    readonly mcp?: boolean;
    readonly prompt?: boolean;
    readonly readOnly?: boolean;
  } = {},
) {
  return {
    membershipId: "membership-one",
    memberAlias: "Reviewer One",
    stateRoot: `/state/${id}`,
    overlayRoot: `/overlay/${id}`,
    ...(options.mcp === false ? {} : { mcpEndpointUrl: "https://127.0.0.1:3210/mcp" }),
    statusEndpointUrl: "http://127.0.0.1:3210/api/v1/agent-status/events",
    ...(options.prompt === false ? {} : { prompt }),
    readOnly: options.readOnly ?? true,
  } as const;
}

async function rebuild(id: AgentKind): Promise<TrustedBuiltInProviderPackage> {
  switch (id) {
    case "copilot":
      return buildTrustedBuiltinCopilotPackage();
    case "claude-code":
      return buildTrustedBuiltinClaudeCodePackage();
    case "pi":
      return buildTrustedBuiltinPiPackage();
    case "opencode":
      return buildTrustedBuiltinOpenCodePackage();
  }
}

describe("built-in provider snapshot conformance", () => {
  it("builds all four trusted packages deterministically through one public schema", async () => {
    expect(subjects.map((subject) => subject.id)).toEqual([
      "copilot",
      "claude-code",
      "pi",
      "opencode",
    ]);
    for (const subject of subjects) {
      const repeated = await rebuild(subject.id);
      const generation = subject.package.packageRecord.generation;
      expect(generation.version).toBe("1.0.0");
      expect(subject.package.packageRecord.manifest.antiRollbackSequence).toBe(1);
      expect(generation.id).toBe(
        `${generation.extensionId}@1.0.0+builtin.${generation.packageDigest.slice(0, 16)}`,
      );
      expect(repeated.snapshot.digest).toBe(subject.package.snapshot.digest);
      expect(repeated.snapshot.canonicalBytes).toBe(subject.package.snapshot.canonicalBytes);
      expect(() => assertFunctionFreeProviderSnapshot(subject.package.snapshot.body)).not.toThrow();
      expect(Object.isFrozen(subject.package.snapshot.body)).toBe(true);
      expect(Object.isFrozen(subject.package.snapshot.body.capabilities)).toBe(true);
      expect(subject.package.snapshot.body.capabilities.map((item) => item.id)).toEqual([
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
    }
  });

  it("evaluates launch, overlay, state, model, credential, and control capabilities", () => {
    for (const subject of subjects) {
      const context = overlayContext(subject.id);
      for (const mcp of [true, false]) {
        for (const includesPrompt of [true, false]) {
          for (const readOnly of [true, false]) {
            const matrixContext = overlayContext(subject.id, {
              mcp,
              prompt: includesPrompt,
              readOnly,
            });
            const overlay = subject.evaluator.planOverlay(matrixContext);
            expect(overlay.files.every((file) => file.relativePath.length > 0)).toBe(true);
            expect(Object.isFrozen(overlay.commandArguments)).toBe(true);
          }
        }
      }
      expect(
        Object.values(subject.evaluator.stateEnvironment(context.stateRoot)).every((value) =>
          value.startsWith(context.stateRoot),
        ),
      ).toBe(true);
      expect(subject.evaluator.modelArguments("provider/model-one")).toContain(
        "provider/model-one",
      );
      expect(subject.evaluator.credentialEnvironmentNames().length).toBeGreaterThan(0);
      const control = subject.evaluator.controlPolicy();
      expect(control.waitReplyChannels).toEqual(["terminal"]);
      expect(control.terminalSubmitSequence.length).toBeGreaterThan(0);
      for (const reply of waitReplies) {
        expect(subject.evaluator.encodeWaitReply(reply).length).toBeGreaterThan(0);
      }
    }
  });

  it("supports exact fresh and resumed launches plus the declarative environment strategy", () => {
    for (const subject of subjects) {
      const context = overlayContext(subject.id);
      const overlay = subject.evaluator.planOverlay(context);
      const snapshotSession = subject.evaluator.normalizeNativeSession(
        {
          source: subject.id,
          referenceKind: "id",
          referenceValue: "session-one",
        },
        context.stateRoot,
      );
      const resumeArguments = subject.evaluator.resumeArguments(snapshotSession);
      expect(
        subject.evaluator.launch({
          ...context,
          configuredCommand: subject.command,
          model: "provider/model-one",
        }).command,
      ).toEqual([
        ...subject.command,
        ...overlay.commandArguments,
        ...subject.evaluator.modelArguments("provider/model-one"),
      ]);
      expect(
        subject.evaluator.launch({
          ...context,
          configuredCommand: subject.command,
          model: "provider/model-one",
          nativeSession: snapshotSession,
          enforceConfiguredModelOnResume: true,
        }).command,
      ).toEqual([
        ...subject.command,
        ...overlay.commandArguments,
        ...resumeArguments,
        ...subject.evaluator.modelArguments("provider/model-one"),
      ]);
    }

    const claude = subjects.find((subject) => subject.id === "claude-code");
    expect(claude).toBeDefined();
    const context = overlayContext("claude-code");
    const overlay = claude!.evaluator.planOverlay(context);
    const wrapped = claude!.evaluator.launch({
      ...context,
      configuredCommand: ["sh", "custom-launcher"],
      providerArgumentStrategy: { kind: "environment", name: "CUSTOM_PROVIDER_ARGS" },
      model: "provider/model-one",
    });
    expect(wrapped.command).toEqual(["sh", "custom-launcher"]);
    expect(wrapped.environment.CUSTOM_PROVIDER_ARGS).toBe(
      "'--settings' '/overlay/claude-code/settings.json' '--mcp-config' '/overlay/claude-code/mcp.json' '--append-system-prompt-file' '/overlay/claude-code/prompts/system.md' '--model' 'provider/model-one'",
    );
    expect(overlay.commandArguments).toContain("--settings");
  });

  it("keeps arbitrary command augmentation separate from observed-process recognition", () => {
    for (const subject of subjects) {
      const executable = subject.command[0]!;
      const recognition = subject.package.snapshot.body.capabilities.find(
        (capability) => capability.id === "recognition",
      );
      expect(recognition?.payload).not.toHaveProperty("configuredCommandMatchers");
      expect(subject.evaluator.matchesObservedProcess([executable], `/opt/bin/${executable}`)).toBe(
        true,
      );
      expect(
        subject.evaluator.matchesObservedProcess(["node", "worker.mjs"], "/usr/bin/node"),
      ).toBe(false);
      expect(
        subject.evaluator.augmentConfiguredCommand(["node", "worker.mjs"], ["--model", "x"]),
      ).toEqual(["node", "worker.mjs", "--model", "x"]);
    }
  });

  it("enforces Pi path containment and pins its MCP adapter as an immutable runtime asset", () => {
    const pi = subjects.find((subject) => subject.id === "pi")!;
    const contained = pi.evaluator.normalizeNativeSession(
      {
        source: "pi",
        referenceKind: "path",
        referenceValue: "/state/pi/sessions/one.jsonl",
      },
      "/state/pi",
    );
    expect(contained.referenceKind).toBe("state-contained-path");
    expect(pi.evaluator.resumeArguments(contained)).toEqual([
      "--session",
      "/state/pi/sessions/one.jsonl",
    ]);
    expect(() =>
      pi.evaluator.normalizeNativeSession(
        { source: "pi", referenceKind: "path", referenceValue: "/outside/one.jsonl" },
        "/state/pi",
      ),
    ).toThrow(/inside provider state/);
    const adapterDigest = piMcpAdapterAssetDigest(pi.package);
    expect(pi.package.resolved.assets.get(adapterDigest)).toMatchObject({
      kind: "pi-mcp-adapter",
      payload: { packageName: "pi-mcp-adapter", packageVersion: "2.18.0", entrypoint: "index.ts" },
    });
    expect(() =>
      new ProviderSnapshotEvaluator(pi.package.resolved, pi.package.reporterDrivers).planOverlay(
        overlayContext("pi"),
      ),
    ).toThrow(/runtime asset path is unavailable/);
    const evaluatorOptions = resolveBuiltInProviderEvaluatorOptions(
      subjects.map((subject) => subject.package),
      (packageName) => `/runtime/${packageName}/index.ts`,
    );
    expect(
      new ProviderSnapshotEvaluator(
        pi.package.resolved,
        pi.package.reporterDrivers,
        evaluatorOptions,
      ).planOverlay(overlayContext("pi")).commandArguments,
    ).toEqual(expect.arrayContaining(["--extension", PI_MCP_ADAPTER_PATH]));
  });

  it("publishes provider-specific reporter and Herdr-adapted status policies as immutable data", () => {
    for (const subject of subjects) {
      expect(subject.evaluator.reporterPolicy()).toMatchObject({
        sourceId: subject.id,
        sequencing: "monotonic",
        permanentRejectionCodes: [
          "status_reporter_identity_fenced",
          "status_native_session_fenced",
        ],
      });
      const status = providerStatusPolicy(subject.package.resolved);
      expect(status.semantic).toMatchObject({
        processOnlyProjection: "running",
        turnCycle: "reporter-root",
      });
      expect(status.screen).toMatchObject({ startupGraceMs: 3_000, confirmationCount: 3 });
      expect(status.screenManifest).toMatchObject({ noMatch: "no-claim" });
    }
    expect(
      subjects.find((subject) => subject.id === "pi")!.evaluator.reporterPolicy(),
    ).toMatchObject({
      rootSessionPolicy: "qualified-root",
    });
    expect(
      subjects.find((subject) => subject.id === "opencode")!.evaluator.reporterPolicy(),
    ).toMatchObject({ rootSessionPolicy: "qualified-root" });
  });

  it("stores and activates all four snapshots atomically one provider at a time without ambiguity", async () => {
    const database = openNanasaDatabase(":memory:");
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    try {
      for (const subject of subjects) await index.registerTrustedBuiltin(subject.package);
      expect(index.list().map((entry) => entry.providerId)).toEqual([
        "claude-code",
        "copilot",
        "opencode",
        "pi",
      ]);
      expect(database.prepare("SELECT count(*) AS count FROM provider_snapshots").get()).toEqual({
        count: 4,
      });
      for (const subject of subjects) {
        expect(await snapshots.getSnapshot(subject.package.snapshot.digest)).toEqual(
          subject.package.snapshot,
        );
      }
    } finally {
      database.close();
    }
  });
});
