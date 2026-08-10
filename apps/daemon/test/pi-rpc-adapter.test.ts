import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfile, AgentRun, Message } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PiRpcAdapter } from "../src/pi-rpc-adapter.js";
import type { PiRpcProcess, PiRpcState } from "../src/pi-rpc-process.js";
import { PiRpcWorker } from "../src/pi-rpc-worker.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const profile: AgentProfile = {
  id: "profile-one",
  name: "Pi",
  agentType: "pi",
  kind: "pi",
  adapter: "pi-rpc",
  capabilities: ["queue", "steer"],
  command: "pi",
  args: [],
  workingDirectory: "/workspace",
  environment: {},
  createdAt: "2026-08-10T12:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
};

const run: AgentRun = {
  id: "run-one",
  groupId: "group-one",
  memberId: "member-one",
  agentProfileId: profile.id,
  generation: 1,
  status: "running",
  desiredState: "running",
  recoveryPhase: "idle",
  terminal: { serverName: "test", sessionId: "$1", windowId: "@1", paneId: "%1" },
  startedAt: "2026-08-10T12:00:00.000Z",
};

const message: Message = {
  id: "message-one",
  groupId: "group-one",
  groupSeq: 1,
  conversationId: "conversation-one",
  intent: "request",
  sender: { kind: "operator", operatorId: "operator-one" },
  audience: { kind: "dm", memberId: "member-one" },
  body: { contentType: "text/plain", text: "Review the change." },
  delivery: { mode: "queue" },
  hop: 0,
  createdAt: "2026-08-10T12:00:00.000Z",
};

class FakePi extends EventEmitter {
  public readonly stderrTail = "";
  public readonly commands: string[] = [];
  public state: PiRpcState;

  public constructor(sessionFile: string, model: PiRpcState["model"] = { provider: "x", id: "y" }) {
    super();
    this.state = {
      model,
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-one",
      sessionFile,
      pendingMessageCount: 0,
    };
  }

  public async handshake() {
    return this.state;
  }

  public async command(command: { type: string }) {
    this.commands.push(command.type);
    return { type: "response" as const, command: command.type, success: true };
  }

  public close(): void {}
}

async function fixture(model?: PiRpcState["model"]) {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-pi-adapter-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "runtime", "worker.sock");
  const sessionDirectory = join(directory, "state", "pi");
  const pi = new FakePi(join(sessionDirectory, "session.jsonl"), model);
  const createPiProcess = vi.fn(() => pi as unknown as PiRpcProcess);
  const worker = new PiRpcWorker({
    socketPath,
    sessionDirectory,
    runId: run.id,
    generation: run.generation,
    createPiProcess,
  });
  await worker.start();
  const persistSession = vi.fn();
  const settleDeliveries = vi.fn();
  const adapter = new PiRpcAdapter(
    { run, profile },
    { socketPath, sessionDirectory, persistSession, settleDeliveries },
  );
  return {
    worker,
    adapter,
    pi,
    createPiProcess,
    persistSession,
    settleDeliveries,
    socketPath,
    sessionDirectory,
  };
}

describe("PiRpcAdapter", () => {
  it("persists the validated session and settles accepted delivery on agent_settled", async () => {
    const { worker, adapter, pi, persistSession, settleDeliveries } = await fixture();
    await adapter.start({ run, profile });

    const result = await adapter.deliver({ message, run, profile, mode: "queue" });
    pi.emit("event", { type: "agent_settled" });

    await expect(result.settlement).resolves.toEqual({ status: "processed" });
    expect(result).toMatchObject({
      adapterSessionId: "session-one",
      adapterMessageId: message.id,
    });
    expect(persistSession).toHaveBeenCalledWith({
      adapterSessionId: "session-one",
      sessionFile: expect.stringMatching(/session\.jsonl$/),
    });
    expect(settleDeliveries).toHaveBeenCalledWith([message.id]);
    await adapter.shutdown();
    await adapter.close();
    await worker.close();
  });

  it("disconnects and reconnects without creating a second Pi process", async () => {
    const {
      worker,
      adapter,
      createPiProcess,
      persistSession,
      settleDeliveries,
      socketPath,
      sessionDirectory,
      pi,
    } = await fixture();
    await adapter.start({ run, profile });
    const accepted = await adapter.deliver({ message, run, profile, mode: "queue" });
    let oldSettlement: string | undefined;
    void accepted.settlement?.then(
      () => {
        oldSettlement = "processed";
      },
      () => {
        oldSettlement = "failed";
      },
    );
    await adapter.close();
    const reconnected = new PiRpcAdapter(
      { run, profile },
      { socketPath, sessionDirectory, persistSession, settleDeliveries },
    );
    await reconnected.start({ run, profile });
    pi.emit("event", { type: "agent_settled" });
    await vi.waitFor(() => expect(settleDeliveries).toHaveBeenCalledWith([message.id]));

    expect(createPiProcess).toHaveBeenCalledTimes(1);
    expect(adapter.state.readiness).toBe("closed");
    expect(reconnected.state.readiness).toBe("ready");
    expect(oldSettlement).toBeUndefined();
    await reconnected.shutdown();
    await reconnected.close();
    await worker.close();
  });

  it("reports a missing model as unavailable instead of ready", async () => {
    const { worker, adapter } = await fixture(null);
    await adapter.start({ run, profile });

    expect(adapter.state).toEqual({ readiness: "unavailable", reason: "pi_model_unavailable" });
    await adapter.close();
    await worker.close();
  });
});
