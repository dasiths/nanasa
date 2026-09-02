import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, canonicalJsonBytes } from "@nanasa/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNanasaDatabase } from "../src/persistence/database.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { ProviderPackageLifecycleService } from "../src/providers/provider-package-lifecycle-service.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotEvaluator } from "../src/providers/provider-snapshot-evaluator.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";

const now = "2026-09-01T00:00:00.000Z";
let database: DatabaseSync;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

beforeEach(() => {
  database = openNanasaDatabase(":memory:");
});

afterEach(() => database.close());

describe("signed provider package lifecycle", () => {
  it("installs, activates, disables, and revokes a fifth provider without a rebuild", async () => {
    const template = await buildTrustedBuiltinCopilotPackage();
    const capabilities = template.packageRecord.manifest.capabilities.map((capability) => {
      if (capability.id === "identity") {
        return {
          ...capability,
          payload: {
            publisherId: "acme",
            providerId: "acme.fifth",
            extensionId: "acme.fifth",
            adapterId: "acme.fifth-v1",
            ownedNamespaces: ["acme.fifth"],
          },
        };
      }
      if (capability.id === "recognition") {
        return {
          ...capability,
          payload: {
            configuredCommandMatchers: [
              {
                executableNames: ["fifth"],
                requiredArgvLiterals: [],
                wrapperExecutableNames: [],
              },
            ],
            observedProcessMatchers: [
              {
                executableNames: ["fifth"],
                requiredArgvLiterals: [],
                wrapperExecutableNames: [],
              },
            ],
            maximumWrapperDepth: 0,
          },
        };
      }
      if (capability.id === "launch") {
        return {
          ...capability,
          payload: {
            executableSlot: "configured-command",
            argumentTemplate: [],
            environmentNames: [],
            files: [],
            directExec: true,
          },
        };
      }
      if (capability.id === "reporter") {
        return { ...capability, payload: { ...capability.payload, sourceId: "acme.fifth" } };
      }
      if (capability.id === "health") {
        return { ...capability, payload: { ...capability.payload, binaryNames: ["fifth"] } };
      }
      return capability;
    });
    const requestedGrants = template.packageRecord.manifest.requestedGrants
      .filter((grant) => grant.permission !== "provider-state.write-owned")
      .map((grant) => {
        if (grant.permission === "runtime.launch") {
          return { ...grant, parameters: { executableNames: ["fifth"] } };
        }
        if (grant.permission === "reporter.emit") {
          return { ...grant, parameters: { ...grant.parameters, sourceId: "acme.fifth" } };
        }
        return grant;
      });
    const assets = template.packageRecord.manifest.assets;
    const packageDigest = sha256(
      canonicalJsonBytes({
        providerId: "acme.fifth",
        capabilities,
        requestedGrants,
        assets,
      }),
    );
    const manifestDigest = sha256(
      canonicalJsonBytes({ packageDigest, capabilities, requestedGrants, assets }),
    );
    const generation = {
      id: "acme.fifth@1.0.0+catalog.1",
      extensionId: "acme.fifth",
      version: "1.0.0",
      packageDigest,
      manifestDigest,
      publisherId: "acme",
      namespaceClaims: ["acme.fifth"],
    };
    const unsigned = {
      apiVersion: "nanasa.dev/provider-extension/v2" as const,
      kind: "ProviderExtension" as const,
      generation,
      displayName: "Fifth Provider",
      description: "Signed declarative fifth-provider fixture",
      providerId: "acme.fifth",
      capabilities,
      requestedGrants,
      assets,
      antiRollbackSequence: 1,
    };
    const keys = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey).toString(
      "base64url",
    );
    const manifest = {
      ...unsigned,
      signatures: [
        {
          algorithm: "ed25519" as const,
          keyId: "acme-root",
          signature,
          signedAt: now,
        },
      ],
    };
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    const lifecycle = new ProviderPackageLifecycleService(database, snapshots, index, {
      trustKeys: {
        "acme-root": keys.publicKey.export({ type: "spki", format: "pem" }),
      },
      now: () => new Date(now),
    });
    const installed = await lifecycle.importAndActivate({
      manifest,
      assets: template.resolved.assets.list(),
      source: {
        kind: "catalog",
        catalogId: "acme-catalog",
        metadataDigest: "9".repeat(64),
      },
      importedAt: now,
    });
    expect(index.get("acme.fifth")).toMatchObject({
      providerId: "acme.fifth",
      snapshotDigest: installed.snapshot.digest,
      state: "active",
    });
    const evaluator = new ProviderSnapshotEvaluator(installed.resolved, installed.reporterDrivers);
    expect(evaluator.matchesConfiguredCommand(["fifth"])).toBe(true);
    expect(
      evaluator.launch({
        membershipId: "membership-one",
        memberAlias: "Fifth",
        stateRoot: "/state/fifth",
        overlayRoot: "/overlay/fifth",
        statusEndpointUrl: "http://127.0.0.1:3210/status",
        readOnly: false,
        configuredCommand: ["fifth"],
      }).command[0],
    ).toBe("fifth");

    lifecycle.disable("acme.fifth");
    expect(() => index.get("acme.fifth")).toThrow(/not active/);
    lifecycle.rollback("acme.fifth", "2026-09-01T00:00:00.500Z");
    expect(index.get("acme.fifth").snapshotDigest).toBe(installed.snapshot.digest);
    expect(() => lifecycle.assertUninstallable(generation.id)).toThrow(/retained/);
    lifecycle.disable("acme.fifth");
    await expect(
      lifecycle.importAndActivate({
        manifest,
        assets: template.resolved.assets.list(),
        source: {
          kind: "catalog",
          catalogId: "acme-catalog",
          metadataDigest: "9".repeat(64),
        },
        importedAt: now,
      }),
    ).rejects.toThrow(/anti-rollback/);

    lifecycle.rollback("acme.fifth", "2026-09-01T00:00:00.750Z");
    lifecycle.revoke(generation.id, "2026-09-01T00:00:01.000Z");
    expect(() => index.get("acme.fifth")).toThrow(/not active/);
    expect(snapshots.getPackage(generation.id)).toMatchObject({
      state: "revoked",
      revokedAt: "2026-09-01T00:00:01.000Z",
    });
    lifecycle.uninstall(generation.id);
    expect(snapshots.getPackage(generation.id)).toBeUndefined();
    expect(database.prepare("SELECT count(*) AS count FROM provider_snapshots").get()).toEqual({
      count: 0,
    });
    expect(database.prepare("SELECT count(*) AS count FROM provider_assets").get()).toEqual({
      count: 0,
    });
  });
});
