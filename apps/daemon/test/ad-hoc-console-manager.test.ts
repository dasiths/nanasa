import type { AgentRun } from "@nanasa/contracts";
import { describe, expect, it, vi } from "vitest";

import { AdHocConsoleManager } from "../src/ad-hoc-console-manager.js";
import type { TerminalEndpointRegistry } from "../src/terminal-endpoint-registry.js";
import type { TmuxRuntime } from "../src/tmux-runtime.js";
import type { TtydSupervisor } from "../src/ttyd-supervisor.js";

const run: AgentRun = {
  id: "console_test",
  groupId: "console_test",
  memberId: "console_test",
  agentProfileId: "console",
  generation: 1,
  status: "running",
  desiredState: "running",
  recoveryPhase: "idle",
  recoveryAttempts: 0,
  terminal: {
    serverName: "nanasa",
    sessionId: "$1",
    windowId: "@1",
    paneId: "%1",
  },
  startedAt: "2026-08-11T00:00:00.000Z",
};

describe("AdHocConsoleManager", () => {
  it("creates a Bash console and releases every runtime resource", async () => {
    const calls: string[] = [];
    const runtime = {
      startConsole: vi.fn(async () => run),
      ensureViewSession: vi.fn(async () => calls.push("view:start")),
      removeViewSession: vi.fn(async () => calls.push("view:stop")),
      stopConsole: vi.fn(async () => calls.push("console:stop")),
    } as unknown as TmuxRuntime;
    const supervisor = {
      startDetached: vi.fn(() => calls.push("ttyd:start")),
      stop: vi.fn(async () => calls.push("ttyd:stop")),
    } as unknown as TtydSupervisor;
    const endpoints = {
      remove: vi.fn(() => calls.push("endpoint:remove")),
    } as unknown as TerminalEndpointRegistry;
    const manager = new AdHocConsoleManager(runtime, supervisor, endpoints, "/workspace");

    const session = await manager.create();
    expect(session.runId).toBe(run.id);
    expect(runtime.startConsole).toHaveBeenCalledWith(
      expect.stringMatching(/^console_/),
      "/workspace",
      { cols: 120, rows: 36 },
    );

    await manager.remove(session.id);
    expect(calls).toEqual([
      "view:start",
      "ttyd:start",
      "ttyd:stop",
      "view:stop",
      "console:stop",
      "endpoint:remove",
    ]);
    await expect(manager.remove(session.id)).rejects.toMatchObject({
      code: "console_not_found",
      statusCode: 404,
    });
  });
});
