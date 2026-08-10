import { EventEmitter } from "node:events";
import type { AgentProfile, AgentRun, Message } from "@nanasa/contracts";
import { describe, expect, it, vi } from "vitest";

import { CopilotCliAdapter } from "../src/copilot-cli-adapter.js";
import type { CopilotCliWorkerClient } from "../src/copilot-cli-worker-client.js";

const timestamp = "2026-08-10T12:00:00.000Z";
const profile: AgentProfile = {
  id: "profile-copilot",
  name: "Copilot",
  agentType: "copilot",
  kind: "copilot",
  adapter: "copilot-cli",
  capabilities: ["queue"],
  command: "copilot",
  args: [],
  workingDirectory: "/workspace",
  environment: {},
  createdAt: timestamp,
  updatedAt: timestamp,
};
const run: AgentRun = {
  id: "run-copilot",
  groupId: "group-one",
  memberId: "member-one",
  agentProfileId: profile.id,
  generation: 2,
  status: "running",
  desiredState: "running",
  recoveryPhase: "idle",
  terminal: { serverName: "test", sessionId: "$1", windowId: "@1", paneId: "%1" },
  startedAt: timestamp,
};
const message: Message = {
  id: "message-one",
  groupId: "group-one",
  groupSeq: 1,
  conversationId: "conversation-one",
  intent: "request",
  sender: { kind: "operator", operatorId: "operator-one" },
  audience: { kind: "dm", memberId: "member-one" },
  body: { contentType: "text/plain", text: "Review this." },
  delivery: { mode: "steer" },
  hop: 0,
  createdAt: timestamp,
};

class FakeWorkerClient extends EventEmitter {
  public readonly requests: Array<{ type: string; data: Record<string, unknown> }> = [];

  public async connect() {
    return { initialized: false, busy: false, settlementSequence: 0, settlements: [] };
  }

  public async request(type: string, data: Record<string, unknown>) {
    this.requests.push({ type, data });
    if (type === "initialize") {
      return {
        initialized: true,
        busy: false,
        sessionId: "acp-session-exact",
        settlementSequence: 0,
        settlements: [],
      };
    }
    if (type === "deliver") {
      return {
        sessionId: "acp-session-exact",
        adapterMessageId: "acp-7",
        settled: false,
      };
    }
    return {};
  }

  public disconnect(): void {}
}

describe("CopilotCliAdapter", () => {
  it("advertises queue only, persists the exact ACP session, and settles by adapter message ID", async () => {
    const client = new FakeWorkerClient();
    const persistSession = vi.fn();
    const settleDeliveries = vi.fn();
    const adapter = new CopilotCliAdapter(
      { run, profile },
      {
        socketPath: "/unused.sock",
        createClient: () => client as unknown as CopilotCliWorkerClient,
        persistSession,
        settleDeliveries,
      },
    );
    await adapter.start({ run, profile });

    expect([...adapter.capabilities]).toEqual(["queue"]);
    const result = await adapter.deliver({ message, run, profile, mode: "queue" });
    client.emit("event", {
      type: "delivery_settled",
      sequence: 1,
      deliveries: [{ deliveryId: message.id, adapterMessageId: "acp-7" }],
      status: "processed",
    });

    await expect(result.settlement).resolves.toEqual({ status: "processed" });
    expect(result).toMatchObject({
      appliedMode: "queue",
      adapterSessionId: "acp-session-exact",
      adapterMessageId: "acp-7",
    });
    expect(persistSession).toHaveBeenCalledWith("acp-session-exact");
    expect(settleDeliveries).toHaveBeenCalledWith(["acp-7"], { status: "processed" });
    await expect(adapter.deliver({ message, run, profile, mode: "steer" })).rejects.toThrow(
      "copilot_cli_queue_only",
    );
    await adapter.close();
  });
});
