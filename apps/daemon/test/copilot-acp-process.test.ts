import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { COPILOT_ACP_PROTOCOL_VERSION, CopilotAcpProcess } from "../src/copilot-acp-process.js";

class FakeChild extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 4321;
  public killed = false;

  public kill(): boolean {
    this.killed = true;
    return true;
  }
}

function fakeSpawn(child: FakeChild) {
  return vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
}

function readMessages(child: FakeChild, handler: (message: Record<string, unknown>) => void): void {
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handler(JSON.parse(line) as Record<string, unknown>);
    }
  });
}

function respond(child: FakeChild, request: Record<string, unknown>, result: unknown): void {
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}

describe("CopilotAcpProcess", () => {
  it("uses direct ACP argv and performs initialize, new, load, prompt, update, and cancel", async () => {
    const child = new FakeChild();
    const spawnProcess = fakeSpawn(child);
    const received: Record<string, unknown>[] = [];
    readMessages(child, (message) => received.push(message));
    const process = new CopilotAcpProcess({
      command: "/opt/copilot/bin/copilot",
      args: ["--no-auto-update"],
      cwd: "/workspace",
      env: { HOME: "/home/test" },
      spawnProcess,
    });

    const initializing = process.initialize();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: COPILOT_ACP_PROTOCOL_VERSION },
    });
    respond(child, received[0] ?? {}, {
      protocolVersion: COPILOT_ACP_PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    });
    await expect(initializing).resolves.toMatchObject({ protocolVersion: 1 });

    const creating = process.newSession("/workspace");
    await vi.waitFor(() => expect(received).toHaveLength(2));
    respond(child, received[1] ?? {}, { sessionId: "session-1" });
    await expect(creating).resolves.toBe("session-1");

    const loading = process.loadSession("session-1", "/workspace");
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received[2]).toMatchObject({
      method: "session/load",
      params: { sessionId: "session-1", cwd: "/workspace", mcpServers: [] },
    });
    respond(child, received[2] ?? {}, null);
    await expect(loading).resolves.toBeUndefined();

    const notifications: unknown[] = [];
    process.on("notification", (notification) => notifications.push(notification));
    const started = await process.startPrompt("session-1", "hello");
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received[3]).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
    });
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } })}\n`,
    );
    respond(child, received[3] ?? {}, { stopReason: "end_turn" });
    await expect(started.response).resolves.toEqual({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));

    await process.cancel("session-1");
    await vi.waitFor(() => expect(received).toHaveLength(5));
    expect(received[4]).toMatchObject({
      method: "session/cancel",
      params: { sessionId: "session-1" },
    });
    expect(received[4]).not.toHaveProperty("id");
    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/copilot/bin/copilot",
      ["--no-auto-update", "--acp", "--stdio"],
      { cwd: "/workspace", env: { HOME: "/home/test" }, shell: false },
    );
    process.close();
  });

  it("cancels permissions and rejects unsupported client requests", async () => {
    const child = new FakeChild();
    const received: Record<string, unknown>[] = [];
    readMessages(child, (message) => received.push(message));
    const process = new CopilotAcpProcess({
      command: "copilot",
      args: [],
      spawnProcess: fakeSpawn(child),
    });

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { options: [] } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "terminal-1", method: "terminal/create", params: {} })}\n`,
    );

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]).toEqual({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(received[1]).toMatchObject({
      jsonrpc: "2.0",
      id: "terminal-1",
      error: { code: -32601 },
    });
    process.close();
  });

  it("bounds stderr and fails pending work on malformed, oversized, and crashed processes", async () => {
    const malformedChild = new FakeChild();
    const malformed = new CopilotAcpProcess({
      command: "copilot",
      args: [],
      maxStderrBytes: 5,
      spawnProcess: fakeSpawn(malformedChild),
    });
    const pending = malformed.request("initialize", {});
    malformedChild.stderr.write("abcdefg");
    malformedChild.stdout.write("not-json\n");
    await expect(pending).rejects.toThrow("jsonl_malformed_json");
    expect(malformed.stderrTail).toBe("cdefg");
    expect(malformedChild.killed).toBe(true);

    const oversizedChild = new FakeChild();
    const oversized = new CopilotAcpProcess({
      command: "copilot",
      args: [],
      maxRecordBytes: 4,
      spawnProcess: fakeSpawn(oversizedChild),
    });
    const oversizedPending = oversized.request("initialize", {});
    oversizedChild.stdout.write("12345");
    await expect(oversizedPending).rejects.toThrow("jsonl_record_too_large");

    const crashedChild = new FakeChild();
    const crashed = new CopilotAcpProcess({
      command: "copilot",
      args: [],
      spawnProcess: fakeSpawn(crashedChild),
    });
    const crashedPending = crashed.request("initialize", {});
    crashedChild.emit("close", 7, null);
    await expect(crashedPending).rejects.toThrow("copilot_acp_process_exited:7:none");
  });
});
