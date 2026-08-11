import type {
  AgentProfile,
  AgentRun,
  GroupMembership,
  NanasaConfig,
  PortalSnapshot,
  TerminalEndpointStatus,
} from "@nanasa/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortalClient } from "../api.js";
import { PORTAL_PREFERENCES_KEY } from "../hooks/use-portal-preferences.js";
import { TerminalWorkspace } from "./terminal-workspace.js";

const timestamp = "2026-08-09T12:00:00.000Z";
const endpointPaths = {
  "run-builder": "/terminals/11111111111111111111111111111111/",
  "run-reviewer": "/terminals/22222222222222222222222222222222/",
} as const;

const roles = {
  implementor: {
    name: "Implementor",
    instructions: [],
    permissionPolicy: "inherit",
    presentation: { icon: "hammer", color: "blue", shortName: "Build" },
  },
  reviewer: {
    name: "Reviewer",
    instructions: [],
    permissionPolicy: "read-only",
    presentation: { icon: "shield-check", color: "amber", shortName: "Review" },
  },
} satisfies NanasaConfig["roles"];

const members: GroupMembership[] = [
  {
    id: "membership-builder",
    groupId: "group-backend",
    memberId: "builder",
    agentProfileId: "profile-copilot",
    alias: "Builder",
    roleId: "implementor",
    state: "active",
    joinedAt: timestamp,
  },
  {
    id: "membership-reviewer",
    groupId: "group-backend",
    memberId: "reviewer",
    agentProfileId: "profile-copilot",
    alias: "Reviewer",
    roleId: "reviewer",
    state: "active",
    joinedAt: timestamp,
  },
];

const runs: AgentRun[] = members.map((member, index) => ({
  id: index === 0 ? "run-builder" : "run-reviewer",
  groupId: member.groupId,
  memberId: member.memberId,
  agentProfileId: member.agentProfileId,
  generation: 1,
  status: "running",
  desiredState: "running",
  recoveryPhase: "idle",
  recoveryAttempts: 0,
  terminal: {
    serverName: "nanasa",
    sessionId: "$1",
    windowId: `@${index + 1}`,
    paneId: `%${index + 1}`,
  },
  startedAt: timestamp,
}));

function ready(runId: keyof typeof endpointPaths): TerminalEndpointStatus {
  return { runId, provider: "ttyd", state: "ready", url: endpointPaths[runId] };
}

function createClient(
  getTerminalEndpointStatus: PortalClient["getTerminalEndpointStatus"],
): PortalClient {
  return {
    loadSnapshot: vi.fn<() => Promise<PortalSnapshot>>(),
    loadConfig: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn(),
    createAgentProfile: vi.fn<() => Promise<AgentProfile>>(),
    updateAgentProfile: vi.fn(),
    updateRolePresentation: vi.fn(),
    addMembership: vi.fn(),
    updateMembership: vi.fn(),
    removeMembership: vi.fn(),
    reorderMemberships: vi.fn(),
    startRun: vi.fn(),
    startAllRuns: vi.fn(),
    stopRun: vi.fn(),
    submitMessage: vi.fn(),
    loadMessages: vi.fn(),
    clearMessages: vi.fn(),
    getTerminalEndpointStatus,
    createEventsSocket: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("TerminalWorkspace", () => {
  it("uses semantic agent status colors in tabs while the terminal is ready", async () => {
    const client = createClient(vi.fn(async (runId) => ready(runId as keyof typeof endpointPaths)));
    const { container } = render(
      <TerminalWorkspace
        client={client}
        members={members}
        roles={roles}
        runs={runs}
        agentStatuses={[
          {
            groupId: "group-backend",
            memberId: "builder",
            alias: "Builder",
            agentType: "copilot",
            runId: "run-builder",
            generation: 1,
            runStatus: "running",
            state: "waiting",
            phase: "settled",
            outcome: "unknown",
            confidence: "high",
            attention: "none",
            observedAt: timestamp,
            stateChangedAt: timestamp,
          },
        ]}
      />,
    );

    await screen.findByTitle("Builder (builder) ttyd terminal");
    const builderTab = screen.getByRole("tab", { name: /Builder/ });
    expect(builderTab).toHaveClass("role-color-blue");
    expect(builderTab.querySelector(".status-dot")).toHaveClass("status-waiting");
    expect(builderTab.querySelector(".status-dot")).not.toHaveClass("status-running");
    expect(within(builderTab).getByLabelText("Role Implementor")).toHaveTextContent("Build");
    expect(
      within(screen.getByRole("region", { name: "Builder (builder) terminal" })).getByLabelText(
        "Role Implementor",
      ),
    ).toHaveTextContent("Build");
    expect(screen.getByRole("region", { name: "Builder (builder) terminal" })).toHaveClass(
      "role-color-blue",
    );
    const titleBar = screen
      .getByRole("region", { name: "Builder (builder) terminal" })
      .querySelector(".terminal-statusbar");
    const memberId = within(titleBar as HTMLElement).getByLabelText("Member ID builder");
    expect(memberId).toHaveTextContent("builder");
    expect(memberId).toHaveAttribute("title", "builder");
    expect(memberId.parentElement).toHaveClass("terminal-title-tools");
    expect(titleBar?.lastElementChild).toBe(memberId.parentElement);
    expect(container.querySelector(".connection-ready")).toBeInTheDocument();
  });

  it("mounts only the selected run iframe in tabs", async () => {
    const client = createClient(vi.fn(async (runId) => ready(runId as keyof typeof endpointPaths)));
    render(<TerminalWorkspace client={client} members={members} roles={roles} runs={runs} />);

    const builderFrame = await screen.findByTitle("Builder (builder) ttyd terminal");
    expect(screen.getAllByTitle(/ttyd terminal$/)).toHaveLength(1);
    expect(builderFrame).toHaveAttribute("src", endpointPaths["run-builder"]);
    expect(builderFrame).not.toHaveAttribute("sandbox");
    expect(builderFrame).toHaveAttribute("referrerpolicy", "same-origin");

    fireEvent.click(screen.getByRole("tab", { name: /Reviewer/ }));
    const reviewerFrame = await screen.findByTitle("Reviewer (reviewer) ttyd terminal");
    expect(screen.getAllByTitle(/ttyd terminal$/)).toHaveLength(1);
    expect(reviewerFrame).toHaveAttribute("src", endpointPaths["run-reviewer"]);
  });

  it("copies member IDs from terminal title bars instead of tabs", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const client = createClient(vi.fn(async (runId) => ready(runId as keyof typeof endpointPaths)));
    render(<TerminalWorkspace client={client} members={members} runs={runs} />);

    expect(
      within(screen.getByRole("tablist", { name: "Agent terminals" })).queryByRole("button", {
        name: "Copy member ID builder",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("region", { name: "Builder (builder) terminal" })).getByRole(
        "button",
        { name: "Copy member ID builder" },
      ),
    );

    expect(writeText).toHaveBeenCalledWith("builder");
  });

  it("mounts one isolated ready iframe per run in grid layout", async () => {
    const client = createClient(vi.fn(async (runId) => ready(runId as keyof typeof endpointPaths)));
    render(<TerminalWorkspace client={client} members={members} roles={roles} runs={runs} />);

    fireEvent.click(screen.getByRole("button", { name: "Grid terminal layout" }));
    await waitFor(() => expect(screen.getAllByTitle(/ttyd terminal$/)).toHaveLength(2));
    expect(screen.getByTitle("Builder (builder) ttyd terminal")).toHaveAttribute(
      "src",
      endpointPaths["run-builder"],
    );
    expect(screen.getByTitle("Builder (builder) ttyd terminal")).not.toHaveAttribute("sandbox");
    expect(screen.getByTitle("Reviewer (reviewer) ttyd terminal")).toHaveAttribute(
      "src",
      endpointPaths["run-reviewer"],
    );
    expect(screen.getByTitle("Reviewer (reviewer) ttyd terminal")).not.toHaveAttribute("sandbox");
    expect(
      within(screen.getByRole("region", { name: "Builder (builder) terminal" })).getByLabelText(
        "Role Implementor",
      ),
    ).toHaveTextContent("Build");
    expect(
      within(screen.getByRole("region", { name: "Reviewer (reviewer) terminal" })).getByLabelText(
        "Role Reviewer",
      ),
    ).toHaveTextContent("Review");
    expect(screen.getByRole("region", { name: "Reviewer (reviewer) terminal" })).toHaveClass(
      "role-color-amber",
    );
  });

  it("uses incoming membership order for tabs and grid panes", async () => {
    const client = createClient(vi.fn(async (runId) => ready(runId as keyof typeof endpointPaths)));
    render(
      <TerminalWorkspace
        client={client}
        members={[...members].reverse()}
        roles={roles}
        runs={runs}
      />,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      expect.stringContaining("Reviewer"),
      expect.stringContaining("Builder"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Grid terminal layout" }));
    await waitFor(() => expect(screen.getAllByTitle(/ttyd terminal$/)).toHaveLength(2));
    expect(
      screen
        .getAllByRole("region", { name: /terminal$/ })
        .map((pane) => pane.getAttribute("aria-label")),
    ).toEqual(["Reviewer (reviewer) terminal", "Builder (builder) terminal"]);
  });

  it("releases hidden grid clients when returning to the selected tab", async () => {
    const client = createClient(vi.fn(async (runId) => ready(runId as keyof typeof endpointPaths)));
    render(<TerminalWorkspace client={client} members={members} runs={runs} />);

    fireEvent.click(screen.getByRole("tab", { name: /Reviewer/ }));
    await screen.findByTitle("Reviewer (reviewer) ttyd terminal");
    fireEvent.click(screen.getByRole("button", { name: "Grid terminal layout" }));
    await waitFor(() => expect(screen.getAllByTitle(/ttyd terminal$/)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Tabbed terminal layout" }));

    await waitFor(() => expect(screen.getAllByTitle(/ttyd terminal$/)).toHaveLength(1));
    expect(screen.getByTitle("Reviewer (reviewer) ttyd terminal")).toHaveAttribute(
      "src",
      endpointPaths["run-reviewer"],
    );
    expect(screen.queryByTitle("Builder (builder) ttyd terminal")).not.toBeInTheDocument();
  });

  it("persists layout and synchronizes storage changes across tabs", async () => {
    window.localStorage.setItem(
      PORTAL_PREFERENCES_KEY,
      JSON.stringify({ theme: "system", terminalLayout: "grid" }),
    );
    const client = createClient(vi.fn(async (runId) => ready(runId as keyof typeof endpointPaths)));
    render(<TerminalWorkspace client={client} members={members} runs={runs} />);

    await waitFor(() => expect(screen.getAllByTitle(/ttyd terminal$/)).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Grid terminal layout" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: PORTAL_PREFERENCES_KEY,
        newValue: JSON.stringify({ theme: "dark", terminalLayout: "tabs" }),
      }),
    );
    await waitFor(() => expect(screen.getAllByTitle(/ttyd terminal$/)).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Tabbed terminal layout" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("uses default preferences when persisted storage is malformed", () => {
    window.localStorage.setItem(PORTAL_PREFERENCES_KEY, "not-json");
    const client = createClient(vi.fn(async (runId) => ready(runId as keyof typeof endpointPaths)));
    render(<TerminalWorkspace client={client} members={members} runs={runs} />);

    expect(screen.getByRole("button", { name: "Tabbed terminal layout" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps layout controls usable when local storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const client = createClient(vi.fn(async (runId) => ready(runId as keyof typeof endpointPaths)));
    render(<TerminalWorkspace client={client} members={members} runs={runs} />);

    fireEvent.click(screen.getByRole("button", { name: "Grid terminal layout" }));
    expect(screen.getByRole("button", { name: "Grid terminal layout" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders portal-owned loading and unavailable states outside an iframe", async () => {
    let resolveStatus: (status: TerminalEndpointStatus) => void = () => undefined;
    const statusPromise = new Promise<TerminalEndpointStatus>((resolve) => {
      resolveStatus = resolve;
    });
    const client = createClient(vi.fn(() => statusPromise));
    render(<TerminalWorkspace client={client} members={members.slice(0, 1)} runs={runs} />);

    expect(screen.getByText("Loading terminal")).toBeInTheDocument();
    expect(screen.queryByTitle(/ttyd terminal$/)).not.toBeInTheDocument();
    resolveStatus({
      runId: "run-builder",
      provider: "ttyd",
      state: "unavailable",
      error: { code: "ttyd_missing", message: "ttyd is not installed" },
    });
    expect(await screen.findByText("Terminal unavailable")).toBeInTheDocument();
    expect(screen.getByText("ttyd is not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByTitle(/ttyd terminal$/)).not.toBeInTheDocument();
  });

  it("retries a backoff endpoint and mounts the iframe when it becomes ready", async () => {
    vi.useFakeTimers();
    const getStatus = vi
      .fn<PortalClient["getTerminalEndpointStatus"]>()
      .mockResolvedValueOnce({
        runId: "run-builder",
        provider: "ttyd",
        state: "backoff",
        retryAfterMs: 100,
      })
      .mockResolvedValue(ready("run-builder"));
    const client = createClient(getStatus);
    render(<TerminalWorkspace client={client} members={members.slice(0, 1)} runs={runs} />);

    await act(async () => Promise.resolve());
    expect(screen.getByText("Terminal retrying")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByTitle("Builder (builder) ttyd terminal")).toHaveAttribute(
      "src",
      endpointPaths["run-builder"],
    );
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("shows stopped and one-client states outside the iframe", async () => {
    const stoppedRun: AgentRun = { ...runs[0]!, status: "stopped", stoppedAt: timestamp };
    const client = createClient(
      vi.fn().mockResolvedValue({
        runId: stoppedRun.id,
        provider: "ttyd",
        state: "stopped",
      }),
    );
    render(<TerminalWorkspace client={client} members={members.slice(0, 1)} runs={[stoppedRun]} />);

    expect(await screen.findByText("Terminal stopped")).toBeInTheDocument();
    expect(screen.queryByTitle(/ttyd terminal$/)).not.toBeInTheDocument();
    expect(screen.getByText(/One live terminal client is allowed per run/)).toBeInTheDocument();
  });
});
