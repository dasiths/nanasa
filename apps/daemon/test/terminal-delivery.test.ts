import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { NanasaStore } from "../src/store.js";
import { formatTerminalDelivery, TmuxTerminalDelivery } from "../src/terminal-delivery.js";
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

function createFixture(store: NanasaStore, name: string) {
  const group = store.createGroup({ name });
  const fixtureCode = [
    'const readline = require("node:readline");',
    "console.log(`READY:${process.env.NANASA_ROLE}`);",
    'readline.createInterface({ input: process.stdin }).on("line",',
    "  (line) => console.log(`ECHO:${line}`));",
  ].join("");
  const profile = store.createInternalAgentProfile({
    name: "Safe terminal fixture",
    agentType: "test-terminal",
    kind: "opencode",
    command: "node",
    args: ["-e", fixtureCode],
    environment: { NANASA_ROLE: "direct" },
  });
  const membership = store.addMembership(group.id, {
    memberId: "terminal",
    agentProfileId: profile.id,
    alias: "Terminal",
  });
  return { group, membership };
}

const describeTmux = tmuxAvailable ? describe : describe.skip;

describeTmux("TmuxTerminalDelivery", () => {
  it("preserves console view sessions during agent-run reconciliation", async () => {
    const serverName = `nanasa-console-view-${process.pid}-${Date.now()}`;
    tmuxServers.push(serverName);
    const store = new NanasaStore(":memory:");
    const runtime = new TmuxRuntime(store, { serverName });
    const run = await runtime.startConsole("console-test", process.cwd(), {
      cols: 100,
      rows: 30,
    });
    const viewSession = await runtime.ensureViewSession(run);

    await runtime.removeStaleViewSessions(new Set());
    expect(
      spawnSync(
        "tmux",
        ["-L", serverName, "-f", "/dev/null", "has-session", "-t", `=${viewSession}`],
        { encoding: "utf8" },
      ).status,
    ).toBe(0);

    await runtime.stopConsole(run);
    await runtime.removeStaleViewSessions(new Set());
    expect(
      spawnSync(
        "tmux",
        ["-L", serverName, "-f", "/dev/null", "has-session", "-t", `=${viewSession}`],
        { encoding: "utf8" },
      ).status,
    ).not.toBe(0);
    await runtime.close();
    store.close();
  });

  it("injects generation-scoped MCP variables into the direct CLI environment only", async () => {
    const serverName = `nanasa-terminal-mcp-${process.pid}-${Date.now()}`;
    tmuxServers.push(serverName);
    const store = new NanasaStore(":memory:");
    const group = store.createGroup({ name: "MCP environment" });
    const fixtureCode =
      "console.log(`MCP:${process.env.NANASA_MCP_URL}:${process.env.NANASA_MCP_TOKEN}`);setInterval(()=>{},1000);";
    const profile = store.createInternalAgentProfile({
      name: "MCP fixture",
      agentType: "test-terminal",
      kind: "opencode",
      command: "node",
      args: ["-e", fixtureCode],
      environment: { NANASA_ROLE: "direct" },
    });
    const membership = store.addMembership(group.id, {
      memberId: "mcp-agent",
      agentProfileId: profile.id,
      alias: "MCP agent",
    });
    const runtime = new TmuxRuntime(store, {
      serverName,
      runtimeEnvironment: (run) => ({
        NANASA_MCP_URL: "http://127.0.0.1:3210/mcp",
        NANASA_MCP_TOKEN: `token-${run.id}-${run.generation}`,
      }),
    });

    const run = await runtime.startRun(group.id, membership.memberId, { cols: 100, rows: 30 });
    await waitForPaneText(
      serverName,
      run.terminal!.paneId,
      `MCP:http://127.0.0.1:3210/mcp:token-${run.id}-${run.generation}`,
    );
    expect(store.getAgentProfile(profile.id).environment).toEqual({ NANASA_ROLE: "direct" });

    await runtime.close();
    store.close();
  });

  it("pastes text plus Enter into the owned pane and blocks active browser writers", async () => {
    const serverName = `nanasa-terminal-delivery-${process.pid}-${Date.now()}`;
    tmuxServers.push(serverName);
    const store = new NanasaStore(":memory:");
    const { group, membership } = createFixture(store, "Terminal delivery");
    const runtime = new TmuxRuntime(store, { serverName });
    const run = await runtime.startRun(group.id, membership.memberId, { cols: 100, rows: 30 });
    const endpoints = new TerminalEndpointRegistry(store);
    const delivery = new TmuxTerminalDelivery(runtime, endpoints);
    await waitForPaneText(serverName, run.terminal!.paneId, "READY:direct");
    await runtime.ensureViewSession(run);

    store.submitMessage(group.id, {
      intent: "request",
      sender: { kind: "operator", operatorId: "operator" },
      audience: { kind: "dm", memberId: membership.memberId },
      body: { contentType: "text/plain", text: "safe terminal delivery" },
      delivery: {},
      hop: 0,
    });
    const claim = store.claimDeliveries({
      owner: "terminal-test",
      now: new Date(),
      leaseMs: 30_000,
      limit: 1,
    })[0]!;

    expect(formatTerminalDelivery(claim)).toContain(
      `[From: Human | Message: ${claim.message.id} | Conversation: ${claim.message.conversationId} | Reply-To: none | Intent: request]`,
    );
    await delivery.deliver(claim);
    await waitForPaneText(serverName, run.terminal!.paneId, "ECHO:safe terminal delivery");

    endpoints.begin(run, 1);
    const releaseWriter = endpoints.beginWriter(run.id, 1);
    await expect(delivery.deliver(claim)).rejects.toThrow("terminal_writer_conflict");
    releaseWriter();

    tmux(serverName, ["kill-pane", "-t", run.terminal!.paneId]);
    await expect(delivery.deliver(claim)).rejects.toThrow("terminal_run_unavailable");
    await runtime.close();
    store.close();
  });

  it("force-replaces a migration-marked owned pane once with the configured command", async () => {
    const serverName = `nanasa-terminal-migration-${process.pid}-${Date.now()}`;
    tmuxServers.push(serverName);
    const store = new NanasaStore(":memory:");
    const { group, membership } = createFixture(store, "Runtime migration");
    const runtime = new TmuxRuntime(store, { serverName });
    const original = await runtime.startRun(group.id, membership.memberId, {
      cols: 100,
      rows: 30,
    });
    await waitForPaneText(serverName, original.terminal!.paneId, "READY:direct");
    const marked = store.transitionRunRecovery(original.id, original.generation, "reconciling", {
      reason: "terminal_runtime_migration",
    });

    const replacement = await runtime.recoverRun(marked, { cols: 100, rows: 30 });
    await waitForPaneText(serverName, replacement.terminal!.paneId, "READY:direct");
    expect(replacement.generation).toBe(original.generation + 1);
    expect(store.getRun(original.id)).toMatchObject({
      status: "failed",
      recoveryReason: "terminal_runtime_migration",
    });
    expect(
      tmux(serverName, [
        "display-message",
        "-p",
        "-t",
        replacement.terminal!.paneId,
        "#{@nanasa-run-id}\t#{@nanasa-generation}",
      ]).trim(),
    ).toBe(`${replacement.id}\t${replacement.generation}`);
    await expect(runtime.recoverRun(marked, { cols: 100, rows: 30 })).rejects.toMatchObject({
      code: "run_already_active",
    });

    await runtime.close();
    store.close();
  });

  it.each(["owner", "generation"] as const)(
    "does not kill a reused pane with a mismatched %s fence during stop",
    async (mismatch) => {
      const serverName = `nanasa-terminal-stop-fence-${mismatch}-${process.pid}-${Date.now()}`;
      tmuxServers.push(serverName);
      const store = new NanasaStore(":memory:");
      const { group, membership } = createFixture(store, `Stop ${mismatch} fence`);
      const foreignMembership = store.addMembership(group.id, {
        memberId: "foreign",
        agentProfileId: membership.agentProfileId,
        alias: "Foreign",
      });
      const runtime = new TmuxRuntime(store, { serverName });
      const stale = await runtime.startRun(group.id, membership.memberId, {
        cols: 100,
        rows: 30,
      });
      const foreign = await runtime.startRun(group.id, foreignMembership.memberId, {
        cols: 100,
        rows: 30,
      });
      await waitForPaneText(serverName, foreign.terminal!.paneId, "READY:direct");
      if (mismatch === "generation") {
        tmux(serverName, [
          "set-option",
          "-p",
          "-t",
          foreign.terminal!.paneId,
          "@nanasa-run-id",
          stale.id,
        ]);
        tmux(serverName, [
          "set-option",
          "-p",
          "-t",
          foreign.terminal!.paneId,
          "@nanasa-generation",
          String(stale.generation + 1),
        ]);
      }
      store.updateRunStatus(stale.id, "running", { terminal: foreign.terminal });

      const stopped = await runtime.stopRun(group.id, membership.memberId);

      expect(stopped).toMatchObject({
        status: "stopped",
        desiredState: "stopped",
        recoveryReason: "terminal_binding_not_owned",
      });
      expect(
        tmux(serverName, [
          "display-message",
          "-p",
          "-t",
          foreign.terminal!.paneId,
          "#{pane_dead}",
        ]).trim(),
      ).toBe("0");
      await runtime.close();
      store.close();
    },
  );
});
