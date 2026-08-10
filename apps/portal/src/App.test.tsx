import type {
  AgentProfile,
  AgentRun,
  GroupMembership,
  MessageSubmissionResult,
  NanasaConfig,
  PortalSnapshot,
  StartGroupRunsResult,
} from "@nanasa/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type { PortalClient } from "./api.js";
import { GroupTree } from "./components/group-tree.js";
import { buildMessageCommand } from "./components/message-workspace.js";
import { PORTAL_PREFERENCES_KEY } from "./hooks/use-portal-preferences.js";

vi.mock("./components/terminal-workspace.js", () => ({
  TerminalWorkspace: () => <div data-testid="terminal-surface">terminal-surface</div>,
}));

const timestamp = "2026-08-09T12:00:00.000Z";

const config: NanasaConfig = {
  version: 1,
  agentTypes: {
    copilot: {
      key: "copilot",
      name: "GitHub Copilot",
      kind: "copilot",
      adapter: "copilot-cli",
      command: ["copilot", "--acp", "--stdio"],
      environment: {},
      recovery: "resume-or-restart",
      capabilities: ["queue"],
    },
    "claude-copilot": {
      key: "claude-copilot",
      name: "Claude through Copilot",
      kind: "claude-code",
      adapter: "terminal",
      command: ["make", "claude-copilot"],
      environment: {},
      recovery: "restart",
      capabilities: ["queue"],
    },
    "custom-agent": {
      key: "custom-agent",
      name: "Custom reviewer",
      kind: "opencode",
      adapter: "terminal",
      command: ["custom-reviewer"],
      environment: {},
      recovery: "restart",
      capabilities: ["queue"],
    },
  },
};

const profile: AgentProfile = {
  id: "profile-copilot",
  name: "Copilot default",
  agentType: "copilot",
  kind: "copilot",
  adapter: "copilot-cli",
  capabilities: ["queue"],
  command: "copilot",
  args: [],
  environment: {},
  createdAt: timestamp,
  updatedAt: timestamp,
};

const memberships: GroupMembership[] = [
  {
    id: "membership-builder",
    groupId: "group-backend",
    memberId: "builder",
    agentProfileId: profile.id,
    alias: "Builder",
    state: "active",
    joinedAt: timestamp,
  },
  {
    id: "membership-reviewer",
    groupId: "group-backend",
    memberId: "reviewer",
    agentProfileId: profile.id,
    alias: "Reviewer",
    state: "active",
    joinedAt: timestamp,
  },
  {
    id: "membership-auditor",
    groupId: "group-review",
    memberId: "auditor",
    agentProfileId: profile.id,
    alias: "Auditor",
    state: "active",
    joinedAt: timestamp,
  },
];

const snapshot: PortalSnapshot = {
  sequence: 7,
  generatedAt: timestamp,
  groups: [
    {
      id: "group-backend",
      name: "Backend",
      membershipRevision: 4,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "group-review",
      name: "Review",
      membershipRevision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  agentProfiles: [profile],
  memberships,
  runs: [],
  messages: [],
  deliveryOutcomes: [],
};

function inertSocket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    send: vi.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  } as unknown as WebSocket;
}

function createClient(submission?: MessageSubmissionResult): PortalClient {
  const run: AgentRun = {
    id: "run-builder",
    groupId: "group-backend",
    memberId: "builder",
    agentProfileId: profile.id,
    generation: 1,
    status: "stopped",
    desiredState: "stopped",
    recoveryPhase: "idle",
    recoveryAttempts: 0,
    startedAt: timestamp,
    stoppedAt: timestamp,
  };
  return {
    loadSnapshot: vi.fn().mockResolvedValue(snapshot),
    loadConfig: vi.fn().mockResolvedValue(config),
    createGroup: vi.fn().mockResolvedValue(snapshot.groups[0]),
    createAgentProfile: vi.fn().mockResolvedValue(profile),
    addMembership: vi.fn().mockResolvedValue(memberships[0]),
    startRun: vi.fn().mockResolvedValue(run),
    startAllRuns: vi.fn().mockResolvedValue({ groupId: "group-backend", outcomes: [] }),
    stopRun: vi.fn().mockResolvedValue(run),
    submitMessage: vi.fn().mockImplementation(async () => {
      if (submission === undefined) throw new Error("No submission fixture configured");
      return submission;
    }),
    getEffectiveDeliveryModes: vi.fn<PortalClient["getEffectiveDeliveryModes"]>(
      async (_groupId, command) => ({
        memberIds: command.memberIds,
        modes: ["queue", "steer", "terminal"],
      }),
    ),
    getTerminalEndpointStatus: vi.fn(),
    createEventsSocket: vi.fn().mockImplementation(inertSocket),
  };
}

function submissionResult(): MessageSubmissionResult {
  return {
    message: {
      id: "message-1",
      groupId: "group-backend",
      groupSeq: 1,
      conversationId: "conversation-1",
      intent: "request",
      sender: { kind: "operator", operatorId: "portal-operator" },
      audience: { kind: "dm", memberId: "builder" },
      body: { contentType: "text/markdown", text: "Review the API" },
      delivery: { mode: "steer" },
      hop: 0,
      createdAt: timestamp,
    },
    deliveryOutcomes: [
      {
        messageId: "message-1",
        recipientMemberId: "builder",
        requestedMode: "steer",
        appliedMode: "queue",
        fallbackApplied: true,
        reason: "adapter_does_not_support_steering",
        status: "queued",
        attempts: 0,
        updatedAt: timestamp,
      },
    ],
  };
}

describe("portal application", () => {
  it("opens the add-agent form from the selected group row", async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Add agent to Backend" }));

    expect(screen.getByLabelText("Member alias")).toBeInTheDocument();
    expect(screen.getByLabelText("Profile source")).toBeInTheDocument();
  });

  it("selects the first existing profile when profiles arrive after the form opens", async () => {
    const user = userEvent.setup();
    const onAddAgent = vi.fn().mockResolvedValue(undefined);
    const treeProps = {
      config,
      selectedGroupId: "group-backend",
      unreadCounts: new Map<string, number>(),
      onSelectGroup: vi.fn(),
      onCreateGroup: vi.fn().mockResolvedValue(undefined),
      onAddAgent,
      onStartRun: vi.fn().mockResolvedValue(undefined),
      onStopRun: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(
      <GroupTree {...treeProps} snapshot={{ ...snapshot, agentProfiles: [] }} />,
    );

    await user.click(screen.getByRole("button", { name: "Add agent" }));
    rerender(<GroupTree {...treeProps} snapshot={snapshot} />);
    await user.type(screen.getByLabelText("Member alias"), "Echo worker");
    await user.selectOptions(screen.getByLabelText("Profile source"), "existing");
    await user.click(screen.getByRole("button", { name: "Add member" }));

    expect(onAddAgent).toHaveBeenCalledWith({
      groupId: "group-backend",
      alias: "Echo worker",
      profileId: profile.id,
    });
  });

  it.each([
    ["custom-agent", "Custom reviewer (custom-agent)"],
    ["claude-copilot", "Claude through Copilot (claude-copilot)"],
  ])("creates profiles with the configured %s agent type", async (agentType, optionName) => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Add agent to Backend" }));
    await user.selectOptions(screen.getByLabelText("Profile source"), "new");
    await user.type(screen.getByLabelText("Member alias"), `${agentType} member`);
    await user.type(screen.getByLabelText("Profile name"), `${agentType} profile`);
    await user.selectOptions(screen.getByLabelText("Agent type"), agentType);
    expect(screen.getByRole("option", { name: optionName })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add member" }));

    expect(client.createAgentProfile).toHaveBeenCalledWith({
      name: `${agentType} profile`,
      agentType,
    });
  });

  it("shows a distinct repository configuration error", async () => {
    const client = createClient();
    vi.mocked(client.loadConfig).mockRejectedValue(new Error("agentTypes is invalid"));
    render(<App client={client} />);

    expect(await screen.findByText("Repository configuration unavailable")).toBeInTheDocument();
    expect(screen.getByText("agentTypes is invalid")).toBeInTheDocument();
  });

  it("deduplicates Start all while pending and announces per-member outcomes", async () => {
    const client = createClient();
    let resolveStartAll: (result: StartGroupRunsResult) => void = () => undefined;
    vi.mocked(client.startAllRuns).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStartAll = resolve;
        }),
    );
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });

    const button = screen.getByRole("button", { name: "Start all non-running agents in Backend" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(client.startAllRuns).toHaveBeenCalledTimes(1);
    expect(client.startAllRuns).toHaveBeenCalledWith("group-backend", expect.any(String));

    await act(async () =>
      resolveStartAll({
        groupId: "group-backend",
        outcomes: [
          { groupId: "group-backend", memberId: "builder", status: "started", runId: "run-1" },
          {
            groupId: "group-backend",
            memberId: "reviewer",
            status: "failed",
            reason: "launch_failed",
          },
        ],
      }),
    );
    expect(await screen.findByText("1 started, 0 already running, 1 failed")).toBeInTheDocument();
    expect(screen.getByText("launch_failed")).toBeInTheDocument();
  });

  it.each([
    ["reconciling", "stopped", "Stop Builder"],
    ["resuming", "starting", "Stop Builder"],
    ["restarting", "stopped", "Stop Builder"],
    ["recovered", "running", "Stop Builder"],
    ["failed", "failed", "Retry Builder"],
  ] as const)(
    "renders %s recovery status with the correct action",
    (recoveryPhase, runStatus, actionName) => {
      const run: AgentRun = {
        id: `run-${recoveryPhase}`,
        groupId: "group-backend",
        memberId: "builder",
        agentProfileId: profile.id,
        generation: 2,
        status: runStatus,
        desiredState: "running",
        recoveryPhase,
        recoveryAttempts: 1,
        recoveryReason: "daemon_restart",
        recoveryNotBefore: recoveryPhase === "restarting" ? "2026-08-10T12:00:00.000Z" : undefined,
        startedAt: timestamp,
      };
      render(
        <GroupTree
          snapshot={{ ...snapshot, memberships: memberships.slice(0, 1), runs: [run] }}
          config={config}
          selectedGroupId="group-backend"
          unreadCounts={new Map()}
          onSelectGroup={vi.fn()}
          onCreateGroup={vi.fn()}
          onAddAgent={vi.fn()}
          onStartRun={vi.fn()}
          onStopRun={vi.fn()}
        />,
      );

      expect(screen.getByText(new RegExp(`^${recoveryPhase}`))).toHaveAttribute(
        "title",
        "daemon_restart",
      );
      expect(screen.getByRole("button", { name: actionName })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start Builder" })).not.toBeInTheDocument();
    },
  );

  it("offers Start for a normally stopped desired-stopped run", () => {
    const stoppedRun: AgentRun = {
      id: "run-stopped",
      groupId: "group-backend",
      memberId: "builder",
      agentProfileId: profile.id,
      generation: 1,
      status: "stopped",
      desiredState: "stopped",
      recoveryPhase: "idle",
      recoveryAttempts: 0,
      startedAt: timestamp,
      stoppedAt: timestamp,
    };
    render(
      <GroupTree
        snapshot={{ ...snapshot, memberships: memberships.slice(0, 1), runs: [stoppedRun] }}
        config={config}
        selectedGroupId="group-backend"
        unreadCounts={new Map()}
        onSelectGroup={vi.fn()}
        onCreateGroup={vi.fn()}
        onAddAgent={vi.fn()}
        onStartRun={vi.fn()}
        onStopRun={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Start Builder" })).toBeInTheDocument();
    expect(screen.getByText(/GitHub Copilot \(copilot\)/)).toBeInTheDocument();
  });

  it("persists and synchronizes the selected theme", async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);
    await screen.findByRole("heading", { name: "Backend" });

    await user.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(JSON.parse(window.localStorage.getItem(PORTAL_PREFERENCES_KEY) ?? "{}")).toMatchObject({
      theme: "dark",
    });

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: PORTAL_PREFERENCES_KEY,
        newValue: JSON.stringify({ theme: "light", terminalLayout: "grid" }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Use light theme" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("selects a group from the tree and updates the workspace", async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    expect(await screen.findByRole("heading", { name: "Backend" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review1" }));

    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByText(/1 members/)).toBeInTheDocument();
  });

  it("keeps Terminal Mode and Message Mode as separate surfaces", async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    expect(await screen.findByTestId("terminal-surface")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Message composer" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Message Mode" }));

    expect(screen.getByRole("heading", { name: "Message composer" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-surface")).not.toBeInTheDocument();
  });

  it("builds a broadcast payload with the current membership revision", () => {
    const command = buildMessageCommand(snapshot.groups[0]!, {
      audienceKind: "group",
      recipientIds: [],
      intent: "inform",
      deliveryMode: "queue",
      body: "Deployment is complete",
    });

    expect(command).toMatchObject({
      sender: { kind: "operator", operatorId: "portal-operator" },
      audience: { kind: "group", membershipRevision: 4 },
      intent: "inform",
      delivery: { mode: "queue" },
      body: { contentType: "text/markdown", text: "Deployment is complete" },
    });
  });

  it("submits a structured message and renders recipient delivery outcomes", async () => {
    const user = userEvent.setup();
    const client = createClient(submissionResult());
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Message Mode" }));
    await screen.findByRole("option", { name: "Steer current work" });
    await user.selectOptions(screen.getByLabelText("Delivery mode"), "steer");
    await user.type(screen.getByLabelText("Message body"), "Review the API");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("requested steer")).toBeInTheDocument();
    expect(screen.getByText("applied queue")).toBeInTheDocument();
    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(screen.getByText("adapter_does_not_support_steering")).toBeInTheDocument();
    expect(client.submitMessage).toHaveBeenCalledWith(
      "group-backend",
      expect.objectContaining({
        audience: { kind: "dm", memberId: "builder" },
        delivery: { mode: "steer" },
      }),
    );
  });

  it("submits terminal input for a DM and shows the direct TUI warning", async () => {
    const user = userEvent.setup();
    const client = createClient(submissionResult());
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Message Mode" }));
    await screen.findByRole("option", { name: "Terminal input" });

    await user.selectOptions(screen.getByLabelText("Delivery mode"), "terminal");
    expect(
      screen.getByText(/pastes this message directly into each selected TUI and sends Enter/),
    ).toBeInTheDocument();
    expect(screen.getByText(/no semantic completion acknowledgement/)).toBeInTheDocument();
    expect(
      screen.getByText(/Terminal Mode remains the separate direct keyboard workspace/),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Message body"), "Run the focused checks");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(client.submitMessage).toHaveBeenCalledWith(
      "group-backend",
      expect.objectContaining({
        audience: { kind: "dm", memberId: "builder" },
        delivery: { mode: "terminal" },
      }),
    );
  });

  it("resolves common modes again for multicast and group audiences", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Message Mode" }));
    await waitFor(() =>
      expect(client.getEffectiveDeliveryModes).toHaveBeenCalledWith("group-backend", {
        memberIds: ["builder"],
      }),
    );

    await user.selectOptions(screen.getByLabelText("Audience"), "multicast");
    await waitFor(() =>
      expect(client.getEffectiveDeliveryModes).toHaveBeenCalledWith("group-backend", {
        memberIds: ["builder", "reviewer"],
      }),
    );

    await user.click(screen.getByLabelText("Reviewer"));
    expect(
      await screen.findByText("No common delivery mode is available for the selected recipients."),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Audience"), "group");
    await waitFor(() =>
      expect(client.getEffectiveDeliveryModes).toHaveBeenLastCalledWith("group-backend", {
        memberIds: ["builder", "reviewer"],
      }),
    );
  });
});
