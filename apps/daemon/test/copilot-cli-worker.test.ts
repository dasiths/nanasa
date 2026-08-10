import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopilotAcpProcess } from "../src/copilot-acp-process.js";
import { CopilotCliWorker } from "../src/copilot-cli-worker.js";
import { CopilotCliWorkerClient } from "../src/copilot-cli-worker-client.js";
import type {
  CopilotCliWorkerEvent,
  CopilotCliWorkerSnapshot,
} from "../src/copilot-cli-worker-protocol.js";

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

class FakeAcpServer {
  public readonly child = new FakeChild();
  public readonly messages: Record<string, unknown>[] = [];
  public readonly prompts: Record<string, unknown>[] = [];
  public readonly loadedSessions: string[] = [];
  public cancelCount = 0;
  public failLoad = false;
  public sessionId = "session-new";
  readonly #pendingPrompts: Record<string, unknown>[] = [];

  public constructor() {
    let buffer = "";
    this.child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        this.messages.push(message);
        this.#handle(message);
      }
    });
  }

  public process(): CopilotAcpProcess {
    return new CopilotAcpProcess({
      command: "copilot",
      args: [],
      spawnProcess: () => this.child as unknown as ChildProcessWithoutNullStreams,
    });
  }

  public completePrompt(index: number, stopReason: string): void {
    const prompt = this.#pendingPrompts[index];
    if (prompt === undefined) throw new Error("fake_prompt_missing");
    this.#respond(prompt, { stopReason });
  }

  public crash(code = 9): void {
    this.child.emit("close", code, null);
  }

  #handle(message: Record<string, unknown>): void {
    switch (message.method) {
      case "initialize":
        this.#respond(message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "fake-copilot", version: "1.0.0" },
        });
        break;
      case "session/new":
        this.#respond(message, { sessionId: this.sessionId });
        break;
      case "session/load": {
        const params = message.params as { sessionId: string };
        this.loadedSessions.push(params.sessionId);
        if (this.failLoad) {
          this.child.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "session not found" } })}\n`,
          );
        } else this.#respond(message, null);
        break;
      }
      case "session/prompt":
        this.prompts.push(message);
        this.#pendingPrompts.push(message);
        break;
      case "session/cancel":
        this.cancelCount += 1;
        this.completePrompt(this.#pendingPrompts.length - 1, "cancelled");
        break;
      default:
        break;
    }
  }

  #respond(request: Record<string, unknown>, result: unknown): void {
    this.child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  }
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function createHarness(servers: FakeAcpServer[], adapterSessionId?: string) {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-copilot-worker-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "worker.sock");
  let serverIndex = 0;
  const worker = new CopilotCliWorker({
    socketPath,
    stateDirectory: join(directory, "state"),
    runId: "run-1",
    generation: 3,
    restartDelaysMs: [0],
    cancelTimeoutMs: 500,
    createAcpProcess: () => {
      const server = servers[serverIndex++];
      if (server === undefined) throw new Error("fake_acp_server_exhausted");
      return server.process();
    },
  });
  await worker.start();
  const client = new CopilotCliWorkerClient({
    socketPath,
    runId: "run-1",
    generation: 3,
  });
  await client.connect();
  const snapshot = (await client.request("initialize", {
    command: "copilot",
    args: [],
    cwd: "/workspace",
    environment: {},
    ...(adapterSessionId === undefined ? {} : { adapterSessionId }),
    recoveryPolicy: "resume-or-restart",
  })) as CopilotCliWorkerSnapshot;
  return { worker, client, snapshot, socketPath };
}

describe("CopilotCliWorker", () => {
  it("serializes queued prompts and settles successful and failed stop reasons", async () => {
    const server = new FakeAcpServer();
    const { worker, client, snapshot } = await createHarness([server]);
    const events: CopilotCliWorkerEvent[] = [];
    client.on("event", (event: CopilotCliWorkerEvent) => events.push(event));

    expect(snapshot).toMatchObject({
      initialized: true,
      sessionId: "session-new",
      recovery: { status: "created" },
      compatibility: { protocolVersion: 1, loadSession: true },
    });
    const first = client.request("deliver", {
      deliveryId: "message-1",
      message: "first",
      mode: "queue",
    });
    await expect(first).resolves.toMatchObject({
      adapterMessageId: "acp-3",
      sessionId: "session-new",
    });
    const second = client.request("deliver", {
      deliveryId: "message-2",
      message: "second",
      mode: "queue",
    });
    await vi.waitFor(() => expect(server.prompts).toHaveLength(1));
    server.completePrompt(0, "end_turn");
    await expect(second).resolves.toMatchObject({ adapterMessageId: "acp-4" });
    await vi.waitFor(() => expect(server.prompts).toHaveLength(2));
    server.completePrompt(1, "refusal");

    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "delivery_settled")).toHaveLength(2),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "delivery_settled", status: "processed" }),
        expect.objectContaining({
          type: "delivery_settled",
          status: "failed",
          reason: "copilot_acp_stop:refusal",
        }),
      ]),
    );
    client.disconnect();
    await worker.close();
  });

  it("cancels only an active prompt", async () => {
    const server = new FakeAcpServer();
    const { worker, client } = await createHarness([server]);

    await expect(client.request("abort", {})).resolves.toEqual({ cancelled: false, idle: true });
    const delivery = client.request("deliver", {
      deliveryId: "message-cancel",
      message: "cancel me",
      mode: "queue",
    });
    await expect(delivery).resolves.toMatchObject({ sessionId: "session-new" });
    await expect(client.request("abort", {})).resolves.toEqual({ cancelled: true, idle: true });
    expect(server.cancelCount).toBe(1);
    await expect(client.request("abort", {})).resolves.toEqual({ cancelled: false, idle: true });
    expect(server.cancelCount).toBe(1);
    client.disconnect();
    await worker.close();
  });

  it("restarts after a failed load and replays settlements after daemon reconnect", async () => {
    const server = new FakeAcpServer();
    server.failLoad = true;
    server.sessionId = "replacement-session";
    const { worker, client, snapshot, socketPath } = await createHarness(
      [server],
      "missing-session",
    );

    expect(server.loadedSessions).toEqual(["missing-session"]);
    expect(snapshot).toMatchObject({
      sessionId: "replacement-session",
      recovery: { status: "restarted", reason: "copilot_session_load_failed" },
    });
    await client.request("deliver", {
      deliveryId: "message-replay",
      message: "replay me",
      mode: "queue",
    });
    server.completePrompt(0, "end_turn");
    await vi.waitFor(async () => {
      const current = (await client.request("hello", {})) as CopilotCliWorkerSnapshot;
      expect(current.settlements).toHaveLength(1);
    });
    client.disconnect();

    const reconnected = new CopilotCliWorkerClient({
      socketPath,
      runId: "run-1",
      generation: 3,
    });
    const replay = await reconnected.connect();
    expect(replay.settlements).toEqual([
      expect.objectContaining({
        status: "processed",
        deliveries: [expect.objectContaining({ deliveryId: "message-replay" })],
      }),
    ]);
    reconnected.disconnect();
    await worker.close();
  });

  it("fails active delivery and reloads the session after an ACP process crash", async () => {
    const firstServer = new FakeAcpServer();
    firstServer.sessionId = "durable-session";
    const recoveredServer = new FakeAcpServer();
    const { worker, client } = await createHarness([firstServer, recoveredServer]);
    const events: CopilotCliWorkerEvent[] = [];
    client.on("event", (event: CopilotCliWorkerEvent) => events.push(event));

    await client.request("deliver", {
      deliveryId: "message-crash",
      message: "crash",
      mode: "queue",
    });
    firstServer.crash();

    await vi.waitFor(() => expect(recoveredServer.loadedSessions).toEqual(["durable-session"]));
    await vi.waitFor(() =>
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "delivery_settled", status: "failed" }),
          expect.objectContaining({ type: "worker_state", readiness: "ready" }),
        ]),
      ),
    );
    client.disconnect();
    await worker.close();
  });
});
