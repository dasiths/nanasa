import type { AdapterKind, AgentProfile, AgentRun, DeliveryMode, Message } from "@nanasa/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  AdapterDelivery,
  AdapterDeliveryResult,
  AdapterLifecycleState,
  AgentAdapter,
} from "../src/agent-adapter.js";
import { AgentRuntimeSupervisor } from "../src/agent-runtime-supervisor.js";
import type { DeliveryClaim } from "../src/store.js";
import { TmuxTerminalDelivery } from "../src/terminal-adapter.js";

const profile: AgentProfile = {
  id: "profile-one",
  name: "Pi",
  agentType: "pi",
  kind: "pi",
  adapter: "pi-rpc",
  capabilities: ["queue", "steer"],
  command: "pi",
  args: [],
  environment: {},
  createdAt: "2026-08-10T12:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
};

function run(generation: number): AgentRun {
  return {
    id: "run-one",
    groupId: "group-one",
    memberId: "member-one",
    agentProfileId: profile.id,
    generation,
    status: "running",
    desiredState: "running",
    recoveryPhase: "idle",
    startedAt: "2026-08-10T12:00:00.000Z",
  };
}

const message: Message = {
  id: "message-one",
  groupId: "group-one",
  groupSeq: 1,
  conversationId: "conversation-one",
  intent: "request",
  sender: { kind: "operator", operatorId: "operator-one" },
  audience: { kind: "dm", memberId: "member-one" },
  body: { contentType: "text/plain", text: "Work" },
  delivery: { mode: "queue" },
  hop: 0,
  createdAt: "2026-08-10T12:00:00.000Z",
};

function claim(agentRun = run(1)): DeliveryClaim {
  return {
    delivery: {
      messageId: message.id,
      recipientMemberId: agentRun.memberId,
      requestedMode: "queue",
      appliedMode: "queue",
      fallbackApplied: false,
      status: "received",
      attempts: 1,
      adapter: profile.adapter,
      updatedAt: "2026-08-10T12:00:00.000Z",
    },
    message,
    profile,
    run: agentRun,
    recipientActive: true,
  };
}

class FakeAdapter implements AgentAdapter {
  public readonly kind: AdapterKind;
  public readonly capabilities: ReadonlySet<DeliveryMode> = new Set(["queue", "steer"]);
  public state: AdapterLifecycleState = { readiness: "starting" };
  public readonly start = vi.fn(async () => {
    this.state = { readiness: "ready" };
  });
  public readonly reconcile = vi.fn(async () => undefined);
  public readonly deliver = vi.fn(
    async (delivery: AdapterDelivery): Promise<AdapterDeliveryResult> => ({
      appliedMode: delivery.mode,
    }),
  );
  public readonly interrupt = vi.fn(async () => undefined);
  public readonly shutdown = vi.fn(async () => {
    this.state = { readiness: "closed" };
  });
  public readonly close = vi.fn(async () => {
    this.state = { readiness: "closed" };
  });

  public constructor(kind: AdapterKind) {
    this.kind = kind;
  }
}

describe("AgentRuntimeSupervisor", () => {
  it("creates one adapter for duplicate starts and forwards interrupt", async () => {
    const adapter = new FakeAdapter("pi-rpc");
    const factory = vi.fn(() => adapter);
    const supervisor = new AgentRuntimeSupervisor({ "pi-rpc": factory });
    const agentRun = run(1);

    await Promise.all([supervisor.start(agentRun, profile), supervisor.start(agentRun, profile)]);
    await supervisor.interrupt(agentRun);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.interrupt).toHaveBeenCalledTimes(1);
    expect(supervisor.status(agentRun, profile)).toMatchObject({
      readiness: "ready",
      capabilities: ["queue", "steer"],
    });
    await supervisor.close();
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it("replaces an older generation and fences callbacks from it", async () => {
    const adapters: FakeAdapter[] = [];
    const supervisor = new AgentRuntimeSupervisor({
      "pi-rpc": () => {
        const adapter = new FakeAdapter("pi-rpc");
        adapters.push(adapter);
        return adapter;
      },
    });
    const first = run(1);
    const second = run(2);

    await supervisor.start(first, profile);
    await supervisor.start(second, profile);

    expect(adapters).toHaveLength(2);
    expect(adapters[0]?.close).toHaveBeenCalledOnce();
    await expect(supervisor.interrupt(first)).rejects.toThrow("adapter_generation_unavailable");
    await expect(supervisor.interrupt(second)).resolves.toBeUndefined();
    await supervisor.close();
  });

  it("serializes concurrent deliveries for a run", async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const adapter = new FakeAdapter("pi-rpc");
    adapter.deliver.mockImplementation(async (delivery) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (adapter.deliver.mock.calls.length === 1) await firstBlocked;
      active -= 1;
      return { appliedMode: delivery.mode };
    });
    const supervisor = new AgentRuntimeSupervisor({ "pi-rpc": () => adapter });
    const agentRun = run(1);
    await supervisor.start(agentRun, profile);

    const first = supervisor.deliver(claim(agentRun), "queue");
    const second = supervisor.deliver(claim(agentRun), "steer");
    await vi.waitFor(() => expect(adapter.deliver).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
    expect(adapter.deliver.mock.calls.map(([delivery]) => delivery.mode)).toEqual([
      "queue",
      "steer",
    ]);
    await supervisor.close();
  });

  it("delivers terminal input for a native profile without native adapter readiness", async () => {
    const pasteToRun = vi.fn(async () => undefined);
    const terminalDelivery = new TmuxTerminalDelivery(
      {
        serverName: "nanasa-test",
        interruptRun: vi.fn(async () => undefined),
        isCurrentRun: vi.fn(async () => true),
        pasteToRun,
      },
      { hasWriter: vi.fn(() => false) },
    );
    const supervisor = new AgentRuntimeSupervisor({}, terminalDelivery);
    const agentRun: AgentRun = {
      ...run(1),
      terminal: {
        serverName: "nanasa-test",
        sessionId: "$1",
        windowId: "@2",
        paneId: "%3",
      },
    };
    const deliveryClaim = claim(agentRun);

    expect([...supervisor.capabilities(deliveryClaim)]).toEqual(["terminal"]);
    await expect(supervisor.deliver(deliveryClaim, "terminal")).resolves.toEqual({
      appliedMode: "terminal",
      adapterMessageId: message.id,
    });
    expect(pasteToRun).toHaveBeenCalledWith(agentRun, message.body.text);
    await supervisor.close();
  });

  it("selects independently injected factories by profile adapter", async () => {
    const created: AdapterKind[] = [];
    const factories = Object.fromEntries(
      (["pi-rpc", "copilot-cli", "terminal"] as const).map((kind) => [
        kind,
        () => {
          created.push(kind);
          return new FakeAdapter(kind);
        },
      ]),
    );
    const supervisor = new AgentRuntimeSupervisor(factories);

    for (const [index, kind] of (["pi-rpc", "copilot-cli", "terminal"] as const).entries()) {
      const selectedProfile = {
        ...profile,
        id: `profile-${kind}`,
        adapter: kind,
        capabilities: kind === "terminal" ? (["queue"] as const) : profile.capabilities,
      };
      await supervisor.start({ ...run(index + 1), id: `run-${kind}` }, selectedProfile);
    }

    expect(created).toEqual(["pi-rpc", "copilot-cli", "terminal"]);
    await supervisor.close();
  });

  it("restores Pi and Copilot factories with terminal delivery after supervisor restart", async () => {
    const created: AdapterKind[] = [];
    const pasteToRun = vi.fn(async () => undefined);
    const terminalDelivery = new TmuxTerminalDelivery(
      {
        serverName: "nanasa-test",
        interruptRun: vi.fn(async () => undefined),
        isCurrentRun: vi.fn(async () => true),
        pasteToRun,
      },
      { hasWriter: vi.fn(() => false) },
    );
    const profiles = (["pi-rpc", "copilot-cli"] as const).map((adapter) => ({
      ...profile,
      id: `profile-${adapter}`,
      agentType: adapter,
      kind: adapter === "pi-rpc" ? ("pi" as const) : ("copilot" as const),
      adapter,
      capabilities: adapter === "pi-rpc" ? (["queue", "steer"] as const) : (["queue"] as const),
    }));
    const runs = profiles.map((selectedProfile, index) => ({
      ...run(1),
      id: `run-${selectedProfile.adapter}`,
      memberId: `member-${selectedProfile.adapter}`,
      agentProfileId: selectedProfile.id,
      terminal: {
        serverName: "nanasa-test",
        sessionId: "$1",
        windowId: `@${index + 1}`,
        paneId: `%${index + 1}`,
      },
    }));

    for (let lifecycle = 0; lifecycle < 2; lifecycle += 1) {
      const supervisor = new AgentRuntimeSupervisor(
        {
          "pi-rpc": () => {
            created.push("pi-rpc");
            return new FakeAdapter("pi-rpc");
          },
          "copilot-cli": () => {
            created.push("copilot-cli");
            return new FakeAdapter("copilot-cli");
          },
        },
        terminalDelivery,
      );

      for (const [index, selectedProfile] of profiles.entries()) {
        const selectedRun = runs[index]!;
        const deliveryClaim = {
          ...claim(selectedRun),
          profile: selectedProfile,
          delivery: { ...claim(selectedRun).delivery, adapter: selectedProfile.adapter },
        };
        await supervisor.start(selectedRun, selectedProfile);
        expect([...supervisor.capabilities(deliveryClaim)]).toEqual(
          selectedProfile.adapter === "pi-rpc"
            ? ["terminal", "queue", "steer"]
            : ["terminal", "queue"],
        );
        await supervisor.deliver(deliveryClaim, "terminal");
      }
      await supervisor.close();
    }

    expect(created).toEqual(["pi-rpc", "copilot-cli", "pi-rpc", "copilot-cli"]);
    expect(pasteToRun).toHaveBeenCalledTimes(4);
  });
});
