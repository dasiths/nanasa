import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { NanasaStore } from "../src/store.js";
import { TerminalAdapter, TmuxTerminalDelivery } from "../src/terminal-adapter.js";
import { TerminalEndpointRegistry } from "../src/terminal-endpoint-registry.js";
import { TmuxRuntime } from "../src/tmux-runtime.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const tmuxServers: string[] = [];

afterEach(() => {
  for (const serverName of tmuxServers.splice(0)) {
    spawnSync("tmux", ["-L", serverName, "kill-server"], { encoding: "utf8" });
  }
});

function tmux(serverName: string, args: string[]): string {
  const result = spawnSync("tmux", ["-L", serverName, "-f", "/dev/null", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `tmux exited with ${result.status}`);
  }
  return result.stdout;
}

async function waitForPaneText(
  serverName: string,
  paneId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const output = tmux(serverName, ["capture-pane", "-p", "-t", paneId, "-S", "-"]);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)}`);
}

const describeTmux = tmuxAvailable ? describe : describe.skip;

describeTmux("TerminalAdapter", () => {
  it("injects queue text into its owner pane, blocks writers, and sends interrupt", async () => {
    const serverName = `nanasa-terminal-adapter-${process.pid}-${Date.now()}`;
    tmuxServers.push(serverName);
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "Terminal adapter" });
    const fixtureCode = [
      'const readline = require("node:readline");',
      'process.on("SIGINT", () => console.log("INTERRUPTED"));',
      'console.log("READY");',
      'readline.createInterface({ input: process.stdin }).on("line",',
      "  (line) => console.log(`ECHO:${line}`));",
    ].join("");
    const profile = store.createInternalAgentProfile({
      name: "Safe terminal fixture",
      agentType: "test-terminal",
      kind: "opencode",
      adapter: "terminal",
      capabilities: ["queue"],
      command: "node",
      args: ["-e", fixtureCode],
      environment: {},
    });
    const membership = store.addMembership(group.id, {
      memberId: "terminal",
      agentProfileId: profile.id,
      alias: "Terminal",
    });
    const runtime = new TmuxRuntime(store, { serverName });
    const run = await runtime.startRun(group.id, membership.memberId, { cols: 100, rows: 30 });
    const endpoints = new TerminalEndpointRegistry(store);
    const delivery = new TmuxTerminalDelivery(runtime, endpoints);
    const adapter = new TerminalAdapter({ run, profile }, delivery);
    await adapter.start({ run, profile });
    await waitForPaneText(serverName, run.terminal!.paneId, "READY");
    const submission = store.submitMessage(group.id, {
      intent: "request",
      sender: { kind: "operator", operatorId: "operator" },
      audience: { kind: "dm", memberId: membership.memberId },
      body: { contentType: "text/plain", text: "safe terminal delivery" },
      delivery: { mode: "queue" },
      hop: 0,
    });

    const delivered = await adapter.deliver({
      message: submission.message,
      run,
      profile,
      mode: "queue",
    });
    expect(delivered).toEqual({
      appliedMode: "queue",
      adapterMessageId: submission.message.id,
    });
    expect(delivered.settlement).toBeUndefined();
    await waitForPaneText(serverName, run.terminal!.paneId, "ECHO:safe terminal delivery");

    endpoints.begin(run, 1);
    const releaseWriter = endpoints.beginWriter(run.id, 1);
    await expect(
      adapter.deliver({ message: submission.message, run, profile, mode: "queue" }),
    ).rejects.toThrow("terminal_writer_conflict");
    releaseWriter();

    await adapter.interrupt();
    await waitForPaneText(serverName, run.terminal!.paneId, "INTERRUPTED");
    tmux(serverName, ["kill-pane", "-t", run.terminal!.paneId]);
    await expect(
      adapter.deliver({ message: submission.message, run, profile, mode: "queue" }),
    ).rejects.toThrow(/terminal_owner_pane_(?:unavailable|mismatch)/);

    await adapter.close();
    await runtime.close();
    store.close();
  });
});
