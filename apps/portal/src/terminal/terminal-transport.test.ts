import type { TerminalEndpointStatus } from "@nanasa/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTransport } from "./terminal-transport.js";

class MockWebSocket {
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;
  public readonly sent: string[] = [];
  public readyState = MockWebSocket.OPEN;
  readonly #listeners = new Map<string, Array<(event: never) => void>>();

  public constructor(
    public readonly url: string,
    public readonly protocol: string,
  ) {
    sockets.push(this);
  }

  public addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  public emit(type: string, event: unknown = {}): void {
    if (type === "close") this.readyState = MockWebSocket.CLOSED;
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }
}

const sockets: MockWebSocket[] = [];
const endpoint: Extract<TerminalEndpointStatus, { state: "ready" }> = {
  runId: "run-one",
  provider: "nanasa-terminal.v1",
  state: "ready",
  streamUrl: "/api/v1/terminal-stream/run-one",
  protocol: "nanasa-terminal.v1",
  limits: {
    maxFrameBytes: 262_144,
    maxInputBytes: 65_536,
    maxPasteBytes: 196_608,
    maxOutputQueueBytes: 1_048_576,
    maxViewers: 4,
    maxObservers: 3,
    maxReadLines: 5_000,
    maxReadBytes: 1_048_576,
    heartbeatMs: 5_000,
    leaseMs: 15_000,
    reconnectHistoryFrames: 256,
  },
  observers: 0,
};

beforeEach(() => {
  sockets.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function hello(socket: MockWebSocket): Record<string, unknown> {
  socket.emit("open");
  return JSON.parse(socket.sent.at(-1) ?? "{}") as Record<string, unknown>;
}

function welcome(socket: MockWebSocket, role: "controller" | "observer"): void {
  socket.emit("message", {
    data: JSON.stringify({
      type: "welcome",
      version: 1,
      daemonEpoch: 1,
      streamId: `stream-${role}`,
      streamGeneration: 1,
      runId: "run-one",
      runGeneration: 1,
      binding: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
      role,
      inputState: "interactive",
      ...(role === "controller"
        ? {
            lease: {
              id: "lease-one",
              runId: "run-one",
              viewerId: "viewer-one",
              role: "controller",
              runGeneration: 1,
              streamGeneration: 1,
              acquiredAt: "2026-08-31T00:00:00.000Z",
              expiresAt: "2026-08-31T00:01:00.000Z",
            },
          }
        : {}),
      limits: endpoint.limits,
      capabilities: {
        input: role === "controller",
        paste: role === "controller",
        focus: role === "controller",
        resize: role === "controller",
        effects: role === "controller",
        read: true,
        checkpoints: true,
      },
    }),
  });
}

describe("TerminalTransport control mode", () => {
  it("retains explicit takeover through network reconnect but yields after displacement", () => {
    const transport = new TerminalTransport({
      endpoint,
      runGeneration: 1,
      viewerId: "viewer-one",
      requestedRole: "controller",
      cols: 100,
      rows: 30,
      onFrame: vi.fn(),
      onState: vi.fn(),
    });

    transport.connect();
    expect(hello(sockets[0]!).takeover).toBe(false);
    transport.takeover();
    transport.resize(132, 44);

    sockets[0]!.emit("close", { code: 1006 });
    vi.runOnlyPendingTimers();
    expect(hello(sockets[1]!)).toMatchObject({ takeover: true, cols: 132, rows: 44 });

    sockets[1]!.emit("close", { code: 4001 });
    vi.runOnlyPendingTimers();
    expect(hello(sockets[2]!)).toMatchObject({
      takeover: false,
      requestedRole: "observer",
      cols: 132,
      rows: 44,
    });
    transport.dispose();
  });

  it("retains explicit Observe mode across reconnect", () => {
    const transport = new TerminalTransport({
      endpoint,
      runGeneration: 1,
      viewerId: "viewer-one",
      requestedRole: "controller",
      cols: 100,
      rows: 30,
      onFrame: vi.fn(),
      onState: vi.fn(),
    });

    transport.connect();
    hello(sockets[0]!);
    welcome(sockets[0]!, "controller");
    transport.releaseController();
    sockets[0]!.emit("close", { code: 1006 });
    vi.runOnlyPendingTimers();

    expect(hello(sockets[1]!)).toMatchObject({
      requestedRole: "observer",
      takeover: false,
    });
    transport.dispose();
  });

  it("reports connected only after baseline initialization", () => {
    const onState = vi.fn();
    const transport = new TerminalTransport({
      endpoint,
      runGeneration: 1,
      viewerId: "viewer-one",
      requestedRole: "controller",
      cols: 100,
      rows: 30,
      onFrame: vi.fn(),
      onState,
    });

    transport.connect();
    hello(sockets[0]!);
    welcome(sockets[0]!, "observer");
    expect(onState).not.toHaveBeenCalledWith("connected");
    sockets[0]!.emit("message", {
      data: JSON.stringify({ type: "baseline", sequence: 0, data: "ready", truncated: false }),
    });
    expect(onState).toHaveBeenCalledWith("connected");
    transport.dispose();
  });

  it("suppresses controller input until baseline initialization completes", () => {
    const transport = new TerminalTransport({
      endpoint,
      runGeneration: 1,
      viewerId: "viewer-one",
      requestedRole: "controller",
      cols: 100,
      rows: 30,
      onFrame: vi.fn(),
      onState: vi.fn(),
    });

    transport.connect();
    hello(sockets[0]!);
    welcome(sockets[0]!, "controller");
    const before = sockets[0]!.sent.length;
    transport.input("before");
    transport.paste("before");
    transport.focus(true);
    expect(sockets[0]!.sent).toHaveLength(before);

    sockets[0]!.emit("message", {
      data: JSON.stringify({ type: "baseline", sequence: 0, data: "ready", truncated: false }),
    });
    transport.input("after");
    transport.paste("after");
    transport.focus(true);
    expect(sockets[0]!.sent.slice(-3).map((frame) => JSON.parse(frame).type)).toEqual([
      "input",
      "paste",
      "focus",
    ]);
    transport.dispose();
  });

  it("pauses data-plane frames while preserving heartbeat and controller state", () => {
    const transport = new TerminalTransport({
      endpoint,
      runGeneration: 1,
      viewerId: "viewer-one",
      requestedRole: "controller",
      cols: 100,
      rows: 30,
      onFrame: vi.fn(),
      onState: vi.fn(),
    });

    transport.connect();
    hello(sockets[0]!);
    welcome(sockets[0]!, "controller");
    sockets[0]!.emit("message", {
      data: JSON.stringify({ type: "baseline", sequence: 0, data: "ready", truncated: false }),
    });
    transport.focus(true);
    sockets[0]!.emit("message", {
      data: JSON.stringify({ type: "input-state", state: "automated" }),
    });
    const beforePause = sockets[0]!.sent.length;

    transport.input("discarded input");
    transport.paste("discarded paste");
    transport.focus(false);
    transport.resize(132, 44);
    vi.advanceTimersByTime(2_500);

    expect(sockets[0]!.sent.slice(beforePause).map((frame) => JSON.parse(frame).type)).toEqual([
      "heartbeat",
    ]);
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
      type: "heartbeat",
      leaseId: "lease-one",
    });

    sockets[0]!.emit("message", {
      data: JSON.stringify({ type: "input-state", state: "interactive" }),
    });
    expect(sockets[0]!.sent.slice(-2).map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", leaseId: "lease-one", cols: 132, rows: 44 },
      { type: "focus", leaseId: "lease-one", focused: false },
    ]);
    expect(sockets[0]!.sent.some((frame) => frame.includes("discarded input"))).toBe(false);
    expect(sockets[0]!.sent.some((frame) => frame.includes("discarded paste"))).toBe(false);
    transport.dispose();
  });
});
