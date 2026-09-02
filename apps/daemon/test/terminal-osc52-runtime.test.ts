import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NanasaStore } from "../src/store.js";
import { AttachmentPty } from "../src/terminal/attachment-pty.js";
import { TerminalEffectPolicy } from "../src/terminal/terminal-effect-policy.js";
import { TmuxRuntime } from "../src/tmux-runtime.js";

function tmux(serverName: string, args: string[]): string {
  return execFileSync("tmux", ["-L", serverName, "-f", "/dev/null", ...args], {
    encoding: "utf8",
  }).trim();
}

describe("TmuxRuntime OSC 52 passthrough", () => {
  it("enables passthrough only on verified run windows and reasserts it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-osc52-runtime-"));
    const serverName = `nanasa-osc52-${randomUUID()}`;
    const store = new NanasaStore(join(directory, "state.sqlite"));
    const providerPath = join(directory, "provider");
    const encoded = Buffer.from("copied through tmux").toString("base64");
    writeFileSync(
      providerPath,
      `#!/bin/sh
printf 'ready\\n'
while IFS= read -r line; do
  if [ "$line" = copy ]; then
    printf '\\033Ptmux;\\033\\033]52;p!;${encoded};\\007\\033\\\\'
    printf '\\033Ptmux;\\033\\033]52;c;${encoded}\\007\\033\\\\'
  else
    printf '%s\\n' "$line"
  fi
done
`,
      { mode: 0o700 },
    );
    chmodSync(providerPath, 0o700);
    const group = store.createGroup({ name: "OSC 52" });
    const profile = store.createInternalAgentProfile({
      name: "OSC provider",
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
      const binding = run.terminal!;
      await runtime.ensureViewSession(run);

      expect(tmux(serverName, ["show-options", "-w", "-gv", "allow-passthrough"])).toBe("off");
      expect(
        tmux(serverName, ["show-options", "-w", "-v", "-t", binding.windowId, "allow-passthrough"]),
      ).toBe("on");

      const unrelatedWindow = tmux(serverName, [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        binding.sessionId,
        "-n",
        "unrelated",
      ]);
      expect(tmux(serverName, ["show-options", "-w", "-t", unrelatedWindow])).not.toContain(
        "allow-passthrough",
      );

      tmux(serverName, ["set-option", "-w", "-t", binding.windowId, "allow-passthrough", "off"]);
      await runtime.ensureViewSession(run);
      expect(
        tmux(serverName, ["show-options", "-w", "-v", "-t", binding.windowId, "allow-passthrough"]),
      ).toBe("on");

      const attachment = new AttachmentPty(run, "controller", { cols: 80, rows: 24 });
      const policy = new TerminalEffectPolicy();
      let output = "";
      const effects: ReturnType<TerminalEffectPolicy["filter"]>["effects"] = [];
      let resolveReady!: () => void;
      let resolveEffect!: () => void;
      const receivedReady = new Promise<void>((resolve) => (resolveReady = resolve));
      const receivedEffect = new Promise<void>((resolve) => (resolveEffect = resolve));
      const subscription = attachment.onData((data) => {
        const filtered = policy.filter(data, true);
        output += filtered.output;
        effects.push(...filtered.effects);
        if (output.includes("ready")) resolveReady();
        if (effects.length > 0) resolveEffect();
      });
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          receivedReady,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("terminal attachment was not ready")),
              2_000,
            );
          }),
        ]);
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = undefined;
        attachment.write("copy\r");
        await Promise.race([
          receivedEffect,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("wrapped OSC 52 was not received")), 2_000);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        subscription.dispose();
        attachment.close();
      }
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({ data: "copied through tmux", preview: "" });
      expect(output).not.toContain("]52;");
    } finally {
      await runtime.close();
      spawnSync("tmux", ["-L", serverName, "kill-server"]);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps ordinary terminal views working when passthrough is unsupported", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-osc52-degraded-"));
    const serverName = `nanasa-osc52-${randomUUID()}`;
    const store = new NanasaStore(join(directory, "state.sqlite"));
    const providerPath = join(directory, "provider");
    const tmuxPath = join(directory, "tmux");
    writeFileSync(
      providerPath,
      "#!/bin/sh\nprintf 'ready\\n'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
      {
        mode: 0o700,
      },
    );
    writeFileSync(
      tmuxPath,
      `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = allow-passthrough ]; then
    printf 'invalid option: allow-passthrough\\n' >&2
    exit 1
  fi
done
exec tmux "$@"
`,
      { mode: 0o700 },
    );
    chmodSync(providerPath, 0o700);
    chmodSync(tmuxPath, 0o700);
    const group = store.createGroup({ name: "OSC 52 degraded" });
    const profile = store.createInternalAgentProfile({
      name: "Degraded provider",
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
    const runtime = new TmuxRuntime(store, { serverName, tmuxPath });

    try {
      const run = await runtime.startRun(group.id, "worker", { cols: 80, rows: 24 });
      await expect(runtime.ensureViewSession(run)).resolves.toMatch(/^nanasa-view-/);
      expect(
        tmux(serverName, ["list-panes", "-t", run.terminal!.paneId, "-F", "#{pane_dead}"]),
      ).toBe("0");
      expect(tmux(serverName, ["show-options", "-w", "-t", run.terminal!.windowId])).not.toContain(
        "allow-passthrough",
      );
    } finally {
      await runtime.close();
      spawnSync("tmux", ["-L", serverName, "kill-server"]);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
