import type {
  AgentProfile,
  AgentRun,
  GroupMembership,
  MessageSubmissionResult,
  NanasaConfig,
  PortalSnapshot,
  StartGroupRunsResult,
} from "@nanasa/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type { PortalClient } from "./api.js";
import { GroupTree } from "./components/group-tree.js";
import {
  buildMessageCommand,
  MESSAGE_HISTORY_KEY,
  MessageWorkspace,
} from "./components/message-workspace.js";
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
      command: ["copilot", "--acp", "--stdio"],
      environment: {},
    },
    "claude-copilot": {
      key: "claude-copilot",
      name: "Claude through Copilot",
      kind: "claude-code",
      command: ["make", "claude-copilot"],
      environment: {},
    },
    "custom-agent": {
      key: "custom-agent",
      name: "Custom reviewer",
      kind: "opencode",
      command: ["custom-reviewer"],
      environment: {},
    },
  },
};

const profile: AgentProfile = {
  id: "profile-copilot",
  name: "Copilot default",
  agentType: "copilot",
  kind: "copilot",
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
    updateGroup: vi.fn().mockResolvedValue(snapshot.groups[0]),
    deleteGroup: vi.fn().mockResolvedValue({
      groupId: "group-backend",
      deletedMemberships: 2,
      deletedRuns: 0,
      deletedMessages: 0,
      deletedDeliveries: 0,
    }),
    createAgentProfile: vi.fn().mockResolvedValue(profile),
    addMembership: vi.fn().mockResolvedValue(memberships[0]),
    updateMembership: vi.fn().mockResolvedValue(memberships[0]),
    removeMembership: vi.fn().mockResolvedValue({ ...memberships[0], state: "removed" }),
    startRun: vi.fn().mockResolvedValue(run),
    startAllRuns: vi.fn().mockResolvedValue({ groupId: "group-backend", outcomes: [] }),
    stopRun: vi.fn().mockResolvedValue(run),
    submitMessage: vi.fn().mockImplementation(async () => {
      if (submission === undefined) throw new Error("No submission fixture configured");
      return submission;
    }),
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
      delivery: {},
      hop: 0,
      createdAt: timestamp,
    },
    deliveryOutcomes: [
      {
        messageId: "message-1",
        recipientMemberId: "builder",
        status: "queued",
        attempts: 0,
        updatedAt: timestamp,
      },
    ],
  };
}

describe("portal application", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("refreshes the snapshot when the domain event socket connects", async () => {
    const client = createClient();
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    expect(client.loadSnapshot).toHaveBeenCalledTimes(1);

    const socket = vi.mocked(client.createEventsSocket).mock.results[0]?.value;
    await act(async () => socket?.onopen?.(new Event("open")));

    await waitFor(() => expect(client.loadSnapshot).toHaveBeenCalledTimes(2));
  });

  it("renames groups and agents inline with Enter and cancels edits with Escape", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Rename group Backend" }));
    const groupName = screen.getByRole("textbox", { name: "group name for Backend" });
    await user.clear(groupName);
    await user.type(groupName, "Platform{Enter}");
    await waitFor(() =>
      expect(client.updateGroup).toHaveBeenCalledWith("group-backend", { name: "Platform" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rename group Backend" })).toHaveFocus(),
    );

    await user.click(screen.getByRole("button", { name: "Rename agent Reviewer" }));
    const alias = screen.getByRole("textbox", { name: "agent alias for Reviewer" });
    await user.clear(alias);
    await user.type(alias, "Quality reviewer{Escape}");
    expect(client.updateMembership).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "agent alias for Reviewer" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rename agent Reviewer" })).toHaveFocus(),
    );
  });

  it("prevents concurrent inline rename submissions", async () => {
    const user = userEvent.setup();
    let resolveRename: () => void = () => undefined;
    const onRenameGroup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        }),
    );
    render(
      <GroupTree
        snapshot={snapshot}
        config={config}
        selectedGroupId="group-backend"
        unreadCounts={new Map()}
        onSelectGroup={vi.fn()}
        onCreateGroup={vi.fn()}
        onRenameGroup={onRenameGroup}
        onDeleteGroup={vi.fn()}
        onAddAgent={vi.fn()}
        onRenameAgent={vi.fn()}
        onRemoveAgent={vi.fn()}
        onStartRun={vi.fn()}
        onStopRun={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rename group Backend" }));
    const input = screen.getByRole("textbox", { name: "group name for Backend" });
    await user.clear(input);
    await user.type(input, "Platform");
    const form = input.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(onRenameGroup).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save group name for Backend" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel group name for Backend" })).toBeDisabled();

    resolveRename();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rename group Backend" })).toHaveFocus(),
    );
  });

  it("requires a dialog confirmation before removing a membership", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Remove agent Reviewer" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Reviewer?" });
    expect(dialog).toHaveTextContent("reusable agent profile remains available");
    expect(client.removeMembership).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove agent" }));

    await waitFor(() =>
      expect(client.removeMembership).toHaveBeenCalledWith("group-backend", "reviewer"),
    );
    expect(screen.queryByRole("dialog", { name: "Remove Reviewer?" })).not.toBeInTheDocument();
  });

  it("falls back to the first remaining group after confirmed selected-group deletion", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const remainingSnapshot = {
      ...snapshot,
      groups: snapshot.groups.slice(1),
      memberships: memberships.filter((member) => member.groupId !== "group-backend"),
    };
    vi.mocked(client.loadSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue(remainingSnapshot);
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Delete group Backend" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Backend?" });
    expect(dialog).toHaveTextContent("0 runs will stop before 2 memberships and 0 messages");
    await user.click(screen.getByRole("button", { name: "Delete group" }));

    expect(await screen.findByRole("heading", { name: "Review" })).toHaveFocus();
    expect(client.deleteGroup).toHaveBeenCalledWith("group-backend");
  });

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
      onRenameGroup: vi.fn().mockResolvedValue(undefined),
      onDeleteGroup: vi.fn().mockResolvedValue(undefined),
      onAddAgent,
      onRenameAgent: vi.fn().mockResolvedValue(undefined),
      onRemoveAgent: vi.fn().mockResolvedValue(undefined),
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
          onRenameGroup={vi.fn()}
          onDeleteGroup={vi.fn()}
          onAddAgent={vi.fn()}
          onRenameAgent={vi.fn()}
          onRemoveAgent={vi.fn()}
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
        onRenameGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onAddAgent={vi.fn()}
        onRenameAgent={vi.fn()}
        onRemoveAgent={vi.fn()}
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

  it("keeps terminals visible below the collapsible message toolbar", async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    expect(await screen.findByTestId("terminal-surface")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByLabelText("Message body")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Workspace input mode" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse messages" }));
    expect(screen.queryByLabelText("Message body")).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-surface")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand messages" }));
    expect(screen.getByLabelText("Message body")).toBeInTheDocument();
  });

  it("builds a broadcast payload with the current membership revision", () => {
    const command = buildMessageCommand(snapshot.groups[0]!, {
      audienceKind: "group",
      recipientIds: [],
      intent: "inform",
      body: "Deployment is complete",
    });

    expect(command).toMatchObject({
      sender: { kind: "operator", operatorId: "portal-operator" },
      audience: { kind: "group", membershipRevision: 4 },
      intent: "inform",
      delivery: {},
      body: { contentType: "text/markdown", text: "Deployment is complete" },
    });
  });

  it("submits a structured message and renders recipient delivery outcomes", async () => {
    const user = userEvent.setup();
    const client = createClient(submissionResult());
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    await user.type(screen.getByLabelText("Message body"), "Review the API");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("queued")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(MESSAGE_HISTORY_KEY) ?? "[]")).toMatchObject([
      { submission: { message: { id: "message-1", body: { text: "Review the API" } } } },
    ]);
    expect(client.submitMessage).toHaveBeenCalledWith(
      "group-backend",
      expect.objectContaining({
        audience: { kind: "dm", memberId: "builder" },
        delivery: {},
      }),
    );
  });

  it("restores browser message history and clears all saved entries", async () => {
    const user = userEvent.setup();
    const first = render(<App client={createClient(submissionResult())} />);
    await screen.findByRole("heading", { name: "Backend" });
    await user.type(screen.getByLabelText("Message body"), "Review the API");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("message #1")).toBeInTheDocument();
    first.unmount();

    render(<App client={createClient()} />);
    await screen.findByRole("heading", { name: "Backend" });
    expect(screen.getByText("message #1")).toBeInTheDocument();
    expect(screen.getByText("Review the API")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear all message history" }));
    const dialog = screen.getByRole("dialog", { name: "Clear all message history?" });
    expect(screen.getByText("message #1")).toBeInTheDocument();
    expect(window.localStorage.getItem(MESSAGE_HISTORY_KEY)).not.toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Clear all message history?" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear all message history" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Clear all message history?" })).getByRole(
        "button",
        { name: "Clear history" },
      ),
    );
    expect(screen.queryByText("message #1")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(MESSAGE_HISTORY_KEY)).toBeNull();
  });

  it("reconciles recipients and outcomes when the selected group changes", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(submissionResult());
    const { rerender } = render(
      <MessageWorkspace
        group={snapshot.groups[0]!}
        members={memberships.slice(0, 2)}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText("Message body"), "Backend message");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("queued")).toBeInTheDocument();

    rerender(
      <MessageWorkspace
        group={snapshot.groups[1]!}
        members={[memberships[2]!]}
        onSubmit={onSubmit}
      />,
    );
    await waitFor(() => expect(screen.queryByText("queued")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Recipient")).toHaveValue("auditor");

    await user.type(screen.getByLabelText("Message body"), "Review message");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ audience: { kind: "dm", memberId: "auditor" } }),
    );
  });

  it("reconciles stale recipients and errors when active members change", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("stale delivery failure"))
      .mockResolvedValue(submissionResult());
    const { rerender } = render(
      <MessageWorkspace
        group={snapshot.groups[0]!}
        members={memberships.slice(0, 2)}
        onSubmit={onSubmit}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Recipient"), "reviewer");
    await user.type(screen.getByLabelText("Message body"), "First attempt");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stale delivery failure");

    rerender(
      <MessageWorkspace
        group={snapshot.groups[0]!}
        members={[memberships[0]!]}
        onSubmit={onSubmit}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Recipient")).toHaveValue("builder");

    await user.clear(screen.getByLabelText("Message body"));
    await user.type(screen.getByLabelText("Message body"), "Second attempt");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ audience: { kind: "dm", memberId: "builder" } }),
    );
  });

  it("ignores an in-flight submission after the message context changes", async () => {
    const user = userEvent.setup();
    let resolveSubmission: (submission: MessageSubmissionResult) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<MessageSubmissionResult>((resolve) => {
          resolveSubmission = resolve;
        }),
    );
    const { rerender } = render(
      <MessageWorkspace
        group={snapshot.groups[0]!}
        members={memberships.slice(0, 2)}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText("Message body"), "Pending message");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();

    rerender(
      <MessageWorkspace
        group={snapshot.groups[1]!}
        members={[memberships[2]!]}
        onSubmit={onSubmit}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    resolveSubmission(submissionResult());
    await act(async () => undefined);
    expect(screen.queryByText("queued")).not.toBeInTheDocument();
  });

  it("requires valid recipients for multicast and group audiences", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    await user.selectOptions(screen.getByLabelText("Audience"), "multicast");
    await user.click(screen.getByLabelText("Reviewer"));
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Audience"), "group");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });
});
