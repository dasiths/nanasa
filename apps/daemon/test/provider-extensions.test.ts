import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NanasaConfig } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { loadNanasaConfig } from "../src/config-loader.js";
import { ExtensionLockRepository } from "../src/extensions/extension-lock-repository.js";
import { descriptorDigest } from "../src/extensions/extension-package-loader.js";
import { ProviderCatalogService } from "../src/extensions/provider-catalog-service.js";
import { ProviderExtensionPlanner } from "../src/extensions/provider-extension-planner.js";
import { ProviderExtensionService } from "../src/extensions/provider-extension-service.js";
import { ProviderHealthService } from "../src/extensions/provider-health-service.js";
import { NanasaStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nanasa-provider-extensions-"));
  temporaryDirectories.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  mkdirSync(join(root, ".nanasa"));
  writeFileSync(
    join(root, ".nanasa", "config.yaml"),
    `version: 2
integrations:
  copilot:
    name: Copilot
    kind: copilot
    command: [node]
    cwd: .
groups:
  team:
    name: Team
    agents:
      agent:
        memberId: member
        name: Agent
        integrationId: copilot
`,
  );
  const locks = new ExtensionLockRepository(root);
  const catalog = new ProviderCatalogService();
  const planner = new ProviderExtensionPlanner();
  const store = new NanasaStore(":memory:", { config: loadNanasaConfig(root).config });
  const read = (): { config: NanasaConfig; revision: string } => {
    const loaded = loadNanasaConfig(root);
    return { config: loaded.config, revision: loaded.status.revision! };
  };
  const health = new ProviderHealthService(locks, read, "0.0.0");
  const service = new ProviderExtensionService(
    locks,
    catalog,
    planner,
    health,
    read,
    store,
    "a".repeat(64),
  );
  service.initializeBuiltIns();
  return { root, locks, store, service, health };
}

describe("declarative provider extension lifecycle", () => {
  it("routes built-ins through descriptors, a reproducible lock, trust, plan, and health", () => {
    const { locks, store, service } = fixture();
    const item = service
      .list()
      .find((candidate) => candidate.descriptor.metadata.id === "nanasa.copilot");
    expect(item).toMatchObject({ installed: true, enabled: true, signatureState: "builtin" });
    expect(item?.health.state).toBe("current");
    expect(locks.read().extensions["nanasa.copilot"]?.source).toEqual({
      kind: "builtin",
      name: "nanasa.copilot",
    });
    expect(service.inspect("nanasa.copilot").plan.permissions).not.toContain("*");
    service.assertProviderKind("copilot");
    store.close();
  });

  it("invalidates trust and stale lock revisions after a command-plan change", () => {
    const { root, locks, store, service } = fixture();
    const plan = service.plan("nanasa.copilot");
    writeFileSync(
      join(root, ".nanasa", "config.yaml"),
      `version: 2
integrations:
  copilot:
    name: Copilot
    kind: copilot
    command: [node, changed]
    cwd: .
groups: {}
`,
    );
    expect(() =>
      service.trust("nanasa.copilot", "operator", {
        planDigest: plan.planDigest,
        configRevision: plan.configRevision,
      }),
    ).toThrowError(expect.objectContaining({ code: "extension_plan_stale" }));
    expect(() =>
      service.disable("nanasa.copilot", { expectedLockRevision: locks.read().revision - 1 }),
    ).toThrowError(expect.objectContaining({ code: "extension_lock_revision_stale" }));
    store.close();
  });

  it("retains rollback state and blocks referenced removal and active-run mutation", () => {
    const { locks, store, service } = fixture();
    const initialRevision = locks.read().revision;
    const initialPlan = service.plan("nanasa.copilot");
    const installed = service.install("nanasa.copilot", {
      planDigest: initialPlan.planDigest,
      configRevision: initialPlan.configRevision,
      expectedLockRevision: initialRevision,
    });
    expect(installed.catalog.health.rollbackAvailable).toBe(true);
    const rolledBack = service.rollback("nanasa.copilot", {
      expectedLockRevision: installed.plan.lockRevision,
    });
    expect(rolledBack.catalog.health.rollbackAvailable).toBe(true);
    const disabled = service.disable("nanasa.copilot", {
      expectedLockRevision: rolledBack.plan.lockRevision,
    });
    expect(disabled.catalog.health.state).toBe("disabled");
    expect(() =>
      service.remove("nanasa.copilot", { expectedLockRevision: locks.read().revision }),
    ).toThrowError(expect.objectContaining({ code: "extension_referenced" }));

    const group = store.createGroup({ name: "Runtime team" });
    const profile = store.createInternalAgentProfile({
      name: "Copilot",
      agentType: "copilot",
      kind: "copilot",
      command: "node",
      args: [],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "member",
      agentProfileId: profile.id,
      alias: "Agent",
    });
    store.createRunForMembership(group.id, "member");
    expect(() =>
      service.disable("nanasa.copilot", { expectedLockRevision: locks.read().revision }),
    ).toThrowError(expect.objectContaining({ code: "extension_active_runs" }));
    store.close();
  });

  it("classifies a missing immutable package as repairable drift", () => {
    const { locks, store, health } = fixture();
    const current = locks.read();
    const builtin = current.extensions["nanasa.copilot"]!;
    locks.mutate(current.revision, (lock) => {
      const descriptor = {
        ...builtin.descriptor,
        metadata: { ...builtin.descriptor.metadata, id: "example.copilot" },
      };
      return {
        ...lock,
        revision: lock.revision + 1,
        extensions: {
          ...lock.extensions,
          "example.copilot": {
            ...builtin,
            descriptor,
            descriptorDigest: descriptorDigest(descriptor),
            source: { kind: "uploaded", label: "missing fixture package" },
            packageReference: "/missing/provider/package",
          },
        },
      };
    });
    const drift = health.inspect("example.copilot");
    expect(drift).toMatchObject({ state: "drifted", repairable: true });
    store.close();
  });
});
