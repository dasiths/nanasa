import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKind, AgentProfile, GroupMembership } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntimeProvisioner } from "../src/agent-runtime-provisioner.js";
import { GeneratedOverlayTransaction } from "../src/generated-overlay-transaction.js";
import { NativeSessionService } from "../src/native-session-service.js";
import { ProviderStateLifecycle } from "../src/provider-state-lifecycle.js";
import { ProviderStateRepository } from "../src/provider-state-repository.js";
import { ProviderAdapterRegistry } from "../src/providers/provider-adapter-registry.js";
import { RepositoryTrustService } from "../src/repository-trust-service.js";
import { NanasaStore } from "../src/store.js";
import { UserCredentialBroker } from "../src/user-credential-broker.js";

const roots: string[] = [];
const timestamp = "2026-08-29T12:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "nanasa-provider-adapter-"));
  roots.push(value);
  return value;
}

function profile(kind: AgentKind, agentType = kind): AgentProfile {
  return {
    id: "agent_one",
    name: "Agent One",
    agentType,
    kind,
    command: kind === "claude-code" ? "claude" : kind,
    args: [],
    workingDirectory: "/repo",
    environment: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function membership(id = "agent_one"): GroupMembership {
  return {
    id,
    groupId: "group_one",
    memberId: "provider.agent",
    agentProfileId: "agent_one",
    alias: "Agent One",
    state: "active",
    joinedAt: timestamp,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function filesBeneath(path: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...filesBeneath(child));
    else result.push(child);
  }
  return result;
}

describe("closed provider adapter interfaces", () => {
  it("freezes metadata and supplies provider-native resume argv without replacing wrappers", () => {
    const adapters = ProviderAdapterRegistry.builtIn({ piMcpAdapterPath: "/runtime/pi-mcp.mjs" });
    expect(adapters.list().map((adapter) => adapter.id)).toEqual([
      "copilot",
      "claude-code",
      "pi",
      "opencode",
    ]);
    for (const adapter of adapters.list()) {
      expect(Object.isFrozen(adapter.reporter)).toBe(true);
      expect(Object.isFrozen(adapter.reporter.coverage)).toBe(true);
      expect(Object.isFrozen(adapter.reporter.events)).toBe(true);
      expect(Object.isFrozen(adapter.control)).toBe(true);
      const reference = adapter.normalizeNativeSession(
        { source: adapter.reporter.source, referenceKind: "id", referenceValue: "session-123" },
        "/state",
      );
      const argv = adapter.resumeArguments(reference);
      expect(argv).toEqual(
        adapter.id === "copilot"
          ? ["--resume=session-123"]
          : adapter.id === "claude-code"
            ? ["--resume", "session-123"]
            : ["--session", "session-123"],
      );
      expect(Object.isFrozen(argv)).toBe(true);
    }
  });

  it("declares exact reporter coverage and only executable controls", () => {
    const capabilities = Object.fromEntries(
      ProviderAdapterRegistry.builtIn({ piMcpAdapterPath: "/runtime/pi-mcp.mjs" })
        .list()
        .map((adapter) => [
          adapter.id,
          {
            events: adapter.reporter.events,
            coverage: adapter.reporter.coverage,
            waitReplyChannels: adapter.control.waitReplyChannels,
            supportsPromptAcknowledgement: adapter.control.supportsPromptAcknowledgement,
            supportsCancellation: adapter.control.supportsCancellation,
          },
        ]),
    );
    for (const capability of Object.values(capabilities)) {
      expect(capability.events).toContain("session.ready");
      expect(capability.events).toContain("session.ended");
      expect(capability.coverage.effectiveModel).toBe(false);
      expect(capability.coverage.actionCorrelation).toBe(false);
      expect(capability.waitReplyChannels).toEqual(["terminal"]);
      expect(capability.supportsPromptAcknowledgement).toBe(false);
      expect(capability.supportsCancellation).toBe(false);
    }
    expect(capabilities.pi.coverage.waits).toBe(false);
    expect(capabilities.pi.events).not.toContain("wait.opened");
    expect(capabilities.opencode.events).toContain("retry.observed");
    expect(capabilities["claude-code"].events).toContain("compaction.finished");
  });

  it("validates Pi paths inside state and rejects external or malformed references", () => {
    const adapter = ProviderAdapterRegistry.builtIn().get("pi");
    expect(
      adapter.normalizeNativeSession(
        { source: "pi", referenceKind: "path", referenceValue: "/state/sessions/one.json" },
        "/state",
      ).referenceKind,
    ).toBe("path");
    expect(() =>
      adapter.normalizeNativeSession(
        { source: "pi", referenceKind: "path", referenceValue: "/outside/one.json" },
        "/state",
      ),
    ).toThrow("inside provider state");
    expect(() =>
      adapter.normalizeNativeSession(
        { source: "pi", referenceKind: "id", referenceValue: "bad\nvalue" },
        "/state",
      ),
    ).toThrow("malformed");
  });
});

describe("durable provider state and generated overlay transactions", () => {
  it("defaults to isolated membership paths and makes integration sharing explicit", () => {
    const base = join(root(), "integrations");
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
      const sharedOne = states.resolve({
        membershipId: "agent_one",
        integrationId: "pi",
        policy: { scope: "integration" },
        credentialReference: { kind: "provider-managed" },
      });
      const sharedTwo = states.resolve({
        membershipId: "agent_two",
        integrationId: "pi",
        policy: { scope: "integration" },
        credentialReference: { kind: "provider-managed" },
      });
      expect(first.storageReference).toContain("/state/members/agent_one/copilot");
      expect(second.storageReference).not.toBe(first.storageReference);
      expect(sharedTwo.id).not.toBe(sharedOne.id);
      expect(sharedTwo.storageReference).toBe(sharedOne.storageReference);
      expect(statSync(first.storageReference).mode & 0o777).toBe(0o700);
      expect(states.list()).toHaveLength(4);
      const lifecycle = new ProviderStateLifecycle(states, new GeneratedOverlayTransaction(base));
      expect(() => lifecycle.deleteOwnedState(sharedOne.id, new Set())).toThrow("still referenced");
    } finally {
      store.close();
    }
  });

  it("commits with fsynced ownership, rolls back staging, detects drift, and removes conservatively", () => {
    const base = join(root(), "integrations");
    const overlays = new GeneratedOverlayTransaction(base);
    const first = overlays.commit("binding-one", 1, "1.0.0", [
      {
        relativePath: "reporters/status.mjs",
        content: "export default {};\n",
        ownerKind: "reporter",
      },
      { relativePath: "policy/deny.json", content: "{}\n", ownerKind: "deny-floor" },
    ]);
    expect(first.ledger.entries).toHaveLength(2);
    expect(statSync(join(first.root, "reporters/status.mjs")).mode & 0o777).toBe(0o600);

    const failing = new GeneratedOverlayTransaction(base, {
      beforeLedgerCommit: () => {
        throw new Error("simulated commit failure");
      },
    });
    expect(() =>
      failing.commit("binding-one", 2, "1.0.0", [
        {
          relativePath: "reporters/status.mjs",
          content: "export default 2;\n",
          ownerKind: "reporter",
        },
      ]),
    ).toThrow("simulated commit failure");
    expect(overlays.readLedger("binding-one")?.revision).toBe(1);
    expect(readFileSync(join(first.root, "reporters/status.mjs"), "utf8")).toContain("default {}");

    writeFileSync(join(first.root, "reporters/status.mjs"), "operator content\n");
    expect(overlays.detectDrift("binding-one")).toEqual(["reporters/status.mjs"]);
    expect(overlays.removeConservatively("binding-one")).toBe(false);
    expect(() =>
      overlays.commit("binding-one", 2, "1.0.0", [
        { relativePath: "reporters/status.mjs", content: "new\n", ownerKind: "reporter" },
      ]),
    ).toThrow("drift detected");

    writeFileSync(join(first.root, "reporters/status.mjs"), "export default {};\n");
    writeFileSync(join(first.root, "unknown.txt"), "operator-owned\n");
    expect(overlays.detectDrift("binding-one")).toContain("unknown.txt");
    expect(overlays.removeConservatively("binding-one")).toBe(false);
  });
});

describe("credentials, trust, model precedence, and MCP-independent provisioning", () => {
  it("delivers only named broker references and redacts credential-shaped values", () => {
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
    const delivery = broker.resolve({ kind: "broker-profile", profileId: "work" }, "copilot", [
      "GH_TOKEN",
    ]);
    expect(delivery.environment).toEqual({ GH_TOKEN: "top-secret" });
    expect(broker.describe({ kind: "broker-profile", profileId: "work" })).not.toHaveProperty(
      "value",
    );
    expect(
      broker.redact({ authorization: "Bearer top-secret", nested: { apiKey: "top-secret" } }),
    ).toEqual({ authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]" } });
    expect(() =>
      broker.resolve({ kind: "broker-profile", profileId: "work" }, "pi", ["GH_TOKEN"]),
    ).toThrow("does not match");
  });

  it("hashes only material non-secret launch fields and persists explicit trust receipts", () => {
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
      expect(trust.isTrusted(manifest)).toBe(false);
      trust.trust(manifest, "operator-one");
      expect(trust.isTrusted(manifest)).toBe(true);
      expect(trust.isTrusted({ ...manifest, command: ["copilot", "--unsafe"] })).toBe(false);
      expect(trust.isTrusted({ ...manifest, environmentNames: ["GH_TOKEN"] })).toBe(true);
      trust.revoke(manifest, "operator-one");
      expect(trust.isTrusted(manifest)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("builds state, reporter, prompt, deny floor, and model without a public MCP entry", () => {
    const base = join(root(), "integrations");
    const provisioner = new AgentRuntimeProvisioner({
      integrationsDirectory: base,
      integrations: {
        copilot: {
          providerState: { scope: "membership" },
          credentials: { kind: "provider-managed" },
          model: { model: "integration-model", resumePolicy: "preserve-session" },
          nativeRecovery: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
        },
      },
      statusEndpointUrl: "http://127.0.0.1:3210/api/v1/agent-status/events",
      repositoryIdentity: "repo-one",
      desiredModelResolver: () => "membership-model",
      promptResolver: () => ({
        roleId: "reviewer",
        role: { name: "Reviewer", instructions: [], permissionPolicy: "read-only" },
        text: "Review without editing.\n",
        revision: "a".repeat(64),
        sources: [],
      }),
    });
    const result = provisioner.provision(membership(), profile("copilot"));
    expect(result.snapshot.desiredModel).toBe("membership-model");
    expect(result.snapshot.desiredModelSource).toBe("membership");
    expect(result.command).toEqual(
      expect.arrayContaining([
        "--agent",
        expect.stringMatching(/^nanasa-status-reporter:nanasa-[a-f0-9]{16}$/),
        "--model",
        "membership-model",
        "--deny-tool=write",
      ]),
    );
    expect(
      provisioner.resumeCommand(result.snapshot, {
        provider: "copilot",
        source: "copilot",
        referenceKind: "id",
        referenceValue: "native-one",
        dedupeHash: "a".repeat(64),
      }),
    ).not.toContain("membership-model");
    expect(result.command.join(" ")).not.toContain("additional-mcp-config");
    expect(result.command).toEqual(
      expect.arrayContaining([
        "--plugin-dir",
        join(result.snapshot.overlayRoot, "copilot-status-plugin"),
      ]),
    );
    const generated = filesBeneath(result.snapshot.overlayRoot);
    expect(generated.some((path) => path.endsWith("copilot-status-plugin/status-hook.mjs"))).toBe(
      true,
    );
    expect(generated.some((path) => path.endsWith("copilot-status-plugin/plugin.json"))).toBe(true);
    expect(
      generated.some(
        (path) =>
          path.includes("copilot-status-plugin/com.github.copilot/agents/") &&
          path.endsWith(".agent.md"),
      ),
    ).toBe(true);
    expect(
      generated.some((path) =>
        path.endsWith("copilot-status-plugin/com.github.copilot/hooks/hooks.json"),
      ),
    ).toBe(true);
    expect(generated.map((path) => readFileSync(path, "utf8")).join("\n")).not.toContain(
      "top-secret",
    );
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.command)).toBe(true);
  });

  it("generates an OpenCode reporter with a discovered JavaScript extension", () => {
    const overlay = ProviderAdapterRegistry.builtIn().get("opencode").planOverlay({
      membershipId: "agent_one",
      memberAlias: "Agent One",
      stateRoot: "/state",
      overlayRoot: "/overlay",
      statusEndpointUrl: "http://127.0.0.1:3210/api/v1/agent-status/events",
      readOnly: false,
    });

    expect(overlay.generatedIdentities).toContain("plugins/nanasa-status.js");
    expect(overlay.generatedIdentities).not.toContain("plugins/nanasa-status.mjs");
  });

  it("passes Pi's generated MCP config through the adapter's supported flag", () => {
    const overlay = ProviderAdapterRegistry.builtIn({
      piMcpAdapterPath: "/runtime/pi-mcp-adapter/index.ts",
    })
      .get("pi")
      .planOverlay({
        membershipId: "agent_one",
        memberAlias: "Agent One",
        stateRoot: "/state",
        overlayRoot: "/overlay",
        statusEndpointUrl: "http://127.0.0.1:3210/api/v1/agent-status/events",
        mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
        readOnly: false,
      });

    expect(overlay.commandArguments).toEqual(
      expect.arrayContaining([
        "--extension",
        "/runtime/pi-mcp-adapter/index.ts",
        "--mcp-config",
        "/overlay/mcp.json",
      ]),
    );
    expect(overlay.environment).not.toHaveProperty("NANASA_PI_MCP_CONFIG");
  });

  it("shell-quotes Copilot status hook paths", () => {
    const overlayRoot = "/tmp/repo $(touch injected) 'quoted'/overlay";
    const overlay = ProviderAdapterRegistry.builtIn().get("copilot").planOverlay({
      membershipId: "agent_one",
      memberAlias: "Agent One",
      stateRoot: "/state",
      overlayRoot,
      statusEndpointUrl: "http://127.0.0.1:3210/api/v1/agent-status/events",
      readOnly: false,
    });
    const hooks = overlay.files.find((file) => file.relativePath.endsWith("hooks.json"));
    expect(hooks).toBeDefined();
    const parsed = JSON.parse(hooks!.content) as {
      hooks: { sessionStart: Array<{ bash: string }> };
    };
    const reporterPath = join(overlayRoot, "copilot-status-plugin", "status-hook.mjs");

    expect(parsed.hooks.sessionStart[0]?.bash).toBe(
      `${shellQuote(process.execPath)} ${shellQuote(reporterPath)} copilot ${shellQuote("sessionStart")}`,
    );
  });
});

describe("validated and confirmed native sessions", () => {
  it("reserves once and confirms only matching session.ready evidence for the replacement run", () => {
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Recovery" });
    const agent = store.createInternalAgentProfile({
      name: "Pi",
      agentType: "pi",
      kind: "pi",
      command: "pi",
      args: [],
      environment: {},
    });
    store.addMembership(group.id, { memberId: "pi.agent", agentProfileId: agent.id, alias: "Pi" });
    const first = store.createRunForMembership(group.id, "pi.agent").run;
    store.updateRunStatus(first.id, "running");
    const sessions = new NativeSessionService(store);
    const adapter = ProviderAdapterRegistry.builtIn().get("pi");
    try {
      const observed = sessions.observe({
        memberId: "pi.agent",
        integrationId: "pi",
        runId: first.id,
        generation: first.generation,
        adapter,
        stateRoot: "/state",
        event: {
          version: 2,
          eventId: "ready-one",
          providerId: "pi",
          adapterId: "pi",
          reporterId: "pi-extension",
          source: "pi",
          protocolVersion: 2,
          reporterVersion: "2",
          runId: first.id,
          generation: first.generation,
          reporterEpoch: "epoch-one",
          sourceSequence: 1,
          event: "session.ready",
          nativeSessionId: "native-one",
          data: { effectiveModel: "provider/model" },
        },
      });
      expect(observed).toMatchObject({ referenceValue: "native-one", status: "ready" });
      expect(sessions.reserve("pi.agent", "pi", first.id)?.session.id).toBe(observed?.id);
      expect(sessions.reserve("pi.agent", "pi", first.id)).toBeUndefined();

      store.updateRunStatus(first.id, "failed");
      const replacement = store.createRunForMembership(group.id, "pi.agent", {
        recoveryFrom: store.getRun(first.id),
        launchKind: "resuming",
        nativeSessionId: observed!.id,
      }).run;
      sessions.observe({
        memberId: "pi.agent",
        integrationId: "pi",
        runId: replacement.id,
        generation: replacement.generation,
        adapter,
        stateRoot: "/state",
        event: {
          version: 2,
          eventId: "ready-wrong",
          providerId: "pi",
          adapterId: "pi",
          reporterId: "pi-extension",
          source: "pi",
          protocolVersion: 2,
          reporterVersion: "2",
          runId: replacement.id,
          generation: replacement.generation,
          reporterEpoch: "epoch-two",
          sourceSequence: 1,
          event: "session.ready",
          nativeSessionId: "different-native-session",
          data: {},
        },
      });
      expect(sessions.isConfirmed(observed!.id, replacement.id)).toBe(false);
      sessions.observe({
        memberId: "pi.agent",
        integrationId: "pi",
        runId: replacement.id,
        generation: replacement.generation,
        adapter,
        stateRoot: "/state",
        event: {
          version: 2,
          eventId: "ready-two",
          providerId: "pi",
          adapterId: "pi",
          reporterId: "pi-extension",
          source: "pi",
          protocolVersion: 2,
          reporterVersion: "2",
          runId: replacement.id,
          generation: replacement.generation,
          reporterEpoch: "epoch-two",
          sourceSequence: 2,
          event: "session.ready",
          nativeSessionId: "native-one",
          data: { effectiveModel: "provider/model" },
        },
      });
      expect(sessions.isConfirmed(observed!.id, replacement.id)).toBe(true);
      expect(sessions.isConfirmed(observed!.id, first.id)).toBe(false);
    } finally {
      store.close();
    }
  });
});
