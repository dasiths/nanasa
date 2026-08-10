import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiRpcProcess, PiRpcState } from "../src/pi-rpc-process.js";
import { PiRpcWorker } from "../src/pi-rpc-worker.js";
import { PiRpcWorkerClient } from "../src/pi-rpc-worker-client.js";
import type { WorkerEvent, WorkerSnapshot } from "../src/pi-rpc-worker-protocol.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakePiProcess extends EventEmitter {
  public readonly commands: Array<Record<string, unknown>> = [];
  public readonly stderrTail = "";
  public closed = false;
  public settleDuringCommand = false;
  public state: PiRpcState;

  public constructor(sessionFile: string) {
    super();
    this.state = {
      model: { provider: "anthropic", id: "claude-sonnet" },
      isStreaming: false,
      isCompacting: false,
      sessionId: "pi-session-1",
      sessionFile,
      pendingMessageCount: 0,
    };
  }

  public async handshake(): Promise<PiRpcState> {
    return this.state;
  }

  public async command(command: Record<string, unknown>) {
    this.commands.push(command);
    if (command.type === "prompt" && this.settleDuringCommand) {
      this.piEvent({ type: "agent_settled" });
    }
    if (command.type === "abort" && this.state.isStreaming) {
      setImmediate(() => this.piEvent({ type: "agent_settled" }));
    }
    return { type: "response" as const, command: String(command.type), success: true };
  }

  public piEvent(event: Record<string, unknown>): void {
    if (event.type === "agent_start") this.state = { ...this.state, isStreaming: true };
    if (event.type === "agent_settled") this.state = { ...this.state, isStreaming: false };
    this.emit("event", event);
  }

  public close(): void {
    this.closed = true;
  }
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-pi-worker-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "runtime", "worker.sock");
  const sessionDirectory = join(directory, "state", "pi");
  const pi = new FakePiProcess(join(sessionDirectory, "session.jsonl"));
  const createPiProcess = vi.fn(() => pi as unknown as PiRpcProcess);
  const worker = new PiRpcWorker({
    socketPath,
    sessionDirectory,
    runId: "run-one",
    generation: 7,
    createPiProcess,
  });
  await worker.start();
  const client = new PiRpcWorkerClient({
    socketPath,
    runId: "run-one",
    generation: 7,
    connectTimeoutMs: 500,
  });
  await client.connect();
  const launch = {
    command: "/opt/pi/bin/pi",
    args: ["--provider", "anthropic"],
    cwd: "/workspace",
    environment: { PI_AUTH_TOKEN: "not-logged" },
  };
  const snapshot = (await client.request("initialize", launch)) as WorkerSnapshot;
  return { worker, client, pi, createPiProcess, socketPath, launch, snapshot };
}

describe("PiRpcWorker", () => {
  it("maps idle and busy queue/steer deliveries and settles only on agent_settled", async () => {
    const { worker, client, pi, snapshot } = await fixture();
    const events: WorkerEvent[] = [];
    client.on("event", (event: WorkerEvent) => events.push(event));
    expect(snapshot.state).toMatchObject({ sessionId: "pi-session-1" });

    await client.request("deliver", { deliveryId: "d1", mode: "queue", message: "one" });
    pi.piEvent({ type: "agent_start" });
    await client.request("deliver", { deliveryId: "d2", mode: "queue", message: "two" });
    await client.request("deliver", { deliveryId: "d3", mode: "steer", message: "three" });
    pi.piEvent({ type: "agent_end", willRetry: true });
    pi.piEvent({ type: "compaction_end", willRetry: true });
    await Promise.resolve();

    expect(pi.commands.map((command) => command.type)).toEqual(["prompt", "follow_up", "steer"]);
    expect(events.filter((event) => event.type === "delivery_settled")).toEqual([]);

    pi.piEvent({ type: "agent_settled" });
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "delivery_settled")).toMatchObject([
        { sequence: 1, deliveryIds: ["d1", "d2", "d3"] },
      ]),
    );
    client.disconnect();
    await worker.close();
  });

  it("does not overwrite settlement that arrives during prompt acceptance", async () => {
    const { worker, client, pi } = await fixture();
    pi.settleDuringCommand = true;

    const accepted = await client.request("deliver", {
      deliveryId: "d1",
      mode: "queue",
      message: "one",
    });
    const duplicate = await client.request("deliver", {
      deliveryId: "d1",
      mode: "queue",
      message: "one",
    });

    expect(accepted).toMatchObject({ settled: true });
    expect(duplicate).toMatchObject({ duplicate: true, settled: true });
    client.disconnect();
    await worker.close();
  });

  it("aborts before awaiting settlement and does not inject a replacement prompt", async () => {
    const { worker, client, pi } = await fixture();
    pi.piEvent({ type: "agent_start" });

    await expect(client.request("abort", {})).resolves.toEqual({ settled: true });

    expect(pi.commands.map((command) => command.type)).toEqual(["abort"]);
    client.disconnect();
    await worker.close();
  });

  it("reconnects to the same worker and replays settlement history without another Pi", async () => {
    const { worker, client, pi, createPiProcess, socketPath, launch } = await fixture();
    await client.request("deliver", { deliveryId: "d1", mode: "queue", message: "one" });
    pi.piEvent({ type: "agent_settled" });
    client.disconnect();

    const reconnected = new PiRpcWorkerClient({
      socketPath,
      runId: "run-one",
      generation: 7,
      connectTimeoutMs: 500,
    });
    const hello = await reconnected.connect();
    const resumed = (await reconnected.request("initialize", launch)) as WorkerSnapshot;

    expect(hello).toMatchObject({ initialized: true, settlementSequence: 1 });
    expect(resumed.settlements).toMatchObject([{ deliveryIds: ["d1"] }]);
    expect(createPiProcess).toHaveBeenCalledTimes(1);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    reconnected.disconnect();
    await worker.close();
  });

  it("rejects a stale generation and preserves the active worker", async () => {
    const { worker, client, socketPath } = await fixture();
    const stale = new PiRpcWorkerClient({
      socketPath,
      runId: "run-one",
      generation: 6,
      connectTimeoutMs: 30,
      retryIntervalMs: 10,
    });
    await stale.connect().catch(() => undefined);

    await expect(stale.request("hello", {})).rejects.toThrow();
    client.disconnect();
    stale.disconnect();
    await worker.close();
  });

  it("removes a stale Unix socket before listening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-pi-stale-socket-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "worker.sock");
    const holder = spawn(
      process.execPath,
      [
        "-e",
        "const net=require('node:net');const s=net.createServer();s.listen(process.argv[1],()=>process.stdout.write('ready'))",
        socketPath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await once(holder.stdout, "data");
    holder.kill("SIGKILL");
    await once(holder, "close");
    expect(statSync(socketPath).isSocket()).toBe(true);

    const worker = new PiRpcWorker({
      socketPath,
      sessionDirectory: join(directory, "sessions"),
      runId: "run-stale",
      generation: 1,
    });
    await worker.start();

    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    await worker.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("resets a Pi child that reports a session file outside its state directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-pi-invalid-session-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "runtime", "worker.sock");
    const pi = new FakePiProcess(join(directory, "outside.jsonl"));
    const worker = new PiRpcWorker({
      socketPath,
      sessionDirectory: join(directory, "sessions"),
      runId: "run-invalid",
      generation: 1,
      createPiProcess: () => pi as unknown as PiRpcProcess,
    });
    await worker.start();
    const client = new PiRpcWorkerClient({
      socketPath,
      runId: "run-invalid",
      generation: 1,
      connectTimeoutMs: 500,
    });
    await client.connect();

    await expect(
      client.request("initialize", {
        command: "pi",
        args: [],
        cwd: "/workspace",
        environment: {},
      }),
    ).rejects.toThrow("pi_session_file_outside_state");
    expect(pi.closed).toBe(true);
    expect(await client.request("hello", {})).toMatchObject({ initialized: false });
    client.disconnect();
    await worker.close();
  });

  it("closes the worker connection when the owned Pi process fails", async () => {
    const { worker, client, pi, socketPath } = await fixture();
    const failed = new Promise<Error>((resolve) => client.once("failure", resolve));

    pi.emit("failure", new Error("pi_crashed"));

    await expect(failed).resolves.toMatchObject({ message: "pi_worker_connection_closed" });
    await vi.waitFor(() => expect(existsSync(socketPath)).toBe(false));
    await worker.close();
  });
});
