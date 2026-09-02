import { describe, expect, it } from "vitest";
import {
  assertSameProviderAuthority,
  CapabilityNegotiationError,
  canonicalJson,
  canonicalProviderSnapshotBytes,
  digestProviderSnapshot,
  negotiateProviderCapabilities,
  ProviderGrantSchema,
  ProviderPackageManifestSchema,
  ProviderReporterEventSchema,
  ProviderRpcOperationRequestSchema,
  ProviderStatusClaimSchema,
  parseResolvedProviderAdapterSnapshot,
  parseStrictJson,
  ResolvedProviderAdapterSnapshotBodySchema,
  requireCanonicalJson,
} from "../src/index.js";

const identityPayload = {
  publisherId: "nanasa",
  providerId: "acme.agent",
  extensionId: "acme.agent-adapter",
  adapterId: "acme.agent-v1",
  ownedNamespaces: ["acme.agent"],
};

const identityDeclaration = {
  id: "identity",
  required: true,
  version: { major: 1, minimumMinor: 0, maximumMinor: 2 },
  payload: identityPayload,
  requires: [],
  conflicts: [],
} as const;

const hostIdentity = {
  id: "identity",
  version: { major: 1, minimumMinor: 0, maximumMinor: 1 },
} as const;

const snapshotBody = {
  formatVersion: 2,
  manifestProtocol: { major: 2, minor: 0 },
  adapterProtocol: { major: 2, minor: 0 },
  packageDigest: "a".repeat(64),
  providerId: "acme.agent",
  adapterId: "acme.agent-v1",
  extensionId: "acme.agent-adapter",
  extensionGeneration: "acme.agent-adapter@1.0.0+a",
  interpreterVersions: { core: "2.0" },
  capabilities: [
    {
      id: "identity",
      version: { major: 1, minor: 1 },
      payload: identityPayload,
    },
  ],
  grants: [],
  assets: [],
  providerBinaryCompatibility: { state: "compatible", range: ">=1 <2" },
} as const;

const fence = {
  runId: "run_1",
  generation: 2,
  bindingId: "binding_1",
  providerId: "acme.agent",
  snapshotDigest: "b".repeat(64),
  processIncarnationDigest: "c".repeat(64),
} as const;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

describe("provider target identities and negotiation", () => {
  it("accepts open provider identities and chooses the highest mutual minor", () => {
    expect(negotiateProviderCapabilities([identityDeclaration], [hostIdentity]).selected).toEqual([
      {
        id: "identity",
        version: { major: 1, minor: 1 },
        payload: identityPayload,
      },
    ]);
  });

  it("records unknown optional capabilities and rejects unknown required capabilities", () => {
    const optional = {
      id: "acme.experimental",
      required: false,
      version: { major: 1, minimumMinor: 0, maximumMinor: 0 },
      payload: { ignored: true },
      requires: [],
      conflicts: [],
    } as const;
    expect(
      negotiateProviderCapabilities([identityDeclaration, optional], [hostIdentity])
        .ignoredOptional,
    ).toEqual([{ id: "acme.experimental", reason: "unknown" }]);
    expect(() =>
      negotiateProviderCapabilities(
        [identityDeclaration, { ...optional, required: true }],
        [hostIdentity],
      ),
    ).toThrowError(CapabilityNegotiationError);
  });

  it("rejects ambiguity, missing dependencies, incompatible versions, and unknown fields", () => {
    expect(() =>
      negotiateProviderCapabilities([identityDeclaration, identityDeclaration], [hostIdentity]),
    ).toThrow(/Duplicate capability/);

    const launch = {
      id: "launch",
      required: true,
      version: { major: 1, minimumMinor: 0, maximumMinor: 0 },
      payload: {
        executableSlot: "configured-command",
        argumentTemplate: [],
        environmentNames: [],
        files: [],
        directExec: true,
      },
      requires: [
        {
          id: "state",
          version: { major: 1, minimumMinor: 0, maximumMinor: 0 },
        },
      ],
      conflicts: [],
    } as const;
    expect(() =>
      negotiateProviderCapabilities(
        [identityDeclaration, launch],
        [hostIdentity, { id: "launch", version: { major: 1, minimumMinor: 0, maximumMinor: 0 } }],
      ),
    ).toThrow(/requires state/);
    expect(() =>
      negotiateProviderCapabilities(
        [identityDeclaration],
        [{ ...hostIdentity, version: { major: 2, minimumMinor: 0, maximumMinor: 0 } }],
      ),
    ).toThrow(/compatible major/);
    expect(() =>
      negotiateProviderCapabilities(
        [{ ...identityDeclaration, payload: { ...identityPayload, kind: "legacy" } }],
        [hostIdentity],
      ),
    ).toThrow(/payload is invalid/);
  });

  it("rejects unsafe or unparameterized grants", () => {
    expect(
      ProviderGrantSchema.safeParse({
        permission: "network.connect",
        parameters: { origins: ["https://example.com"] },
      }).success,
    ).toBe(false);
    expect(
      ProviderGrantSchema.safeParse({
        permission: "runtime.launch",
        parameters: { executableNames: ["agent"], unrestricted: true },
      }).success,
    ).toBe(false);
    expect(
      ResolvedProviderAdapterSnapshotBodySchema.safeParse({
        ...snapshotBody,
        grants: [
          {
            permission: "runtime.launch",
            parameters: { executableNames: ["agent"] },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("canonical snapshot bytes", () => {
  it("rejects duplicate JSON keys, noncanonical bytes, malformed Unicode, and non-finite values", () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(/Duplicate object key/);
    expect(() => requireCanonicalJson('{"b":1,"a":2}')).toThrow(/not canonical/);
    expect(() => canonicalJson({ value: "\ud800" })).toThrow(/surrogate/);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/Non-finite/);
  });

  it("normalizes Unicode, key order, and set-like snapshot arrays deterministically", () => {
    expect(canonicalJson({ z: "e\u0301", a: 1 })).toBe('{"a":1,"z":"é"}');
    const parsed = ResolvedProviderAdapterSnapshotBodySchema.parse(snapshotBody);
    const reordered = {
      ...parsed,
      interpreterVersions: { z: "1", core: "2.0", a: "1" },
    };
    const reorderedAgain = {
      ...parsed,
      interpreterVersions: { a: "1", core: "2.0", z: "1" },
    };
    expect(canonicalProviderSnapshotBytes(reordered)).toEqual(
      canonicalProviderSnapshotBytes(reorderedAgain),
    );
  });

  it("verifies that canonical bytes, body, and SHA-256 digest agree", async () => {
    const bytes = canonicalProviderSnapshotBytes(snapshotBody);
    const digest = await digestProviderSnapshot(snapshotBody);
    await expect(
      parseResolvedProviderAdapterSnapshot({
        digest,
        canonicalBytes: base64Url(bytes),
        body: snapshotBody,
      }),
    ).resolves.toMatchObject({ digest });
    await expect(
      parseResolvedProviderAdapterSnapshot({
        digest,
        canonicalBytes: base64Url(new TextEncoder().encode("{}")),
        body: snapshotBody,
      }),
    ).rejects.toThrow(/canonical bytes/);
  });
});

describe("clean target surface contracts", () => {
  it("rejects namespace takeover, executable assets, and unbounded RPC payloads", () => {
    const manifest = {
      apiVersion: "nanasa.dev/provider-extension/v2",
      kind: "ProviderExtension",
      generation: {
        id: "generation_1",
        extensionId: "acme.agent-adapter",
        version: "1.0.0",
        packageDigest: "a".repeat(64),
        manifestDigest: "b".repeat(64),
        publisherId: "acme",
        namespaceClaims: ["acme.agent"],
      },
      displayName: "Acme Agent",
      description: "Fixture",
      providerId: "acme.agent",
      capabilities: [identityDeclaration],
      requestedGrants: [],
      assets: [],
      signatures: [
        {
          algorithm: "ed25519",
          keyId: "acme-key",
          signature: "A".repeat(86),
          signedAt: "2026-09-01T00:00:00Z",
        },
      ],
      antiRollbackSequence: 1,
    } as const;
    expect(ProviderPackageManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      ProviderPackageManifestSchema.safeParse({
        ...manifest,
        providerId: "other.agent",
      }).success,
    ).toBe(false);
    expect(
      ProviderPackageManifestSchema.safeParse({
        ...manifest,
        assets: [
          {
            path: "hooks/status.mjs",
            mediaType: "text/javascript",
            bytes: 1,
            digest: "c".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ProviderRpcOperationRequestSchema.safeParse({
        protocol: "nanasa-provider-rpc.v2",
        type: "execute-operation",
        requestId: "request_1",
        sequence: 1,
        operationId: "session/export",
        idempotencyKey: "export-1",
        fence,
        deadlineAt: "2026-09-01T00:01:00Z",
        targetHandles: ["session_1"],
        input: { unrestricted: { path: "/etc/passwd" } },
      }).success,
    ).toBe(false);
  });

  it("requires open reporter identity plus snapshot and process fences", () => {
    const event = {
      version: 3,
      eventId: "event_1",
      integrationId: "reviewer",
      providerId: "acme.agent",
      adapterId: "acme.agent-v1",
      snapshotDigest: fence.snapshotDigest,
      processIncarnationDigest: fence.processIncarnationDigest,
      reporterSessionId: "reporter_session_1",
      reporterId: "acme-reporter",
      source: "acme.agent",
      reporterEpoch: "epoch_1",
      runId: fence.runId,
      generation: fence.generation,
      sourceSequence: 1,
      event: "turn.started",
      data: {},
    } as const;
    expect(ProviderReporterEventSchema.parse(event).source).toBe("acme.agent");
    expect(
      ProviderReporterEventSchema.safeParse({ ...event, processIncarnationDigest: undefined })
        .success,
    ).toBe(false);
  });

  it("keeps process, screen, and OSC claims within their authority", () => {
    const base = {
      id: "claim_1",
      fence,
      policyDigest: "d".repeat(64),
      sourceId: "observer_1",
      sourceSequence: 1,
      confidence: "medium",
      reasonCode: "observed",
      receivedAt: "2026-09-01T00:00:00Z",
    } as const;
    expect(
      ProviderStatusClaimSchema.safeParse({
        ...base,
        source: "process",
        claimType: "semantic-state",
        semanticState: "idle",
      }).success,
    ).toBe(false);
    expect(
      ProviderStatusClaimSchema.safeParse({
        ...base,
        source: "screen",
        claimType: "outcome",
        outcome: "succeeded",
      }).success,
    ).toBe(false);
  });

  it("rejects cross-snapshot and cross-process authority", () => {
    expect(assertSameProviderAuthority(fence, fence)).toEqual(fence);
    expect(() =>
      assertSameProviderAuthority(fence, { ...fence, snapshotDigest: "f".repeat(64) }),
    ).toThrow(/snapshotDigest/);
    expect(() =>
      assertSameProviderAuthority(fence, {
        ...fence,
        processIncarnationDigest: "f".repeat(64),
      }),
    ).toThrow(/processIncarnationDigest/);
  });
});
