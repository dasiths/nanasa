import type { TerminalEndpointStatus, TerminalServerFrame } from "@nanasa/contracts";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { TerminalConsole } from "./terminal-console.js";

interface MockController {
  terminal: { cols: number; rows: number };
  write: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  selectAll: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
  setFitEnabled: ReturnType<typeof vi.fn>;
}

interface MockTransport {
  options: {
    cols: number;
    rows: number;
    onFrame(frame: TerminalServerFrame): void;
    onState(state: "connecting" | "connected" | "reconnecting" | "closed"): void;
  };
  resize: ReturnType<typeof vi.fn>;
  releaseController: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  controllers: [] as MockController[],
  transports: [] as MockTransport[],
}));

vi.mock("./xterm-controller.js", () => ({
  XtermController: class {
    public readonly terminal = { cols: 101, rows: 33 };
    public readonly write = vi.fn();
    public readonly replace = vi.fn();
    public readonly reset = vi.fn();
    public readonly focus = vi.fn();
    public readonly search = vi.fn();
    public readonly selectAll = vi.fn();
    public readonly clearSelection = vi.fn();
    public readonly setTheme = vi.fn();
    public readonly setVisible = vi.fn();
    public readonly setFitEnabled = vi.fn();
    public readonly dispose = vi.fn();

    public constructor() {
      mocks.controllers.push(this);
    }
  },
}));

vi.mock("./terminal-transport.js", () => ({
  TerminalTransport: class {
    public readonly connect = vi.fn();
    public readonly dispose = vi.fn();
    public readonly input = vi.fn();
    public readonly paste = vi.fn();
    public readonly focus = vi.fn();
    public readonly resize = vi.fn();
    public readonly takeover = vi.fn();
    public readonly releaseController = vi.fn();

    public constructor(public readonly options: MockTransport["options"]) {
      mocks.transports.push(this);
    }
  },
}));

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

const client = {} as PortalClient;

afterEach(() => {
  cleanup();
  mocks.controllers.length = 0;
  mocks.transports.length = 0;
});

describe("TerminalConsole", () => {
  it("places accessible icon actions in the mode bar and leaves right click to the TUI", async () => {
    const user = userEvent.setup();
    render(
      <TerminalConsole
        client={client}
        endpoint={endpoint}
        runGeneration={1}
        theme="dark"
        label="Test terminal"
      />,
    );

    const console = screen.getByLabelText("Test terminal");
    const banner = console.querySelector<HTMLElement>(".terminal-lease-banner")!;
    const toolbar = within(banner).getByRole("toolbar", { name: "Terminal actions" });
    for (const name of ["Copy", "Paste", "Search", "Transcript", "More terminal actions"]) {
      const button = within(toolbar).getByRole("button", { name });
      expect(button).not.toHaveTextContent(name);
      expect(button.querySelector("svg")).not.toBeNull();
    }
    expect(within(toolbar).queryByRole("button", { name: "Terminal selection help" })).toBeNull();
    const info = within(toolbar).getByLabelText("Terminal selection help");
    expect(info.tagName).toBe("SPAN");
    expect(info).toHaveAttribute("tabindex", "0");
    expect(info.querySelector("svg")).not.toBeNull();
    expect(within(banner).getByRole("tooltip")).toHaveTextContent(
      "Hold Shift and drag to select and copy text, or press Ctrl+C with a selection.",
    );
    expect(console.querySelector(".terminal-selection-hint")).toBeNull();

    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    console.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);

    await user.click(within(toolbar).getByRole("button", { name: "More terminal actions" }));
    const menu = within(banner).getByRole("menu", { name: "More terminal actions" });
    await user.click(within(menu).getByRole("menuitem", { name: "Select all scrollback" }));
    expect(mocks.controllers[0]!.selectAll).toHaveBeenCalledOnce();
  });

  it("uses measured dimensions and replaces terminal state for every baseline", () => {
    render(
      <TerminalConsole
        client={client}
        endpoint={endpoint}
        runGeneration={1}
        theme="dark"
        label="Test terminal"
      />,
    );

    const controller = mocks.controllers[0]!;
    const transport = mocks.transports[0]!;
    expect(transport.options).toMatchObject({ cols: 101, rows: 33 });

    act(() => {
      transport.options.onFrame({
        type: "welcome",
        version: 1,
        daemonEpoch: 1,
        streamId: "stream-one",
        streamGeneration: 1,
        runId: "run-one",
        runGeneration: 1,
        binding: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
        role: "controller",
        inputState: "interactive",
        lease: {
          id: "lease-one",
          runId: "run-one",
          viewerId: "viewer-one",
          role: "controller",
          runGeneration: 1,
          streamGeneration: 1,
          acquiredAt: "2026-08-30T00:00:00.000Z",
          expiresAt: "2026-08-30T00:01:00.000Z",
        },
        limits: endpoint.limits,
        capabilities: {
          input: true,
          paste: true,
          focus: true,
          resize: true,
          effects: true,
          read: true,
          checkpoints: true,
        },
      });
      transport.options.onState("connected");
      transport.options.onFrame({ type: "output", sequence: 0, data: "stale" });
      transport.options.onFrame({
        type: "baseline",
        sequence: 1,
        data: "replacement",
        truncated: false,
      });
      transport.options.onFrame({ type: "output", sequence: 2, data: "live" });
    });

    expect(controller.write).toHaveBeenNthCalledWith(1, "stale");
    expect(controller.replace).toHaveBeenCalledWith("replacement");
    expect(controller.write).toHaveBeenNthCalledWith(2, "live");
    expect(transport.resize).toHaveBeenCalledWith(101, 33);
    expect(controller.setFitEnabled).toHaveBeenCalledWith(true);
    const observe = screen.getByRole("button", { name: "Observe" });
    expect(observe).not.toHaveTextContent("Observe");
    expect(observe.querySelector("svg")).not.toBeNull();
  });

  it("freezes fitting when the server assigns observe mode", () => {
    render(
      <TerminalConsole
        client={client}
        endpoint={endpoint}
        runGeneration={1}
        theme="dark"
        label="Test terminal"
      />,
    );

    const controller = mocks.controllers[0]!;
    const transport = mocks.transports[0]!;
    act(() => {
      transport.options.onFrame({
        type: "welcome",
        version: 1,
        daemonEpoch: 1,
        streamId: "stream-observer",
        streamGeneration: 1,
        runId: "run-one",
        runGeneration: 1,
        binding: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
        role: "observer",
        inputState: "interactive",
        limits: endpoint.limits,
        capabilities: {
          input: false,
          paste: false,
          focus: false,
          resize: false,
          effects: false,
          read: true,
          checkpoints: true,
        },
      });
      transport.options.onState("connected");
    });

    expect(controller.setFitEnabled).toHaveBeenCalledWith(false);
    expect(transport.resize).not.toHaveBeenCalled();
    const takeover = screen.getByRole("button", { name: "Take control" });
    expect(takeover).not.toHaveTextContent("Take control");
    expect(takeover.querySelector("svg")).not.toBeNull();
  });

  it("retains denied clipboard effects for retry without rendering their contents", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });
    render(
      <TerminalConsole
        client={client}
        endpoint={endpoint}
        runGeneration={1}
        theme="dark"
        label="Test terminal"
      />,
    );
    const transport = mocks.transports[0]!;
    act(() => {
      transport.options.onFrame({
        type: "welcome",
        version: 1,
        daemonEpoch: 1,
        streamId: "stream-one",
        streamGeneration: 1,
        runId: "run-one",
        runGeneration: 1,
        binding: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
        role: "controller",
        inputState: "interactive",
        lease: {
          id: "lease-one",
          runId: "run-one",
          viewerId: "viewer-one",
          role: "controller",
          runGeneration: 1,
          streamGeneration: 1,
          acquiredAt: "2026-08-30T00:00:00.000Z",
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        limits: endpoint.limits,
        capabilities: {
          input: true,
          paste: true,
          focus: true,
          resize: true,
          effects: true,
          read: true,
          checkpoints: true,
        },
      });
      transport.options.onFrame({
        type: "effect",
        effectId: "effect-one",
        kind: "clipboard-write",
        byteCount: 14,
        preview: "private value",
        data: "private value",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });

    const prompt = screen.getByRole("alertdialog", { name: "Terminal clipboard request" });
    expect(prompt).not.toHaveTextContent("private value");
    await user.click(within(prompt).getByRole("button", { name: "Copy" }));
    expect(prompt).toBeInTheDocument();
    expect(document.querySelector(".terminal-feedback")).toHaveTextContent(
      "Use your browser or operating system Copy command.",
    );

    await user.click(within(prompt).getByRole("button", { name: "Copy" }));
    expect(screen.queryByRole("alertdialog", { name: "Terminal clipboard request" })).toBeNull();
    expect(document.querySelector(".terminal-feedback")).toHaveTextContent(
      "Terminal clipboard request copied.",
    );
  });

  it("ignores already expired clipboard effects", () => {
    render(
      <TerminalConsole
        client={client}
        endpoint={endpoint}
        runGeneration={1}
        theme="dark"
        label="Test terminal"
      />,
    );
    const transport = mocks.transports[0]!;
    act(() => {
      transport.options.onFrame({
        type: "effect",
        effectId: "effect-expired",
        kind: "clipboard-write",
        byteCount: 7,
        preview: "",
        data: "expired",
        expiresAt: new Date(Date.now() - 1).toISOString(),
      });
    });

    expect(screen.queryByRole("alertdialog", { name: "Terminal clipboard request" })).toBeNull();
  });

  it("preserves control and mount identity during automated input", () => {
    const view = render(
      <TerminalConsole
        client={client}
        endpoint={endpoint}
        runGeneration={1}
        theme="dark"
        label="Test terminal"
      />,
    );
    const console = screen.getByLabelText("Test terminal");
    const mountId = console.getAttribute("data-terminal-mount-id");
    const transport = mocks.transports[0]!;
    act(() => {
      transport.options.onFrame({
        type: "welcome",
        version: 1,
        daemonEpoch: 1,
        streamId: "stream-one",
        streamGeneration: 1,
        runId: "run-one",
        runGeneration: 1,
        binding: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
        role: "controller",
        inputState: "interactive",
        lease: {
          id: "lease-one",
          runId: "run-one",
          viewerId: "viewer-one",
          role: "controller",
          runGeneration: 1,
          streamGeneration: 1,
          acquiredAt: "2026-08-30T00:00:00.000Z",
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        limits: endpoint.limits,
        capabilities: {
          input: true,
          paste: true,
          focus: true,
          resize: true,
          effects: true,
          read: true,
          checkpoints: true,
        },
      });
      transport.options.onState("connected");
      transport.options.onFrame({ type: "input-state", state: "automated" });
    });

    expect(screen.getByText("Control mode", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Automated input in progress")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste" })).toBeDisabled();
    expect(transport.releaseController).not.toHaveBeenCalled();
    expect(console).toHaveAttribute("data-terminal-mount-id", mountId);

    act(() => transport.options.onFrame({ type: "input-state", state: "interactive" }));
    expect(screen.queryByText("Automated input in progress")).toBeNull();
    expect(screen.getByRole("button", { name: "Paste" })).toBeEnabled();
    expect(mocks.controllers).toHaveLength(1);
    expect(mocks.transports).toEqual([transport]);
    view.unmount();
  });

  it("updates rendering visibility without recreating the terminal transport", () => {
    const view = render(
      <TerminalConsole
        client={client}
        endpoint={endpoint}
        runGeneration={1}
        theme="dark"
        label="Test terminal"
      />,
    );

    const controller = mocks.controllers[0]!;
    const transport = mocks.transports[0]!;
    view.rerender(
      <TerminalConsole
        client={client}
        endpoint={endpoint}
        runGeneration={1}
        theme="dark"
        label="Test terminal"
        visible={false}
      />,
    );

    expect(controller.setVisible).toHaveBeenLastCalledWith(false);
    expect(mocks.controllers).toHaveLength(1);
    expect(mocks.transports).toEqual([transport]);
  });
});
