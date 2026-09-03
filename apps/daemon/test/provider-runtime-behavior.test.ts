import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GeneratedOverlayTransaction } from "../src/generated-overlay-transaction.js";
import { NativeSessionService } from "../src/native-session-service.js";
import { ProviderStateLifecycle } from "../src/provider-state-lifecycle.js";
import { ProviderStateRepository } from "../src/provider-state-repository.js";
import { RepositoryTrustService } from "../src/repository-trust-service.js";
import { NanasaStore } from "../src/store.js";
import { UserCredentialBroker } from "../src/user-credential-broker.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nanasa-provider-runtime-"));
  roots.push(root);
  return root;
}

describe("provider state and generated overlays", () => {
  it("isolates membership state and requires explicit integration sharing", () => {
    const base = join(temporaryRoot(), "integrations");
    const store = new NanasaStore(":memory:");
    const states = new ProviderStateRepository(base, store);
    try {
      const first = states.resolve({
        membershipId: "agent_one",
        integrationId: "copilot",
        policy: { scope: "membership" },
        credentialReference: { kind: "provider-managed" },
      });
      const second = states.resolve({
        membershipId: "agent_two",
        integrationId: "copilot",
        policy: { scope: "membership" },
        credentialReference: { kind: "provider-managed" },
      });
      const markerPath = join(first.storageReference, "retained-state.json");
      writeFileSync(markerPath, '{"preference":"provider-owned"}\n', { mode: 0o600 });
      const firstReplacement = states.resolve({
        membershipId: "agent_one",
        integrationId: "copilot",
        policy: { scope: "membership" },
        credentialReference: { kind: "provider-managed" },
      });
      const shared = states.resolve({
        membershipId: "agent_one",
        integrationId: "pi",
        policy: { scope: "integration" },
        credentialReference: { kind: "provider-managed" },
      });
      const sharedAgain = states.resolve({
        membershipId: "agent_two",
        integrationId: "pi",
        policy: { scope: "integration" },
        credentialReference: { kind: "provider-managed" },
      });
      expect(second.storageReference).not.toBe(first.storageReference);
      expect(firstReplacement.storageReference).toBe(first.storageReference);
      expect(readFileSync(markerPath, "utf8")).toBe('{"preference":"provider-owned"}\n');
      expect(sharedAgain.storageReference).toBe(shared.storageReference);
      expect(statSync(first.storageReference).mode & 0o777).toBe(0o700);
      const lifecycle = new ProviderStateLifecycle(states, new GeneratedOverlayTransaction(base));
      expect(() => lifecycle.deleteOwnedState(shared.id, new Set())).toThrow("still referenced");
    } finally {
      store.close();
    }
  });

  it("commits ownership atomically and refuses drifted removal", () => {
    const overlays = new GeneratedOverlayTransaction(join(temporaryRoot(), "integrations"));
    const committed = overlays.commit("binding-one", 1, "1.0.0", [
      {
        relativePath: "reporters/status.mjs",
        content: "export default {};\n",
        ownerKind: "reporter",
      },
    ]);
    expect(statSync(join(committed.root, "reporters/status.mjs")).mode & 0o777).toBe(0o600);
    writeFileSync(join(committed.root, "reporters/status.mjs"), "operator content\n");
    expect(overlays.detectDrift("binding-one")).toEqual(["reporters/status.mjs"]);
    expect(overlays.removeConservatively("binding-one")).toBe(false);
    expect(readFileSync(join(committed.root, "reporters/status.mjs"), "utf8")).toBe(
      "operator content\n",
    );
  });
});

describe("provider credentials and trust", () => {
  it("delivers only named broker references and redacts secrets", () => {
    const broker = new UserCredentialBroker({
      environment: { WORK_TOKEN: "top-secret" },
      profiles: {
        work: {
          provider: "copilot",
          source: "environment",
          sourceEnvironment: "WORK_TOKEN",
          targetEnvironment: "GH_TOKEN",
        },
      },
    });
    expect(
      broker.resolve({ kind: "broker-profile", profileId: "work" }, "copilot", ["GH_TOKEN"])
        .environment,
    ).toEqual({ GH_TOKEN: "top-secret" });
    expect(broker.redact({ authorization: "Bearer top-secret" })).toEqual({
      authorization: "[REDACTED]",
    });
  });

  it("persists trust only for the exact non-secret launch manifest", () => {
    const store = new NanasaStore(":memory:");
    const trust = new RepositoryTrustService(store);
    const manifest = {
      repositoryIdentity: "repo-one",
      adapterId: "copilot",
      adapterVersion: "1.0.0",
      command: ["copilot"],
      environmentNames: ["GH_TOKEN"],
      credentialReference: { kind: "broker-profile", profileId: "work" } as const,
      generatedIdentities: ["reporters/status.mjs"],
      permissionFloor: "read-only" as const,
      modelResumePolicy: "preserve-session" as const,
    };
    try {
      trust.trust(manifest, "operator-one");
      expect(trust.isTrusted(manifest)).toBe(true);
      expect(trust.isTrusted({ ...manifest, command: ["copilot", "--unsafe"] })).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("canonical native sessions", () => {
  it("confirms a reservation only from the same normalized reference", () => {
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Recovery" });
    const profile = store.createInternalAgentProfile({
      name: "Pi",
      agentType: "pi",
      kind: "pi",
      command: "pi",
      args: [],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "pi.agent",
      agentProfileId: profile.id,
      alias: "Pi",
    });
    const run = store.createRunForMembership(group.id, "pi.agent").run;
    const sessions = new NativeSessionService(store);
    const event = {
      version: 2 as const,
      eventId: "ready-one",
      providerId: "pi",
      adapterId: "pi",
      reporterId: "pi-extension",
      source: "pi" as const,
      protocolVersion: 2 as const,
      reporterVersion: "2",
      runId: run.id,
      generation: run.generation,
      reporterEpoch: "epoch-one",
      sourceSequence: 1,
      event: "session.ready" as const,
      nativeSessionId: "native-one",
      data: {},
    };
    try {
      const observed = sessions.observe({
        memberId: run.memberId,
        integrationId: "pi",
        runId: run.id,
        generation: run.generation,
        reference: {
          provider: "pi",
          source: "pi",
          referenceKind: "id",
          referenceValue: "native-one",
          dedupeHash: "a".repeat(64),
        },
        event,
      });
      expect(sessions.reserve(run.memberId, "pi", run.id)?.session.id).toBe(observed?.id);
      expect(sessions.reserve(run.memberId, "pi", run.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
