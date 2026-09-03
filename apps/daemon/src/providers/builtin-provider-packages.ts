import { createHash } from "node:crypto";
import {
  type CapabilityDeclaration,
  canonicalJsonBytes,
  canonicalProviderSnapshotBytes,
  digestProviderSnapshot,
  ImmutableAssetReferenceSchema,
  type ProviderGrant,
  ProviderPackageManifestSchema,
  ProviderPackageRecordSchema,
  ResolvedProviderAdapterSnapshotSchema,
} from "@nanasa/contracts";
import { HOOK_STATUS_REPORTER_SOURCE } from "../status-reporter-assets.js";
import {
  HOST_PROVIDER_CAPABILITIES,
  negotiateProviderPackage,
} from "./provider-capability-negotiator.js";
import {
  type ProviderReporterDriver,
  ProviderReporterDriverRegistry,
} from "./provider-reporter-driver-registry.js";
import {
  type ProviderAssetContent,
  type ProviderAssetKind,
  ProviderAssetRegistry,
  providerAssetBytes,
  type ResolvedProviderAdapter,
  resolveProviderAdapter,
} from "./resolved-provider-adapter.js";

const BUILTIN_TIMESTAMP = "2026-09-01T00:00:00.000Z";
const COPILOT_VERSION = "1.0.0";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function capability(
  id: CapabilityDeclaration["id"],
  payload: unknown,
  options: {
    readonly required?: boolean;
    readonly requires?: CapabilityDeclaration["requires"];
  } = {},
): CapabilityDeclaration {
  return {
    id,
    required: options.required ?? true,
    version: { major: id === "reporter" ? 2 : 1, minimumMinor: 0, maximumMinor: 0 },
    payload,
    requires:
      options.requires ??
      (id === "identity"
        ? []
        : [{ id: "identity", version: { major: 1, minimumMinor: 0, maximumMinor: 0 } }]),
    conflicts: [],
  };
}

function createAsset(
  path: string,
  mediaType: string,
  kind: ProviderAssetKind,
  payload: unknown,
): ProviderAssetContent {
  const body = { kind, payload } as const;
  return Object.freeze({
    path,
    mediaType,
    kind,
    payload,
    digest: sha256(providerAssetBytes(body)),
  });
}

const COPILOT_ASSETS = Object.freeze([
  createAsset(
    "builtin/copilot/reporter-source-v2",
    "text/javascript",
    "literal",
    HOOK_STATUS_REPORTER_SOURCE,
  ),
  createAsset("builtin/copilot/plugin-manifest-v1", "application/json", "copilot-plugin-manifest", {
    name: "nanasa-status-reporter",
    description: "Nanasa lifecycle status reporter",
    version: COPILOT_VERSION,
    agents: "com.github.copilot/agents/",
    hooks: "com.github.copilot/hooks/hooks.json",
  }),
  createAsset("builtin/copilot/hooks-manifest-v1", "application/json", "copilot-hooks-manifest", {
    version: 1,
    hooks: [
      { hook: "sessionStart", event: "sessionStart" },
      { hook: "userPromptSubmitted", event: "userPromptSubmitted" },
      { hook: "preToolUse", event: "preToolUse", matcher: ".*" },
      { hook: "permissionRequest", event: "permissionRequest", matcher: ".*" },
      { hook: "postToolUse", event: "postToolUse", matcher: ".*" },
      { hook: "postToolUseFailure", event: "postToolUseFailure", matcher: ".*" },
      { hook: "agentStop", event: "agentStop" },
      { hook: "errorOccurred", event: "errorOccurred" },
      { hook: "preCompact", event: "preCompact" },
      { hook: "sessionEnd", event: "sessionEnd" },
    ],
  }),
  createAsset("builtin/copilot/mcp-config-v1", "application/json", "copilot-mcp-config", {
    serverId: "nanasa",
    type: "http",
    authorization: "Bearer ${NANASA_MCP_TOKEN}",
    tools: ["*"],
  }),
  createAsset("builtin/copilot/prompt-v1", "text/markdown", "copilot-prompt", {
    infer: false,
    namePrefix: "Nanasa ",
    descriptionPrefix: "Nanasa-managed ",
  }),
  createAsset(
    "builtin/copilot/screen-manifest-2026.07.07.1",
    "application/json",
    "screen-manifest",
    {
      id: "copilot",
      version: "2026.07.07.1",
      source: "herdr-adapted",
      noMatch: "no-claim",
      rules: [
        {
          id: "selection_blocker",
          priority: 300,
          claim: "blocked",
          visibleBlocker: true,
          region: "whole-recent",
          all: [
            { any: ["esc to cancel", "esc cancel"] },
            {
              any: ["enter to select", "enter to confirm", "enter to submit", "enter accept"],
            },
          ],
        },
        {
          id: "working_cancel_hint",
          priority: 100,
          claim: "working",
          visibleWorking: true,
          region: "whole-recent",
          any: ["esc to cancel", "esc cancel", "esc again to cancel", "esc interrupt"],
        },
      ],
    },
  ),
]);

function assetReferences(): readonly ReturnType<typeof ImmutableAssetReferenceSchema.parse>[] {
  return COPILOT_ASSETS.map((asset) => ({
    path: asset.path,
    mediaType: asset.mediaType,
    bytes: providerAssetBytes(asset).byteLength,
    digest: asset.digest,
  }));
}

function assetDigest(kind: ProviderAssetKind): string {
  const asset = COPILOT_ASSETS.find((candidate) => candidate.kind === kind);
  if (asset === undefined) throw new Error(`Missing Copilot built-in asset ${kind}`);
  return asset.digest;
}

function copilotCapabilities(): readonly CapabilityDeclaration[] {
  const events = [
    "session.ready",
    "turn.started",
    "turn.settled",
    "tool.started",
    "tool.finished",
    "tool.failed",
    "wait.opened",
    "wait.closed",
    "compaction.started",
    "failure.observed",
    "session.ended",
  ];
  return [
    capability("identity", {
      publisherId: "nanasa",
      providerId: "copilot",
      extensionId: "nanasa.copilot",
      adapterId: "nanasa.copilot-v2",
      ownedNamespaces: ["copilot"],
    }),
    capability("recognition", {
      observedProcessMatchers: [
        {
          executableNames: ["copilot", "copilot.exe"],
          requiredArgvLiterals: [],
        },
      ],
      maximumWrapperDepth: 0,
    }),
    capability("launch", {
      executableSlot: "configured-command",
      argumentTemplate: [
        "overlay:copilot-reporter",
        "optional:copilot-mcp",
        "optional:copilot-prompt",
        "optional:copilot-read-only",
        "optional:copilot-session",
        "optional:copilot-model",
      ],
      environmentNames: ["COPILOT_HOME", "COPILOT_CACHE_HOME"],
      files: [
        {
          recipeId: "copilot.reporter.source",
          relativePath: "copilot-status-plugin/status-hook.mjs",
          mode: "private-file",
          assetDigest: assetDigest("literal"),
        },
        {
          recipeId: "copilot.reporter.plugin",
          relativePath: "copilot-status-plugin/plugin.json",
          mode: "private-file",
          assetDigest: assetDigest("copilot-plugin-manifest"),
        },
        {
          recipeId: "copilot.reporter.hooks",
          relativePath: "copilot-status-plugin/com.github.copilot/hooks/hooks.json",
          mode: "private-file",
          assetDigest: assetDigest("copilot-hooks-manifest"),
        },
        {
          recipeId: "copilot.mcp.config",
          relativePath: "mcp/config.json",
          mode: "private-file",
          assetDigest: assetDigest("copilot-mcp-config"),
        },
        {
          recipeId: "copilot.prompt.agent",
          relativePath:
            "copilot-status-plugin/com.github.copilot/agents/{generatedAgentName}.agent.md",
          mode: "private-file",
          assetDigest: assetDigest("copilot-prompt"),
        },
      ],
      directExec: true,
    }),
    capability("state", {
      scopes: ["membership", "integration", "custom"],
      defaultScope: "membership",
      environmentNames: ["COPILOT_HOME", "COPILOT_CACHE_HOME"],
      environmentPaths: {
        COPILOT_HOME: "{stateRoot}",
        COPILOT_CACHE_HOME: "{stateRoot}/cache",
      },
      cacheSubdirectories: ["cache"],
      formatVersion: "copilot-state-v1",
      sharing: "integration-explicit",
    }),
    capability("prompt", {
      placement: "generated-agent",
      identityTemplateId: "copilot.prompt.agent",
      includesRoleContext: true,
      readOnlyFloor: ["write", "shell"],
      maximumBytes: 262_144,
    }),
    capability("mcp", {
      registration: "argument-file",
      endpointPlaceholder: "NANASA_MCP_URL",
      tokenPlaceholder: "NANASA_MCP_TOKEN",
      loopbackOnly: true,
      fileRecipeId: "copilot.mcp.config",
    }),
    capability("reporter", {
      protocolMajor: 3,
      driverId: "copilot-hooks",
      sourceId: "copilot",
      reporterVersion: "2",
      sourceAssetDigest: assetDigest("literal"),
      events,
      fieldsByEvent: Object.fromEntries(events.map((event) => [event, []])),
      readinessEvents: ["session.ready"],
      waitTransports: ["terminal"],
      rootSessionPolicy: "single",
      sequencing: "monotonic",
      permanentRejectionCodes: ["status_reporter_identity_fenced", "status_native_session_fenced"],
    }),
    capability("control", {
      operations: [
        {
          operationId: "terminal.prompt",
          kind: "prompt",
          transport: "terminal",
          codecId: "copilot.bracketed-paste-submit",
          acknowledgement: "transport",
        },
        {
          operationId: "terminal.wait-reply",
          kind: "wait-reply",
          transport: "terminal",
          codecId: "nanasa.closed-wait-reply",
          acknowledgement: "reporter",
        },
        {
          operationId: "terminal.interrupt",
          kind: "interrupt",
          transport: "terminal",
          codecId: "nanasa.ctrl-c",
          acknowledgement: "transport",
        },
      ],
    }),
    capability("models", {
      identifierPattern: "^[^\\s\\0]{1,256}$",
      launchTemplate: ["--model", "{model}"],
      effectiveEvidence: [],
      resumePolicy: "preserve-session",
    }),
    capability("sessions", {
      referenceKinds: ["id"],
      maximumReferenceBytes: 4_096,
      normalizationVersion: "copilot-session-id-v1",
      dedupeVersion: "provider-kind-value-v1",
      resumeArgumentTemplate: ["--resume={reference}"],
    }),
    capability("credentials", {
      providerManaged: true,
      slots: [
        {
          slotId: "github-token",
          optional: true,
          targetNames: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
        },
      ],
    }),
    capability("semantic-status", {
      policyId: "copilot.semantic-status-v1",
      authorityOrder: ["reporter", "screen", "process"],
      processOnlyProjection: "running",
      maximumHintConfidence: "medium",
      turnCycle: "reporter-root",
      thresholdsMs: { startup: 30_000, model: 120_000, tool: 120_000 },
    }),
    capability(
      "screen",
      {
        manifestDigest: assetDigest("screen-manifest"),
        maximumRows: 80,
        maximumBytes: 65_536,
        confidenceCeiling: "medium",
        startupGraceMs: 3_000,
        confirmationCount: 3,
      },
      {
        requires: [
          { id: "semantic-status", version: { major: 1, minimumMinor: 0, maximumMinor: 0 } },
        ],
      },
    ),
    capability("health", {
      binaryNames: ["copilot", "copilot.exe"],
      requiredReporterEvents: events,
    }),
    capability("compatibility", {
      nanasa: ">=0.1.0-next.11 <0.2.0",
      rpcMajors: [],
      providerBinary: ">=1.0.79 <2.0.0",
      operatingSystems: ["linux"],
      architectures: ["x64", "arm64"],
    }),
  ];
}

function copilotGrants(capabilities: readonly CapabilityDeclaration[]): readonly ProviderGrant[] {
  const events = (
    capabilities.find((item) => item.id === "reporter")?.payload as { events: string[] }
  ).events;
  return [
    {
      permission: "provider-state.read-managed",
      parameters: { scopes: ["membership", "integration", "custom"] },
    },
    {
      permission: "provider-state.write-owned",
      parameters: {
        recipeIds: [
          "copilot.reporter.source",
          "copilot.reporter.plugin",
          "copilot.reporter.hooks",
          "copilot.mcp.config",
          "copilot.prompt.agent",
        ],
      },
    },
    { permission: "runtime.launch", parameters: { executableNames: ["copilot", "copilot.exe"] } },
    {
      permission: "network.connect",
      parameters: { origins: ["http://127.0.0.1", "https://127.0.0.1"] },
    },
    { permission: "reporter.emit", parameters: { sourceId: "copilot", events } },
    {
      permission: "terminal.operate",
      parameters: {
        operationIds: ["terminal.prompt", "terminal.wait-reply", "terminal.interrupt"],
      },
    },
    {
      permission: "credential.inject",
      parameters: {
        slotIds: ["github-token"],
        targetNames: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
      },
    },
  ];
}

export interface TrustedBuiltInProviderPackage {
  readonly packageRecord: ReturnType<typeof ProviderPackageRecordSchema.parse>;
  readonly snapshot: ReturnType<typeof ResolvedProviderAdapterSnapshotSchema.parse>;
  readonly resolved: ResolvedProviderAdapter;
  readonly reporterDrivers: ProviderReporterDriverRegistry;
}

export async function buildTrustedBuiltinCopilotPackage(): Promise<TrustedBuiltInProviderPackage> {
  const capabilities = copilotCapabilities();
  const requestedGrants = copilotGrants(capabilities);
  const assets = assetReferences();
  const packageDigest = sha256(
    canonicalJsonBytes({ providerId: "copilot", capabilities, requestedGrants, assets }),
  );
  const extensionGeneration = `nanasa.copilot@${COPILOT_VERSION}+builtin.${packageDigest.slice(0, 16)}`;
  const manifestDigest = sha256(
    canonicalJsonBytes({ packageDigest, capabilities, requestedGrants, assets }),
  );
  const generation = {
    id: extensionGeneration,
    extensionId: "nanasa.copilot",
    version: COPILOT_VERSION,
    packageDigest,
    manifestDigest,
    publisherId: "nanasa",
    namespaceClaims: ["copilot"],
  };
  const unsignedManifest = {
    apiVersion: "nanasa.dev/provider-extension/v2" as const,
    kind: "ProviderExtension" as const,
    generation,
    displayName: "GitHub Copilot CLI",
    description: "Trusted Nanasa built-in adapter for GitHub Copilot CLI",
    providerId: "copilot",
    capabilities,
    requestedGrants,
    assets,
    antiRollbackSequence: 1,
  };
  const signature = createHash("sha512")
    .update(canonicalJsonBytes(unsignedManifest))
    .digest("base64url");
  const manifest = ProviderPackageManifestSchema.parse({
    ...unsignedManifest,
    signatures: [
      {
        algorithm: "ed25519",
        keyId: "nanasa-builtin-root",
        signature,
        signedAt: BUILTIN_TIMESTAMP,
      },
    ],
  });
  const packageRecord = ProviderPackageRecordSchema.parse({
    generation,
    source: { kind: "builtin", buildDigest: packageDigest },
    manifest,
    state: "resolved",
    importedAt: BUILTIN_TIMESTAMP,
    verifiedAt: BUILTIN_TIMESTAMP,
  });
  const negotiated = negotiateProviderPackage(manifest, HOST_PROVIDER_CAPABILITIES);
  const body = {
    formatVersion: 2 as const,
    manifestProtocol: { major: 2, minor: 0 },
    adapterProtocol: { major: 2, minor: 0 },
    packageDigest,
    providerId: "copilot",
    adapterId: "nanasa.copilot-v2",
    extensionId: "nanasa.copilot",
    extensionGeneration,
    interpreterVersions: { core: "2.0.0" },
    capabilities: negotiated.capabilities,
    grants: negotiated.grants,
    assets,
    providerBinaryCompatibility: {
      state: "compatible" as const,
      range: ">=1.0.79 <2.0.0",
    },
  };
  const canonicalBytes = canonicalProviderSnapshotBytes(body);
  const canonicalBody = JSON.parse(Buffer.from(canonicalBytes).toString("utf8"));
  const snapshot = ResolvedProviderAdapterSnapshotSchema.parse({
    digest: await digestProviderSnapshot(body),
    canonicalBytes: Buffer.from(canonicalBytes).toString("base64url"),
    body: canonicalBody,
  });
  const assetRegistry = new ProviderAssetRegistry(COPILOT_ASSETS);
  const resolved = await resolveProviderAdapter(snapshot, assetRegistry);
  const immutableSnapshot = Object.freeze({
    digest: snapshot.digest,
    canonicalBytes: snapshot.canonicalBytes,
    body: resolved.body,
  });
  const reporter = negotiated.capabilities.find((item) => item.id === "reporter")?.payload as {
    driverId: string;
    protocolMajor: number;
    sourceId: string;
  };
  const reporterDriver: ProviderReporterDriver = {
    driverId: reporter.driverId,
    protocolMajor: reporter.protocolMajor,
    sourceId: reporter.sourceId,
    reporterVersion: "2",
    sourceAssetDigest: assetDigest("literal"),
  };
  return Object.freeze({
    packageRecord,
    snapshot: immutableSnapshot,
    resolved,
    reporterDrivers: new ProviderReporterDriverRegistry(assetRegistry, [reporterDriver]),
  });
}

export {
  buildTrustedBuiltinClaudeCodePackage,
  buildTrustedBuiltinOpenCodePackage,
  buildTrustedBuiltinPiPackage,
  piMcpAdapterAssetDigest,
} from "./builtin-provider-package-catalog.js";
