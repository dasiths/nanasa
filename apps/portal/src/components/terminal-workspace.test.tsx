import type { PortalSnapshot, TerminalEndpointStatus } from "@nanasa/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { TerminalWorkspace } from "./terminal-workspace.js";

vi.mock("../terminal/terminal-console.js", () => ({
  TerminalConsole: ({ label }: { label: string }) => <div data-testid="owned-xterm">{label}</div>,
}));

const timestamp = "2026-08-29T00:00:00.000Z";
const limits = {
  maxFrameBytes: 262144,
  maxInputBytes: 65536,
  maxPasteBytes: 196608,
  maxOutputQueueBytes: 1048576,
  maxViewers: 4,
  maxObservers: 3,
  maxReadLines: 5000,
  maxReadBytes: 1048576,
  heartbeatMs: 5000,
  leaseMs: 15000,
  reconnectHistoryFrames: 256,
};

function ready(runId: string): TerminalEndpointStatus {
  return {
    runId,
    provider: "nanasa-terminal.v1",
    state: "ready",
    streamUrl: `/api/v1/terminal-stream/${runId}`,
    protocol: "nanasa-terminal.v1",
    limits,
    observers: 0,
  };
}

function client(): PortalClient {
  return {
    createConsole: vi.fn(),
    closeConsole: vi.fn(),
    loadMetadata: vi.fn(),
    loadSnapshot: vi.fn<() => Promise<PortalSnapshot>>(),
    loadConfig: vi.fn(),
    loadConfigStatus: vi.fn(),
    loadServiceStatus: vi.fn(),
    loadRemoteStatus: vi.fn(),
    planServiceRestart: vi.fn(),
    listProviderStates: vi.fn(),
    listProviderExtensions: vi.fn(),
    inspectProviderExtension: vi.fn(),
    planProviderExtension: vi.fn(),
    providerExtensionHealth: vi.fn(),
    trustProviderExtension: vi.fn(),
    installProviderExtension: vi.fn(),
    repairProviderExtension: vi.fn(),
    disableProviderExtension: vi.fn(),
    rollbackProviderExtension: vi.fn(),
    removeProviderExtension: vi.fn(),
    retainProviderState: vi.fn(),
    deleteProviderState: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    removeAgent: vi.fn(),
    reorderAgents: vi.fn(),
    reorderGroups: vi.fn(),
    reparentAgent: vi.fn(),
    assignCheckout: vi.fn(),
    createWorktree: vi.fn(),
    openCheckout: vi.fn(),
    removeWorktree: vi.fn(),
    updateRolePresentation: vi.fn(),
    startRun: vi.fn(),
    startAllRuns: vi.fn(),
    stopRun: vi.fn(),
    submitMessage: vi.fn(),
    createAgentAction: vi.fn(),
    loadActionWorkspace: vi.fn(),
    cancelAgentAction: vi.fn(),
    replyOpenWait: vi.fn(),
    acknowledgeCompletion: vi.fn(),
    loadMessages: vi.fn(),
    clearMessages: vi.fn(),
    getTerminalEndpointStatus: vi.fn(async (runId) => ready(runId)),
    readTerminal: vi.fn(),
    listTerminalCheckpoints: vi.fn().mockResolvedValue([]),
    createTerminalCheckpoint: vi.fn(),
    getTerminalCheckpoint: vi.fn(),
    deleteTerminalCheckpoint: vi.fn(),
    createEventsSocket: vi.fn(),
  };
}

afterEach(() => window.localStorage.clear());

describe("TerminalWorkspace", () => {
  it("mounts a portal-owned terminal without an iframe", async () => {
    const member = {
      id: "agent-one",
      groupId: "group-one",
      memberId: "member-one",
      agentProfileId: "profile-one",
      alias: "Builder",
      roleId: "implementor",
      order: 0,
      state: "active" as const,
      joinedAt: timestamp,
    };
    const run = {
      id: "run-one",
      groupId: "group-one",
      memberId: "member-one",
      agentProfileId: "profile-one",
      generation: 1,
      status: "running" as const,
      desiredState: "running" as const,
      recoveryPhase: "recovered" as const,
      recoveryAttempts: 0,
      launchKind: "fresh" as const,
      requestedModelSource: "provider-default" as const,
      terminal: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
      startedAt: timestamp,
    };
    const { container } = render(
      <TerminalWorkspace client={client()} members={[member]} runs={[run]} />,
    );
    expect(await screen.findByTestId("owned-xterm")).toHaveTextContent(
      "Builder (member-one) terminal console",
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("persists pinning, maximize, and a browser-local grid split without remounting terminals", async () => {
    const members = ["one", "two"].map((id, order) => ({
      id: `agent-${id}`,
      groupId: "group-one",
      memberId: `member-${id}`,
      agentProfileId: "profile-one",
      alias: id === "one" ? "Builder" : "Reviewer",
      order,
      state: "active" as const,
      joinedAt: timestamp,
    }));
    const runs = members.map((member, index) => ({
      id: `run-${index + 1}`,
      groupId: "group-one",
      memberId: member.memberId,
      agentProfileId: "profile-one",
      generation: 1,
      status: "running" as const,
      desiredState: "running" as const,
      recoveryPhase: "recovered" as const,
      recoveryAttempts: 0,
      launchKind: "fresh" as const,
      requestedModelSource: "provider-default" as const,
      terminal: {
        serverName: "nanasa",
        sessionId: "$1",
        windowId: `@${index + 1}`,
        paneId: `%${index + 1}`,
      },
      startedAt: timestamp,
    }));
    const { container } = render(
      <TerminalWorkspace client={client()} members={members} runs={runs} />,
    );
    const initialMounts = await screen.findAllByTestId("owned-xterm");
    expect(initialMounts).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Grid terminal layout" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Grid terminal layout" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pin Reviewer terminal" }));
    fireEvent.change(screen.getByRole("slider", { name: "Terminal split ratio" }), {
      target: { value: "65" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Maximize Builder terminal" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Unpin Reviewer terminal", hidden: true }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restore Builder terminal" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(container.querySelector(".terminal-pane-slot[hidden]")).not.toBeNull();
    expect(container.querySelector(".terminal-layout")).toHaveStyle({
      "--terminal-first-ratio": "65%",
    });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      expect.stringContaining("Reviewer"),
      expect.stringContaining("Builder"),
    ]);
    expect(screen.getAllByTestId("owned-xterm")).toEqual([initialMounts[1], initialMounts[0]]);
    expect(
      JSON.parse(window.localStorage.getItem("nanasa.portal.preferences.v2") ?? "{}"),
    ).toMatchObject({
      pinnedRunIdsByGroup: { "group-one": ["run-2"] },
      maximizedRunByGroup: { "group-one": "run-1" },
      terminalSplitRatioByGroup: { "group-one": 65 },
    });
  });
});
