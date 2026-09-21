import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GeneratedOverlayTransaction } from "../src/generated-overlay-transaction.js";
import { openNanasaDatabase } from "../src/persistence/database.js";
import { AgentRuntimeProvisioner } from "../src/provider-runtime-provisioner.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { ProviderBoundRuntimePlanner } from "../src/providers/provider-bound-runtime-planner.js";
import { ProviderOverlayRepository } from "../src/providers/provider-overlay-repository.js";
import { ProviderRunBindingRepository } from "../src/providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";
import { NanasaStore } from "../src/store.js";
import { TmuxRuntime } from "../src/tmux-runtime.js";

describe("TmuxRuntime observations", () => {
  it("launches and reattaches a repository Foreman with native input and exact pane ownership", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-foreman-tmux-"));
    const serverName = `nanasa-foreman-${randomUUID()}`;
    const path = join(directory, "state.sqlite");
    const store = new NanasaStore(path);
    const database = openNanasaDatabase(path);
    const providerPath = join(directory, "provider");
    writeFileSync(
      providerPath,
      "#!/bin/sh\nprintf 'foreman-ready\\n'\nwhile IFS= read -r line; do printf 'response:%s\\n' \"$line\"; done\n",
      { mode: 0o700 },
    );
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    const bindings = new ProviderRunBindingRepository(database, index, snapshots);
    const overlays = new ProviderOverlayRepository(
      database,
      new GeneratedOverlayTransaction(join(directory, "integrations")),
    );
    const provisioner = new AgentRuntimeProvisioner({
      integrationsDirectory: join(directory, "integrations"),
      integrations: {
        copilot: {
          providerState: { scope: "integration" },
          credentials: { kind: "provider-managed" },
          model: { resumePolicy: "preserve-session" },
          nativeRecovery: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
        },
      },
      repositoryIdentity: "repo-one",
      statusEndpointUrl: "http://127.0.0.1:3210/status",
      planner: new ProviderBoundRuntimePlanner(bindings, overlays),
      bindings,
    });
    let runtime = new TmuxRuntime(store, { serverName, runtimeProvisioner: provisioner });
    try {
      await index.registerTrustedBuiltin(await buildTrustedBuiltinCopilotPackage());
      const profile = store.createInternalAgentProfile({
        name: "Foreman",
        agentType: "copilot",
        kind: "copilot",
        command: providerPath,
        args: [],
        environment: {},
      });
      store.upsertForeman({ id: "foreman", agentProfileId: profile.id, enabled: true });
      const owner = {
        id: "foreman",
        name: "Foreman",
        prompt: { text: "Repository coordination", revision: "a".repeat(64), sources: [] },
      };
      const run = await runtime.startForemanRun(owner, { cols: 80, rows: 24 });
      const request = {
        runId: run.id,
        generation: run.generation,
        source: "visible" as const,
        maxLines: 200,
        maxBytes: 65536,
      };
      expect(run).toMatchObject({ foremanId: "foreman", status: "running" });
      expect(store.listActiveRuns()).toEqual([]);
      await expect
        .poll(async () => (await runtime.readTerminal(request)).text)
        .toContain("foreman-ready");
      await runtime.ensureViewSession(run);
      await runtime.pasteToRun(run, "native-input");
      await expect
        .poll(async () => (await runtime.readTerminal(request)).text)
        .toContain("response:native-input");
      await runtime.close();
      runtime = new TmuxRuntime(store, { serverName, runtimeProvisioner: provisioner });
      await runtime.ensureViewSession(store.getRuntimeRun(run.id));
      expect((await runtime.readTerminal(request)).text).toContain("response:native-input");
      await expect(runtime.readTerminal({ ...request, generation: 2 })).rejects.toMatchObject({
        code: "terminal_read_generation_mismatch",
      });
      await runtime.stopForemanRun("foreman");
      const replacement = await runtime.startForemanRun(owner, { cols: 80, rows: 24 });
      expect(replacement.generation).toBe(2);
      spawnSync("tmux", [
        "-L",
        serverName,
        "set-option",
        "-p",
        "-t",
        replacement.terminal!.paneId,
        "@nanasa-run-id",
        "another-run",
      ]);
      await expect(runtime.pasteToRun(replacement, "must-not-arrive")).rejects.toThrow(
        "terminal_owner_pane_mismatch",
      );
      await runtime.stopForemanRun("foreman");
      expect(
        spawnSync("tmux", [
          "-L",
          serverName,
          "display-message",
          "-p",
          "-t",
          replacement.terminal!.paneId,
          "ok",
        ]).status,
      ).toBe(0);
    } finally {
      await runtime.close();
      spawnSync("tmux", ["-L", serverName, "kill-server"]);
      database.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("classifies a missing tmux server as a missing run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-tmux-observation-"));
    const serverName = `nanasa-observation-${randomUUID()}`;
    const store = new NanasaStore(join(directory, "state.sqlite"));
    const providerPath = join(directory, "provider");
    writeFileSync(
      providerPath,
      "#!/bin/sh\nprintf 'ready\\n'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
      { mode: 0o700 },
    );
    chmodSync(providerPath, 0o700);
    const group = store.createGroup({ name: "Observation" });
    const profile = store.createInternalAgentProfile({
      name: "Provider",
      agentType: "pi",
      kind: "pi",
      command: providerPath,
      args: [],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "worker",
      agentProfileId: profile.id,
      alias: "Worker",
    });
    const runtime = new TmuxRuntime(store, { serverName });

    try {
      const run = await runtime.startRun(group.id, "worker", { cols: 80, rows: 24 });
      spawnSync("tmux", ["-L", serverName, "kill-server"]);

      await expect(runtime.observeRun(run)).resolves.toMatchObject({
        state: "missing",
        evidenceCode: "tmux_server_unavailable_1",
      });
    } finally {
      await runtime.close();
      spawnSync("tmux", ["-L", serverName, "kill-server"]);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops only a pane with the exact persisted provider-update ownership tags", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-tmux-update-"));
    const serverName = `nanasa-update-${randomUUID()}`;
    const store = new NanasaStore(join(directory, "state.sqlite"));
    const group = store.createGroup({ name: "Update ownership" });
    const profile = store.createInternalAgentProfile({
      name: "Shell",
      agentType: "pi",
      kind: "pi",
      command: "sh",
      args: ["-c", "while :; do sleep 10; done"],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "worker",
      agentProfileId: profile.id,
      alias: "Worker",
    });
    const runtime = new TmuxRuntime(store, { serverName });

    try {
      const owned = await runtime.startRun(group.id, "worker", { cols: 80, rows: 24 });
      await expect(runtime.inspectProviderUpdatePane(owned)).resolves.toBe("owned");
      await expect(runtime.stopProviderUpdatePane(owned)).resolves.toBe("stopped");
      store.updateRunStatus(owned.id, "failed", { reason: "replaced" });
      const foreign = await runtime.startRun(group.id, "worker", { cols: 80, rows: 24 });
      spawnSync("tmux", [
        "-L",
        serverName,
        "set-option",
        "-p",
        "-t",
        foreign.terminal!.paneId,
        "@nanasa-run-id",
        "another-run",
      ]);

      await expect(runtime.stopProviderUpdatePane(foreign)).resolves.toBe("ownership-uncertain");
      await expect(
        runtime.stopProviderUpdatePane(foreign, { forceIndeterminate: true }),
      ).resolves.toBe("ownership-uncertain");
      expect(
        spawnSync("tmux", [
          "-L",
          serverName,
          "display-message",
          "-p",
          "-t",
          foreign.terminal!.paneId,
          "ok",
        ]).status,
      ).toBe(0);
    } finally {
      await runtime.close();
      spawnSync("tmux", ["-L", serverName, "kill-server"]);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
