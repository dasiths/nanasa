import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AttachmentPty } from "../src/terminal/attachment-pty.js";

const available = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const runtime = available ? describe : describe.skip;

runtime("AttachmentPty", () => {
  it("uses a disposable PTY and leaves no tmux attachment orphan after close", async () => {
    const server = `nanasa-pty-${process.pid}-${Date.now()}`;
    spawnSync("tmux", [
      "-L",
      server,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "nanasa-view-test",
      "cat",
    ]);
    const run = {
      id: "test",
      groupId: "test",
      memberId: "test",
      agentProfileId: "console",
      generation: 1,
      status: "running" as const,
      desiredState: "running" as const,
      recoveryPhase: "idle" as const,
      recoveryAttempts: 0,
      launchKind: "fresh" as const,
      requestedModelSource: "provider-default" as const,
      startedAt: new Date().toISOString(),
      terminal: { serverName: server, sessionId: "$1", windowId: "@1", paneId: "%1" },
    };
    // The production view name is deterministic from run ID; use it to create the attachment target.
    const { terminalViewSessionName } = await import("../src/terminal/terminal-input-arbiter.js");
    spawnSync("tmux", [
      "-L",
      server,
      "-f",
      "/dev/null",
      "rename-session",
      "-t",
      "nanasa-view-test",
      terminalViewSessionName(run.id),
    ]);
    const pty = new AttachmentPty(run, "controller", { cols: 80, rows: 24 });
    expect(pty.pid).toBeGreaterThan(0);
    pty.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const clients = spawnSync(
      "tmux",
      ["-L", server, "-f", "/dev/null", "list-clients", "-F", "#{client_pid}"],
      { encoding: "utf8" },
    );
    expect(clients.stdout.trim()).toBe("");
    spawnSync("tmux", ["-L", server, "-f", "/dev/null", "kill-server"]);
  });
});
