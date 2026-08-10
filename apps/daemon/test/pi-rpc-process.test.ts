import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { PiRpcProcess, validatePiReadiness } from "../src/pi-rpc-process.js";

class FakeChild extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 1234;
  public killed = false;

  public kill(): boolean {
    this.killed = true;
    return true;
  }
}

function fakeSpawn(child: FakeChild) {
  return vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
}

function readCommands(child: FakeChild, handler: (command: Record<string, unknown>) => void): void {
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

describe("PiRpcProcess", () => {
  it("spawns direct argv and serializes correlated commands", async () => {
    const child = new FakeChild();
    const spawnProcess = fakeSpawn(child);
    const received: Record<string, unknown>[] = [];
    readCommands(child, (command) => received.push(command));
    const process = new PiRpcProcess({
      command: "/opt/pi/bin/pi",
      args: ["--mode", "rpc"],
      cwd: "/workspace",
      spawnProcess,
    });

    const first = process.command({ type: "get_state" });
    const second = process.command({ type: "get_entries" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const firstCommand = received[0] ?? {};
    child.stdout.write(
      `${JSON.stringify({ type: "response", command: "get_state", success: true, id: firstCommand.id, data: {} })}\n`,
    );
    await expect(first).resolves.toMatchObject({ command: "get_state", success: true });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    const secondCommand = received[1] ?? {};
    child.stdout.write(
      `${JSON.stringify({ type: "response", command: "get_entries", success: true, id: secondCommand.id, data: { entries: [], leafId: null } })}\n`,
    );
    await expect(second).resolves.toMatchObject({ command: "get_entries", success: true });

    expect(spawnProcess).toHaveBeenCalledWith("/opt/pi/bin/pi", ["--mode", "rpc"], {
      cwd: "/workspace",
      shell: false,
    });
    process.close();
  });

  it("performs a get_state handshake and forwards settlement events", async () => {
    const child = new FakeChild();
    readCommands(child, (command) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "response",
          command: command.type,
          success: true,
          id: command.id,
          data: {
            model: { provider: "anthropic", id: "claude" },
            isStreaming: false,
            isCompacting: false,
            sessionId: "session-1",
            sessionFile: "/state/session.jsonl",
            pendingMessageCount: 0,
          },
        })}\n`,
      );
    });
    const process = new PiRpcProcess({ command: "pi", args: [], spawnProcess: fakeSpawn(child) });
    const events: unknown[] = [];
    process.on("event", (event) => events.push(event));

    await expect(process.handshake()).resolves.toMatchObject({ sessionId: "session-1" });
    child.stdout.write('{"type":"agent_end","willRetry":true}\n');
    child.stdout.write('{"type":"agent_settled"}\n');

    expect(events).toEqual([{ type: "agent_end", willRetry: true }, { type: "agent_settled" }]);
    process.close();
  });

  it("fails pending work on malformed protocol output", async () => {
    const child = new FakeChild();
    const process = new PiRpcProcess({ command: "pi", args: [], spawnProcess: fakeSpawn(child) });
    const command = process.command({ type: "get_state" });
    child.stdout.write("not-json\n");

    await expect(command).rejects.toThrow("jsonl_malformed_json");
    expect(child.killed).toBe(true);
  });

  it("rejects unknown models and authentication diagnostics", () => {
    const base = {
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-1",
      pendingMessageCount: 0,
    };
    expect(validatePiReadiness({ ...base, model: null })).toBe("pi_model_unavailable");
    expect(
      validatePiReadiness(
        { ...base, model: { provider: "anthropic", id: "claude" } },
        "No API key found",
      ),
    ).toBe("pi_authentication_unavailable");
  });
});
