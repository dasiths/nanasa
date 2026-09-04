import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NanasaStore } from "../src/store.js";
import { TmuxRuntime } from "../src/tmux-runtime.js";

describe("TmuxRuntime observations", () => {
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
