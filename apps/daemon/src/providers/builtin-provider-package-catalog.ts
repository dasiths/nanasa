import { createHash } from "node:crypto";
import {
  type CapabilityDeclaration,
  canonicalJsonBytes,
  canonicalProviderSnapshotBytes,
  digestProviderSnapshot,
  ImmutableAssetReferenceSchema,
  ProviderPackageManifestSchema,
  type ProviderGrant,
  ProviderPackageRecordSchema,
  ResolvedProviderAdapterSnapshotSchema,
} from "@nanasa/contracts";
import {
  HOOK_STATUS_REPORTER_SOURCE,
  OPENCODE_STATUS_REPORTER_SOURCE,
  OPENCODE_TUI_STATUS_REPORTER_SOURCE,
  PI_STATUS_REPORTER_SOURCE,
} from "../status-reporter-assets.js";
import type { TrustedBuiltInProviderPackage } from "./builtin-provider-packages.js";
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
  resolveProviderAdapter,
} from "./resolved-provider-adapter.js";

const BUILTIN_TIMESTAMP = "2026-09-01T00:00:00.000Z";
const BUILTIN_PACKAGE_VERSION = "1.0.0";
const READ_ONLY_SOURCE = `export default function (pi) {\n  const blocked = new Set(["bash", "edit", "write"]);\n  pi.on("tool_call", (event) => {\n    if (blocked.has(event.toolName)) return { block: true, reason: "The active Nanasa role is read-only", terminate: true };\n  });\n}\n`;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function capability(
  id: CapabilityDeclaration["id"],
  payload: unknown,
  options: {
    readonly requires?: CapabilityDeclaration["requires"];
  } = {},
): CapabilityDeclaration {
  return {
    id,
    required: true,
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

interface BuiltInSpec {
  readonly providerId: "claude-code" | "pi" | "opencode";
  readonly displayName: string;
  readonly description: string;
  readonly adapterId: string;
  readonly driverId: string;
  readonly assets: readonly ProviderAssetContent[];
  readonly capabilities: readonly CapabilityDeclaration[];
  readonly grants: readonly ProviderGrant[];
  readonly reporterSourceAssetDigest: string;
}

function assetReferences(assets: readonly ProviderAssetContent[]) {
  return assets.map((asset) =>
    ImmutableAssetReferenceSchema.parse({
      path: asset.path,
      mediaType: asset.mediaType,
      bytes: providerAssetBytes(asset).byteLength,
      digest: asset.digest,
    }),
  );
}

async function buildTrustedBuiltin(spec: BuiltInSpec): Promise<TrustedBuiltInProviderPackage> {
  const assets = assetReferences(spec.assets);
  const extensionId = `nanasa.${spec.providerId}`;
  const extensionGeneration = `${extensionId}@${BUILTIN_PACKAGE_VERSION}+builtin.1`;
  const packageDigest = sha256(
    canonicalJsonBytes({
      providerId: spec.providerId,
      capabilities: spec.capabilities,
      requestedGrants: spec.grants,
      assets,
    }),
  );
  const manifestDigest = sha256(
    canonicalJsonBytes({
      packageDigest,
      capabilities: spec.capabilities,
      requestedGrants: spec.grants,
      assets,
    }),
  );
  const generation = {
    id: extensionGeneration,
    extensionId,
    version: BUILTIN_PACKAGE_VERSION,
    packageDigest,
    manifestDigest,
    publisherId: "nanasa",
    namespaceClaims: [spec.providerId],
  };
  const unsignedManifest = {
    apiVersion: "nanasa.dev/provider-extension/v2" as const,
    kind: "ProviderExtension" as const,
    generation,
    displayName: spec.displayName,
    description: spec.description,
    providerId: spec.providerId,
    capabilities: spec.capabilities,
    requestedGrants: spec.grants,
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
  const compatibility = spec.capabilities.find((item) => item.id === "compatibility")?.payload as {
    providerBinary: string;
  };
  const body = {
    formatVersion: 2 as const,
    manifestProtocol: { major: 2, minor: 0 },
    adapterProtocol: { major: 2, minor: 0 },
    packageDigest,
    providerId: spec.providerId,
    adapterId: spec.adapterId,
    extensionId,
    extensionGeneration,
    interpreterVersions: { core: "2.0.0" },
    capabilities: negotiated.capabilities,
    grants: negotiated.grants,
    assets,
    providerBinaryCompatibility: {
      state: "compatible" as const,
      range: compatibility.providerBinary,
    },
  };
  const canonicalBytes = canonicalProviderSnapshotBytes(body);
  const snapshot = ResolvedProviderAdapterSnapshotSchema.parse({
    digest: await digestProviderSnapshot(body),
    canonicalBytes: Buffer.from(canonicalBytes).toString("base64url"),
    body: JSON.parse(Buffer.from(canonicalBytes).toString("utf8")),
  });
  const assetRegistry = new ProviderAssetRegistry(spec.assets);
  const resolved = await resolveProviderAdapter(snapshot, assetRegistry);
  const reporter = negotiated.capabilities.find((item) => item.id === "reporter")?.payload as {
    protocolMajor: number;
    sourceId: string;
  };
  const reporterDriver: ProviderReporterDriver = {
    driverId: spec.driverId,
    protocolMajor: reporter.protocolMajor,
    sourceId: reporter.sourceId,
    reporterVersion: "2",
    sourceAssetDigest: spec.reporterSourceAssetDigest,
  };
  return Object.freeze({
    packageRecord,
    snapshot: Object.freeze({
      digest: snapshot.digest,
      canonicalBytes: snapshot.canonicalBytes,
      body: resolved.body,
    }),
    resolved,
    reporterDrivers: new ProviderReporterDriverRegistry(assetRegistry, [reporterDriver]),
  });
}

function baseCapabilities(input: {
  readonly providerId: BuiltInSpec["providerId"];
  readonly adapterId: string;
  readonly configuredCommandMatchers: readonly Record<string, unknown>[];
  readonly observedProcessMatchers: readonly Record<string, unknown>[];
  readonly launch: Record<string, unknown>;
  readonly state: Record<string, unknown>;
  readonly prompt: Record<string, unknown>;
  readonly mcp: Record<string, unknown>;
  readonly reporter: Record<string, unknown>;
  readonly promptCodecId: string;
  readonly models: Record<string, unknown>;
  readonly sessions: Record<string, unknown>;
  readonly credentialSlot: Record<string, unknown>;
  readonly semanticStatus: Record<string, unknown>;
  readonly screenManifestDigest: string;
  readonly healthBinaryNames: readonly string[];
  readonly providerBinary: string;
}): readonly CapabilityDeclaration[] {
  const events = (input.reporter.events as readonly string[]) ?? [];
  return [
    capability("identity", {
      publisherId: "nanasa",
      providerId: input.providerId,
      extensionId: `nanasa.${input.providerId}`,
      adapterId: input.adapterId,
      ownedNamespaces: [input.providerId],
    }),
    capability("recognition", {
      configuredCommandMatchers: input.configuredCommandMatchers,
      observedProcessMatchers: input.observedProcessMatchers,
      maximumWrapperDepth: input.providerId === "claude-code" ? 1 : 0,
    }),
    capability("launch", input.launch),
    capability("state", input.state),
    capability("prompt", input.prompt),
    capability("mcp", input.mcp),
    capability("reporter", {
      protocolMajor: 3,
      fieldsByEvent: Object.fromEntries(events.map((event) => [event, []])),
      readinessEvents: ["session.ready"],
      sequencing: "monotonic",
      permanentRejectionCodes: ["status_reporter_identity_fenced", "status_native_session_fenced"],
      ...input.reporter,
    }),
    capability("control", {
      operations: [
        {
          operationId: "terminal.prompt",
          kind: "prompt",
          transport: "terminal",
          codecId: input.promptCodecId,
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
    capability("models", input.models),
    capability("sessions", input.sessions),
    capability("credentials", {
      providerManaged: true,
      slots: [input.credentialSlot],
    }),
    capability("semantic-status", input.semanticStatus),
    capability(
      "screen",
      {
        manifestDigest: input.screenManifestDigest,
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
      binaryNames: input.healthBinaryNames,
      requiredReporterEvents: events,
    }),
    capability("compatibility", {
      nanasa: ">=0.1.0-next.11 <0.2.0",
      rpcMajors: [],
      providerBinary: input.providerBinary,
      operatingSystems: ["linux"],
      architectures: ["x64", "arm64"],
    }),
  ];
}

function grants(input: {
  readonly providerId: BuiltInSpec["providerId"];
  readonly capabilities: readonly CapabilityDeclaration[];
  readonly recipeIds: readonly string[];
  readonly executableNames: readonly string[];
  readonly slotId: string;
  readonly targetNames: readonly string[];
}): readonly ProviderGrant[] {
  const events = (
    input.capabilities.find((item) => item.id === "reporter")?.payload as { events: string[] }
  ).events;
  return [
    {
      permission: "provider-state.read-managed",
      parameters: { scopes: ["membership", "integration", "custom"] },
    },
    {
      permission: "provider-state.write-owned",
      parameters: { recipeIds: [...input.recipeIds] },
    },
    { permission: "runtime.launch", parameters: { executableNames: [...input.executableNames] } },
    {
      permission: "network.connect",
      parameters: { origins: ["http://127.0.0.1", "https://127.0.0.1"] },
    },
    {
      permission: "reporter.emit",
      parameters: { sourceId: input.providerId, events },
    },
    {
      permission: "terminal.operate",
      parameters: {
        operationIds: ["terminal.prompt", "terminal.wait-reply", "terminal.interrupt"],
      },
    },
    {
      permission: "credential.inject",
      parameters: { slotIds: [input.slotId], targetNames: [...input.targetNames] },
    },
  ];
}

function assetByPath(assets: readonly ProviderAssetContent[], path: string): ProviderAssetContent {
  const asset = assets.find((candidate) => candidate.path === path);
  if (asset === undefined) throw new Error(`Missing built-in asset ${path}`);
  return asset;
}

const CLAUDE_ASSETS = Object.freeze([
  createAsset(
    "builtin/claude-code/reporter-source-v2",
    "text/javascript",
    "literal",
    HOOK_STATUS_REPORTER_SOURCE,
  ),
  createAsset(
    "builtin/claude-code/hooks-manifest-v1",
    "application/json",
    "claude-hooks-manifest",
    {
      hooks: [
        { hook: "SessionStart", event: "SessionStart" },
        { hook: "UserPromptSubmit", event: "UserPromptSubmit" },
        { hook: "PreToolUse", event: "PreToolUse", matcher: "*" },
        { hook: "PermissionRequest", event: "PermissionRequest", matcher: "*" },
        { hook: "PostToolUse", event: "PostToolUse", matcher: "*" },
        { hook: "PostToolUseFailure", event: "PostToolUseFailure", matcher: "*" },
        { hook: "Stop", event: "Stop" },
        { hook: "StopFailure", event: "StopFailure" },
        { hook: "PreCompact", event: "PreCompact" },
        { hook: "PostCompact", event: "PostCompact" },
        { hook: "Elicitation", event: "Elicitation" },
        { hook: "ElicitationResult", event: "ElicitationResult" },
        { hook: "SessionEnd", event: "SessionEnd" },
      ],
    },
  ),
  createAsset("builtin/claude-code/mcp-config-v1", "application/json", "claude-mcp-config", {
    type: "http",
    authorization: "Bearer ${NANASA_MCP_TOKEN}",
  }),
  createAsset("builtin/claude-code/prompt-v1", "text/markdown", "plain-prompt", {
    placement: "append-system-prompt-file",
  }),
  createAsset(
    "builtin/claude-code/screen-manifest-2026.07.07.1",
    "application/json",
    "screen-manifest",
    {
      id: "claude-code",
      version: "2026.07.07.1",
      source: "herdr-adapted",
      noMatch: "no-claim",
      rules: [
        {
          id: "permission_form",
          priority: 400,
          claim: "blocked",
          visibleBlocker: true,
          region: "prompt-box",
          any: ["allow", "deny", "permission"],
        },
        {
          id: "prompt_box_idle",
          priority: 200,
          claim: "idle",
          visibleIdle: true,
          region: "prompt-box",
          any: [">", "❯"],
        },
        {
          id: "spinner_working",
          priority: 100,
          claim: "working",
          visibleWorking: true,
          region: "osc-progress",
          any: ["working", "thinking"],
        },
      ],
    },
  ),
]);

const CLAUDE_EVENTS = [
  "session.ready",
  "turn.started",
  "turn.settled",
  "tool.started",
  "tool.finished",
  "tool.failed",
  "wait.opened",
  "wait.closed",
  "compaction.started",
  "compaction.finished",
  "failure.observed",
  "session.ended",
];

function claudeSpec(): BuiltInSpec {
  const reporterAsset = assetByPath(CLAUDE_ASSETS, "builtin/claude-code/reporter-source-v2");
  const hooksAsset = assetByPath(CLAUDE_ASSETS, "builtin/claude-code/hooks-manifest-v1");
  const mcpAsset = assetByPath(CLAUDE_ASSETS, "builtin/claude-code/mcp-config-v1");
  const promptAsset = assetByPath(CLAUDE_ASSETS, "builtin/claude-code/prompt-v1");
  const screenAsset = assetByPath(
    CLAUDE_ASSETS,
    "builtin/claude-code/screen-manifest-2026.07.07.1",
  );
  const capabilities = baseCapabilities({
    providerId: "claude-code",
    adapterId: "nanasa.claude-code-v2",
    configuredCommandMatchers: [
      {
        executableNames: ["claude", "claude.exe"],
        requiredArgvLiterals: [],
        wrapperExecutableNames: [],
      },
      {
        executableNames: ["claude-copilot"],
        requiredArgvLiterals: ["claude-copilot"],
        wrapperExecutableNames: ["make"],
      },
    ],
    observedProcessMatchers: [
      {
        executableNames: ["claude", "claude.exe"],
        requiredArgvLiterals: [],
        wrapperExecutableNames: [],
      },
    ],
    launch: {
      executableSlot: "configured-command",
      argumentTemplate: [
        "overlay:claude-settings",
        "optional:claude-mcp",
        "optional:claude-prompt",
        "optional:claude-session",
        "optional:claude-model",
      ],
      wrapperArgumentSlot: 2,
      wrapperArgumentPrefix: "CLAUDE_ARGS=",
      environmentNames: ["CLAUDE_CONFIG_DIR"],
      files: [
        {
          recipeId: "claude.reporter.source",
          relativePath: "reporters/status-hook.mjs",
          mode: "private-file",
          assetDigest: reporterAsset.digest,
        },
        {
          recipeId: "claude.settings",
          relativePath: "settings.json",
          mode: "private-file",
          assetDigest: hooksAsset.digest,
        },
        {
          recipeId: "claude.mcp.config",
          relativePath: "mcp.json",
          mode: "private-file",
          assetDigest: mcpAsset.digest,
        },
        {
          recipeId: "claude.prompt.system",
          relativePath: "prompts/system.md",
          mode: "private-file",
          assetDigest: promptAsset.digest,
        },
      ],
      directExec: true,
    },
    state: {
      scopes: ["membership", "integration", "custom"],
      defaultScope: "membership",
      environmentNames: ["CLAUDE_CONFIG_DIR"],
      environmentPaths: { CLAUDE_CONFIG_DIR: "{stateRoot}" },
      cacheSubdirectories: [],
      formatVersion: "claude-code-state-v1",
      sharing: "integration-explicit",
    },
    prompt: {
      placement: "argument-file",
      identityTemplateId: "claude.prompt.system",
      includesRoleContext: true,
      readOnlyFloor: ["Edit", "Write", "Bash"],
      maximumBytes: 262_144,
    },
    mcp: {
      registration: "argument-file",
      endpointPlaceholder: "NANASA_MCP_URL",
      tokenPlaceholder: "NANASA_MCP_TOKEN",
      loopbackOnly: true,
      fileRecipeId: "claude.mcp.config",
    },
    reporter: {
      driverId: "claude-hooks",
      sourceId: "claude-code",
      reporterVersion: "2",
      sourceAssetDigest: reporterAsset.digest,
      events: CLAUDE_EVENTS,
      waitTransports: ["terminal"],
      rootSessionPolicy: "single",
    },
    promptCodecId: "nanasa.carriage-return",
    models: {
      identifierPattern: "^[^\\s\\0]{1,256}$",
      launchTemplate: ["--model", "{model}"],
      effectiveEvidence: [],
      resumePolicy: "preserve-session",
    },
    sessions: {
      referenceKinds: ["id"],
      maximumReferenceBytes: 4_096,
      normalizationVersion: "claude-session-id-v1",
      dedupeVersion: "provider-kind-value-v1",
      resumeArgumentTemplate: ["--resume", "{reference}"],
    },
    credentialSlot: {
      slotId: "provider-credentials",
      optional: true,
      targetNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
    },
    semanticStatus: {
      policyId: "claude-code.semantic-status-v1",
      authorityOrder: ["reporter", "screen", "osc", "process"],
      processOnlyProjection: "running",
      maximumHintConfidence: "medium",
      turnCycle: "reporter-root",
      thresholdsMs: { startup: 30_000, model: 120_000, tool: 120_000 },
    },
    screenManifestDigest: screenAsset.digest,
    healthBinaryNames: ["claude", "claude.exe"],
    providerBinary: ">=2.1.220 <3.0.0",
  });
  return {
    providerId: "claude-code",
    displayName: "Claude Code",
    description: "Trusted Nanasa built-in adapter for Claude Code",
    adapterId: "nanasa.claude-code-v2",
    driverId: "claude-hooks",
    assets: CLAUDE_ASSETS,
    capabilities,
    grants: grants({
      providerId: "claude-code",
      capabilities,
      recipeIds: [
        "claude.reporter.source",
        "claude.settings",
        "claude.mcp.config",
        "claude.prompt.system",
      ],
      executableNames: ["claude", "claude.exe", "make"],
      slotId: "provider-credentials",
      targetNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
    }),
    reporterSourceAssetDigest: reporterAsset.digest,
  };
}

const PI_ASSETS = Object.freeze([
  createAsset(
    "builtin/pi/reporter-source-v3",
    "text/javascript",
    "literal",
    PI_STATUS_REPORTER_SOURCE,
  ),
  createAsset("builtin/pi/read-only-source-v1", "text/javascript", "literal", READ_ONLY_SOURCE),
  createAsset("builtin/pi/mcp-config-v1", "application/json", "pi-mcp-config", {
    directTools: true,
    hostConfigDiscovery: "off",
    protocolVersion: "auto",
    lifecycle: "lazy",
  }),
  createAsset(
    "builtin/pi/mcp-adapter-2.18.0",
    "application/vnd.nanasa.runtime-asset+json",
    "pi-mcp-adapter",
    { packageName: "pi-mcp-adapter", packageVersion: "2.18.0", entrypoint: "index.ts" },
  ),
  createAsset("builtin/pi/prompt-v1", "text/markdown", "plain-prompt", {
    placement: "append-system-prompt",
  }),
  createAsset("builtin/pi/screen-manifest-2026.07.07.1", "application/json", "screen-manifest", {
    id: "pi",
    version: "2026.07.07.1",
    source: "herdr-adapted",
    noMatch: "no-claim",
    rules: [
      {
        id: "working_literal",
        priority: 100,
        claim: "working",
        visibleWorking: true,
        region: "whole-recent",
        any: ["Working..."],
      },
    ],
  }),
]);

const PI_EVENTS = [
  "session.ready",
  "turn.started",
  "turn.settled",
  "tool.started",
  "tool.finished",
  "tool.failed",
  "compaction.started",
  "compaction.finished",
  "session.ended",
  "heartbeat",
];

function piSpec(): BuiltInSpec {
  const reporterAsset = assetByPath(PI_ASSETS, "builtin/pi/reporter-source-v3");
  const readOnlyAsset = assetByPath(PI_ASSETS, "builtin/pi/read-only-source-v1");
  const mcpAsset = assetByPath(PI_ASSETS, "builtin/pi/mcp-config-v1");
  const mcpAdapterAsset = assetByPath(PI_ASSETS, "builtin/pi/mcp-adapter-2.18.0");
  const promptAsset = assetByPath(PI_ASSETS, "builtin/pi/prompt-v1");
  const screenAsset = assetByPath(PI_ASSETS, "builtin/pi/screen-manifest-2026.07.07.1");
  const capabilities = baseCapabilities({
    providerId: "pi",
    adapterId: "nanasa.pi-v2",
    configuredCommandMatchers: [
      { executableNames: ["pi", "pi.exe"], requiredArgvLiterals: [], wrapperExecutableNames: [] },
    ],
    observedProcessMatchers: [
      { executableNames: ["pi", "pi.exe"], requiredArgvLiterals: [], wrapperExecutableNames: [] },
    ],
    launch: {
      executableSlot: "configured-command",
      argumentTemplate: [
        "overlay:pi-reporter",
        "optional:pi-mcp",
        "optional:pi-prompt",
        "optional:pi-read-only",
        "optional:pi-session",
        "optional:pi-model",
      ],
      environmentNames: ["PI_CODING_AGENT_DIR"],
      files: [
        {
          recipeId: "pi.reporter.source",
          relativePath: "extensions/status.mjs",
          mode: "private-file",
          assetDigest: reporterAsset.digest,
        },
        {
          recipeId: "pi.mcp.config",
          relativePath: "mcp.json",
          mode: "private-file",
          assetDigest: mcpAsset.digest,
        },
        {
          recipeId: "pi.prompt.system",
          relativePath: "prompts/system.md",
          mode: "private-file",
          assetDigest: promptAsset.digest,
        },
        {
          recipeId: "pi.read-only.source",
          relativePath: "extensions/read-only.mjs",
          mode: "private-file",
          assetDigest: readOnlyAsset.digest,
        },
      ],
      directExec: true,
    },
    state: {
      scopes: ["membership", "integration", "custom"],
      defaultScope: "membership",
      environmentNames: ["PI_CODING_AGENT_DIR"],
      environmentPaths: { PI_CODING_AGENT_DIR: "{stateRoot}" },
      cacheSubdirectories: [],
      formatVersion: "pi-state-v1",
      sharing: "integration-explicit",
    },
    prompt: {
      placement: "argument-file",
      identityTemplateId: "pi.prompt.system",
      includesRoleContext: true,
      readOnlyFloor: ["bash", "edit", "write"],
      maximumBytes: 262_144,
    },
    mcp: {
      registration: "generated-config",
      endpointPlaceholder: "NANASA_MCP_URL",
      tokenPlaceholder: "NANASA_MCP_TOKEN",
      loopbackOnly: true,
      fileRecipeId: "pi.mcp.config",
      adapterAssetDigest: mcpAdapterAsset.digest,
    },
    reporter: {
      driverId: "pi-extension",
      sourceId: "pi",
      reporterVersion: "2",
      sourceAssetDigest: reporterAsset.digest,
      events: PI_EVENTS,
      waitTransports: ["terminal"],
      rootSessionPolicy: "qualified-root",
    },
    promptCodecId: "nanasa.carriage-return",
    models: {
      identifierPattern: "^[^\\s\\0]{1,256}$",
      launchTemplate: ["--model", "{model}"],
      effectiveEvidence: [],
      resumePolicy: "preserve-session",
    },
    sessions: {
      referenceKinds: ["id", "state-contained-path"],
      maximumReferenceBytes: 4_096,
      normalizationVersion: "pi-session-reference-v1",
      dedupeVersion: "provider-kind-value-v1",
      resumeArgumentTemplate: ["--session", "{reference}"],
    },
    credentialSlot: {
      slotId: "provider-credentials",
      optional: true,
      targetNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"],
    },
    semanticStatus: {
      policyId: "pi.semantic-status-v1",
      authorityOrder: ["reporter", "screen", "process"],
      processOnlyProjection: "running",
      maximumHintConfidence: "medium",
      turnCycle: "reporter-root",
      thresholdsMs: { startup: 30_000, model: 120_000, tool: 120_000 },
    },
    screenManifestDigest: screenAsset.digest,
    healthBinaryNames: ["pi", "pi.exe"],
    providerBinary: ">=0.83.0 <1.0.0",
  });
  return {
    providerId: "pi",
    displayName: "Pi",
    description: "Trusted Nanasa built-in adapter for Pi",
    adapterId: "nanasa.pi-v2",
    driverId: "pi-extension",
    assets: PI_ASSETS,
    capabilities,
    grants: grants({
      providerId: "pi",
      capabilities,
      recipeIds: ["pi.reporter.source", "pi.mcp.config", "pi.prompt.system", "pi.read-only.source"],
      executableNames: ["pi", "pi.exe"],
      slotId: "provider-credentials",
      targetNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"],
    }),
    reporterSourceAssetDigest: reporterAsset.digest,
  };
}

const OPENCODE_ASSETS = Object.freeze([
  createAsset(
    "builtin/opencode/reporter-source-v3",
    "text/javascript",
    "literal",
    OPENCODE_STATUS_REPORTER_SOURCE,
  ),
  createAsset(
    "builtin/opencode/tui-reporter-source-v1",
    "text/javascript",
    "literal",
    OPENCODE_TUI_STATUS_REPORTER_SOURCE,
  ),
  createAsset("builtin/opencode/tui-config-v1", "application/json", "opencode-tui-config", {
    plugin: ["./nanasa-tui-session.js"],
  }),
  createAsset("builtin/opencode/managed-config-v1", "application/json", "opencode-managed-config", {
    reporterDiscovery: "plugins/nanasa-status.js",
    rootSessionOwnership: "tui-selected",
  }),
  createAsset("builtin/opencode/prompt-v1", "text/markdown", "plain-prompt", {
    placement: "generated-agent",
  }),
  createAsset(
    "builtin/opencode/screen-manifest-2026.07.07.1",
    "application/json",
    "screen-manifest",
    {
      id: "opencode",
      version: "2026.07.07.1",
      source: "herdr-adapted",
      noMatch: "no-claim",
      rules: [
        {
          id: "permission_ui",
          priority: 300,
          claim: "blocked",
          visibleBlocker: true,
          region: "whole-recent",
          any: ["permission", "allow once", "deny"],
        },
        {
          id: "interrupt_hint",
          priority: 200,
          claim: "working",
          visibleWorking: true,
          region: "whole-recent",
          any: ["esc interrupt", "ctrl+c"],
        },
        {
          id: "progress_bar",
          priority: 100,
          claim: "working",
          visibleWorking: true,
          region: "whole-recent",
          any: ["━━", "progress"],
        },
      ],
    },
  ),
]);

const OPENCODE_EVENTS = [
  "session.ready",
  "turn.started",
  "turn.settled",
  "tool.started",
  "tool.finished",
  "tool.failed",
  "wait.opened",
  "wait.closed",
  "retry.observed",
  "failure.observed",
  "session.ended",
  "heartbeat",
];

function openCodeSpec(): BuiltInSpec {
  const reporterAsset = assetByPath(OPENCODE_ASSETS, "builtin/opencode/reporter-source-v3");
  const tuiAsset = assetByPath(OPENCODE_ASSETS, "builtin/opencode/tui-reporter-source-v1");
  const tuiConfigAsset = assetByPath(OPENCODE_ASSETS, "builtin/opencode/tui-config-v1");
  const managedAsset = assetByPath(OPENCODE_ASSETS, "builtin/opencode/managed-config-v1");
  const promptAsset = assetByPath(OPENCODE_ASSETS, "builtin/opencode/prompt-v1");
  const screenAsset = assetByPath(OPENCODE_ASSETS, "builtin/opencode/screen-manifest-2026.07.07.1");
  const capabilities = baseCapabilities({
    providerId: "opencode",
    adapterId: "nanasa.opencode-v2",
    configuredCommandMatchers: [
      {
        executableNames: ["opencode", "opencode.exe"],
        requiredArgvLiterals: [],
        wrapperExecutableNames: [],
      },
    ],
    observedProcessMatchers: [
      {
        executableNames: ["opencode", "opencode.exe"],
        requiredArgvLiterals: [],
        wrapperExecutableNames: [],
      },
    ],
    launch: {
      executableSlot: "configured-command",
      argumentTemplate: [
        "overlay:opencode-reporter",
        "optional:opencode-prompt",
        "optional:opencode-session",
        "optional:opencode-model",
      ],
      environmentNames: [
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_TUI_CONFIG",
      ],
      files: [
        {
          recipeId: "opencode.reporter.source",
          relativePath: "plugins/nanasa-status.js",
          mode: "private-file",
          assetDigest: reporterAsset.digest,
        },
        {
          recipeId: "opencode.tui.source",
          relativePath: "nanasa-tui-session.js",
          mode: "private-file",
          assetDigest: tuiAsset.digest,
        },
        {
          recipeId: "opencode.tui.config",
          relativePath: "tui.jsonc",
          mode: "private-file",
          assetDigest: tuiConfigAsset.digest,
        },
        {
          recipeId: "opencode.prompt.system",
          relativePath: "prompts/system.md",
          mode: "private-file",
          assetDigest: promptAsset.digest,
        },
        {
          recipeId: "opencode.managed.config",
          relativePath: "managed-config.json",
          mode: "private-file",
          assetDigest: managedAsset.digest,
        },
      ],
      directExec: true,
    },
    state: {
      scopes: ["membership", "integration", "custom"],
      defaultScope: "membership",
      environmentNames: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"],
      environmentPaths: {
        XDG_CONFIG_HOME: "{stateRoot}/xdg-config",
        XDG_DATA_HOME: "{stateRoot}/xdg-data",
        XDG_STATE_HOME: "{stateRoot}/xdg-state",
        XDG_CACHE_HOME: "{stateRoot}/xdg-cache",
      },
      cacheSubdirectories: ["xdg-cache"],
      formatVersion: "opencode-xdg-v1",
      sharing: "integration-explicit",
    },
    prompt: {
      placement: "generated-agent",
      identityTemplateId: "opencode.prompt.system",
      includesRoleContext: true,
      readOnlyFloor: ["edit", "bash"],
      maximumBytes: 262_144,
    },
    mcp: {
      registration: "managed-environment",
      endpointPlaceholder: "NANASA_MCP_URL",
      tokenPlaceholder: "NANASA_MCP_TOKEN",
      loopbackOnly: true,
    },
    reporter: {
      driverId: "opencode-plugin",
      sourceId: "opencode",
      reporterVersion: "2",
      sourceAssetDigest: reporterAsset.digest,
      events: OPENCODE_EVENTS,
      waitTransports: ["terminal"],
      rootSessionPolicy: "qualified-root",
    },
    promptCodecId: "nanasa.carriage-return",
    models: {
      identifierPattern: "^[^\\s\\0]{1,256}$",
      launchTemplate: ["--model", "{model}"],
      effectiveEvidence: [],
      resumePolicy: "preserve-session",
    },
    sessions: {
      referenceKinds: ["id"],
      maximumReferenceBytes: 4_096,
      normalizationVersion: "opencode-root-session-id-v1",
      dedupeVersion: "provider-kind-value-v1",
      resumeArgumentTemplate: ["--session", "{reference}"],
    },
    credentialSlot: {
      slotId: "provider-credentials",
      optional: true,
      targetNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    },
    semanticStatus: {
      policyId: "opencode.semantic-status-v1",
      authorityOrder: ["reporter", "screen", "process"],
      processOnlyProjection: "running",
      maximumHintConfidence: "medium",
      turnCycle: "reporter-root",
      thresholdsMs: { startup: 30_000, retry: 180_000, model: 120_000, tool: 120_000 },
    },
    screenManifestDigest: screenAsset.digest,
    healthBinaryNames: ["opencode", "opencode.exe"],
    providerBinary: ">=1.18.15 <2.0.0",
  });
  return {
    providerId: "opencode",
    displayName: "OpenCode",
    description: "Trusted Nanasa built-in adapter for OpenCode",
    adapterId: "nanasa.opencode-v2",
    driverId: "opencode-plugin",
    assets: OPENCODE_ASSETS,
    capabilities,
    grants: grants({
      providerId: "opencode",
      capabilities,
      recipeIds: [
        "opencode.reporter.source",
        "opencode.tui.source",
        "opencode.tui.config",
        "opencode.prompt.system",
        "opencode.managed.config",
      ],
      executableNames: ["opencode", "opencode.exe"],
      slotId: "provider-credentials",
      targetNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    }),
    reporterSourceAssetDigest: reporterAsset.digest,
  };
}

export function piMcpAdapterAssetDigest(builtIn: TrustedBuiltInProviderPackage): string {
  const mcp = builtIn.snapshot.body.capabilities.find((item) => item.id === "mcp")?.payload as {
    adapterAssetDigest?: string;
  };
  if (mcp.adapterAssetDigest === undefined) throw new Error("Pi MCP adapter asset is unavailable");
  return mcp.adapterAssetDigest;
}

export function buildTrustedBuiltinClaudeCodePackage(): Promise<TrustedBuiltInProviderPackage> {
  return buildTrustedBuiltin(claudeSpec());
}

export function buildTrustedBuiltinPiPackage(): Promise<TrustedBuiltInProviderPackage> {
  return buildTrustedBuiltin(piSpec());
}

export function buildTrustedBuiltinOpenCodePackage(): Promise<TrustedBuiltInProviderPackage> {
  return buildTrustedBuiltin(openCodeSpec());
}
