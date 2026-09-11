import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForemanRunSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { ConfigRepository } from "../src/config-repository.js";
import {
  ForemanRuntimeService,
  type ForemanRuntimeServiceOptions,
} from "../src/foreman-runtime-service.js";
import { GeneratedOverlayTransaction } from "../src/generated-overlay-transaction.js";
import { AgentRuntimeProvisioner } from "../src/provider-runtime-provisioner.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { ProviderBoundRuntimePlanner } from "../src/providers/provider-bound-runtime-planner.js";
import { ProviderOverlayRepository } from "../src/providers/provider-overlay-repository.js";
import { ProviderRunBindingRepository } from "../src/providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";
import { runtimeObservation } from "../src/runtime-observation.js";
import { NanasaStore } from "../src/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nanasa-foreman-service-"));
  mkdirSync(join(root, ".nanasa"));
  writeFileSync(
    join(root, ".nanasa", "config.yaml"),
    "version: 2\nintegrations:\n  copilot:\n    name: Copilot\n    kind: copilot\nforeman:\n  integrationId: copilot\n  enabled: true\ngroups: {}\n",
  );
  const config = new ConfigRepository(root);
  const store = new NanasaStore(":memory:");
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const snapshots = new ProviderSnapshotRepository(store.database);
  const index = new ProviderRuntimeIndex(store.database, snapshots);
  await index.registerTrustedBuiltin(await buildTrustedBuiltinCopilotPackage());
  const bindings = new ProviderRunBindingRepository(store.database, index, snapshots);
  const integrationsDirectory = join(root, ".nanasa", "integrations");
  const overlays = new ProviderOverlayRepository(
    store.database,
    new GeneratedOverlayTransaction(integrationsDirectory),
  );
  const integration = config.load().config.integrations.copilot!;
  const provisioner = new AgentRuntimeProvisioner({
    integrationsDirectory,
    integrations: { copilot: integration },
    statusEndpointUrl: "http://127.0.0.1:3210/status",
    repositoryIdentity: "repo-one",
    planner: new ProviderBoundRuntimePlanner(bindings, overlays),
    bindings,
  });
  const runtime: ForemanRuntimeServiceOptions["runtime"] = {
    startForemanRun: vi.fn(async (owner) => {
      const { run, profile } = store.createRunForForeman(owner.id);
      await provisioner.provisionForForeman(run, owner, profile);
      return ForemanRunSchema.parse(
        store.updateRuntimeRunStatus(run.id, "running", {
          terminal: { serverName: "test", sessionId: "$1", windowId: "@1", paneId: "%1" },
        }),
      );
    }),
    stopForemanRun: vi.fn(async (id) => {
      const run = store.getActiveForemanRun(id)!;
      store.updateRuntimeRunStatus(run.id, "stopping");
      return ForemanRunSchema.parse(store.updateRuntimeRunStatus(run.id, "stopped"));
    }),
    observeRun: vi.fn(async (run) =>
      runtimeObservation(run, "indeterminate", { evidenceCode: "test-indeterminate" }),
    ),
    ensureViewSession: vi.fn(async () => "view-one"),
  };
  const options = {
    store,
    config,
    runtime,
    bindings,
    mcpEnabled: true,
    allowAutonomous: false,
    allowProviderFiles: false,
  };
  const service = new ForemanRuntimeService(options);
  return { service, options, config, store, runtime, revision: config.load().status.revision! };
}

describe("Foreman runtime service", () => {
  it("recovers a confirmed lost Foreman with recorded native state and fences explicit stop", async () => {
    const context = await fixture();
    const run = await context.service.start(context.revision);
    const native = {
      provider: "copilot",
      source: "copilot",
      referenceKind: "id",
      referenceValue: "native-session",
      dedupeHash: "a".repeat(64),
    };
    context.store.database
      .prepare(
        "INSERT INTO foreman_native_sessions (foreman_id, run_id, generation, reference_json, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(run.foremanId, run.id, run.generation, JSON.stringify(native), new Date().toISOString());
    vi.mocked(context.runtime.observeRun).mockImplementation(async (current) =>
      runtimeObservation(current, "missing", { evidenceCode: "confirmed-missing" }),
    );
    await context.service.reconcile();
    expect(context.service.status().run?.status).toBe("failed");
    await context.service.reconcile();
    expect(context.runtime.startForemanRun).toHaveBeenCalledTimes(2);
    expect(vi.mocked(context.runtime.startForemanRun).mock.calls[1]?.[2]).toEqual(native);
    const replacement = context.service.status().run!;
    expect(replacement).toMatchObject({
      generation: 2,
      launchKind: "resuming",
      recoveryPhase: "resuming",
      recoveryAttempts: 1,
    });
    context.store.updateRuntimeRunStatus(replacement.id, "failed");
    await context.service.stop({ runId: replacement.id, generation: replacement.generation });
    await context.service.reconcile();
    expect(context.runtime.startForemanRun).toHaveBeenCalledTimes(2);
    expect(context.service.status().run?.desiredState).toBe("stopped");
  });

  it("retains the Foreman circuit breaker across reconciliations", async () => {
    const context = await fixture();
    const run = await context.service.start(context.revision);
    context.store.updateRuntimeRunStatus(run.id, "failed");
    context.store.database
      .prepare(
        "INSERT INTO foreman_recovery (foreman_id, attempts, next_allowed_at, updated_at) VALUES (?, 3, ?, ?)",
      )
      .run(run.foremanId, "2000-01-01T00:00:00Z", new Date().toISOString());
    const replacementService = new ForemanRuntimeService(context.options);
    await replacementService.reconcile();
    await replacementService.reconcile();
    expect(replacementService.status().problem).toContain("recovery limit");
    expect(context.runtime.startForemanRun).toHaveBeenCalledTimes(1);
  });

  it("starts from repository configuration, serializes lifecycle, and reuses a private profile", async () => {
    const context = await fixture();
    const run = await context.service.start(context.revision);
    expect(run).toMatchObject({
      foremanId: "repository-foreman",
      status: "running",
      generation: 1,
    });
    expect(context.store.listActiveRuns()).toEqual([]);
    await expect(context.service.start(context.revision)).rejects.toMatchObject({
      code: "run_already_active",
    });
    await expect(
      context.service.configure(context.config.load().config.foreman!, context.revision),
    ).rejects.toMatchObject({ code: "foreman_must_stop" });
    await context.service.stop();
    expect(context.service.status().run?.desiredState).toBe("stopped");
    const replacement = await context.service.start(context.revision);
    expect(replacement).toMatchObject({ generation: 2, agentProfileId: run.agentProfileId });
    await context.service.close();
  });

  it("requires current revision, enabled configuration, MCP, and supported launch consent", async () => {
    const context = await fixture();
    await expect(context.service.start("stale")).rejects.toMatchObject({
      code: "config_revision_conflict",
    });
    await expect(
      new ForemanRuntimeService({ ...context.options, mcpEnabled: false }).start(context.revision),
    ).rejects.toMatchObject({ code: "foreman_mcp_required" });
    const disabled = await context.service.configure(
      { ...context.config.load().config.foreman!, enabled: false },
      context.revision,
    );
    await expect(context.service.start(disabled.configRevision!)).rejects.toMatchObject({
      code: "foreman_not_enabled",
    });
    const configPath = join(context.config.load().repoRoot, ".nanasa", "config.yaml");
    const document = parseDocument(readFileSync(configPath, "utf8"));
    document.setIn(["foreman", "enabled"], true);
    document.setIn(["integrations", "copilot", "command"], ["sh", "custom-provider"]);
    document.setIn(["integrations", "copilot", "launcher"], { providerArguments: "append" });
    writeFileSync(configPath, document.toString());
    await expect(
      context.service.start(context.config.load().status.revision!),
    ).rejects.toMatchObject({ code: "foreman_launch_consent_required" });
    expect(context.runtime.startForemanRun).not.toHaveBeenCalled();
    expect(context.store.listForemen()).toEqual([]);
  });

  it("does not restart indeterminate processes and fences confirmed missing ones", async () => {
    const context = await fixture();
    const run = await context.service.start(context.revision);
    const reopened = new ForemanRuntimeService(context.options);
    await reopened.reconcile();
    expect(context.store.getActiveForemanRun(run.foremanId)?.id).toBe(run.id);
    expect(context.runtime.startForemanRun).toHaveBeenCalledTimes(1);
    vi.mocked(context.runtime.observeRun).mockResolvedValue(
      runtimeObservation(run, "missing", { evidenceCode: "test-missing" }),
    );
    await reopened.reconcile();
    expect(context.service.status().run?.status).toBe("failed");
    expect(context.store.getActiveForemanRun(run.foremanId)).toBeUndefined();
    expect(context.runtime.startForemanRun).toHaveBeenCalledTimes(1);
  });

  it("stops the active generation after an external configuration change", async () => {
    const context = await fixture();
    await context.service.start(context.revision);
    await context.config.mutate((config) => ({
      config: { ...config, foreman: { ...config.foreman!, enabled: false } },
      result: undefined,
    }));
    await context.service.reconcile();
    expect(context.runtime.stopForemanRun).toHaveBeenCalledOnce();
    expect(context.service.status()).toMatchObject({
      actor: { enabled: false },
      run: { status: "stopped" },
    });
  });
});
