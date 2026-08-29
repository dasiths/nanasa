import type {
  AgentProfile,
  AgentRun,
  GroupMembership,
  Message,
  MessageSubmissionResult,
  NanasaConfig,
  PortalSnapshot,
  StartGroupRunsResult,
} from "@nanasa/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type { PortalClient } from "./api.js";
import { GroupTree } from "./components/group-tree.js";
import {
  buildMessageCommand,
  MESSAGE_HISTORY_KEY,
  MESSAGE_OVERLAY_OPEN_KEY,
  MessageWorkspace,
} from "./components/message-workspace.js";
import { MESSAGE_READ_CURSORS_KEY, messageUnreadCount } from "./hooks/use-message-read-cursors.js";
import { PORTAL_PREFERENCES_KEY } from "./hooks/use-portal-preferences.js";

vi.mock("./components/terminal-workspace.js", () => ({
  TerminalWorkspace: () => <div data-testid="terminal-surface">terminal-surface</div>,
}));

const timestamp = "2026-08-09T12:00:00.000Z";

const config: NanasaConfig = {
  instructions: [],
  roles: {
    reviewer: {
      name: "Reviewer",
      description: "Reviews changes without modifying them",
      instructions: [],
      permissionPolicy: "read-only",
      presentation: { icon: "shield-check", color: "amber", shortName: "Review" },
    },
  },
  groups: {
    "group-backend": {
      name: "Backend",
      instructions: [],
      agents: {
        "builder-agent": {
          memberId: "builder",
          name: "Builder",
          integrationId: "copilot",
          instructions: [],
          order: 0,
        },
        "reviewer-agent": {
          memberId: "reviewer",
          name: "Reviewer",
          integrationId: "copilot",
          roleId: "reviewer",
          instructions: [],
          order: 1,
        },
      },
    },
    "group-review": {
      name: "Review",
      instructions: [],
      agents: {
        "auditor-agent": {
          memberId: "auditor",
          name: "Auditor",
          integrationId: "copilot",
          instructions: [],
          order: 0,
        },
      },
    },
  },
  messages: { retentionPerGroup: 1_000 },
  integrations: {
    copilot: {
      id: "copilot",
      name: "GitHub Copilot",
      kind: "copilot",
      command: ["copilot", "--acp", "--stdio"],
      providerState: { scope: "integration" },
      credentials: { kind: "provider-managed" },
      model: { resumePolicy: "preserve-session" },
      nativeRecovery: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
      extensions: [],
      environment: {},
    },
    "claude-copilot": {
      id: "claude-copilot",
      name: "Claude through Copilot",
      kind: "claude-code",
      command: ["make", "claude-copilot"],
      providerState: { scope: "integration" },
      credentials: { kind: "provider-managed" },
      model: { resumePolicy: "preserve-session" },
      nativeRecovery: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
      extensions: [],
      environment: {},
    },
    "custom-agent": {
      id: "custom-agent",
      name: "Custom reviewer",
      kind: "opencode",
      command: ["custom-reviewer"],
      providerState: { scope: "integration" },
      credentials: { kind: "provider-managed" },
      model: { resumePolicy: "preserve-session" },
      nativeRecovery: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
      extensions: [],
      environment: {},
    },
  },
  version: 2,
  repository: { path: ".", checkout: { kind: "current" } },
  terminal: {
    checkpoints: {
      enabled: false,
      maxLines: 5_000,
      maxBytes: 1_048_576,
      retentionSeconds: 86_400,
      sensitivity: "repository-private",
    },
  },
  extensions: {},
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
    order: 0,
    state: "active",
    joinedAt: timestamp,
  },
  {
    id: "membership-reviewer",
    groupId: "group-backend",
    memberId: "reviewer",
    agentProfileId: profile.id,
    alias: "Reviewer",
    roleId: "reviewer",
    order: 1,
    state: "active",
    joinedAt: timestamp,
  },
  {
    id: "membership-auditor",
    groupId: "group-review",
    memberId: "auditor",
    agentProfileId: profile.id,
    alias: "Auditor",
    order: 0,
    state: "active",
    joinedAt: timestamp,
  },
];

const snapshot: PortalSnapshot = {
  instanceId: "daemon-test",
  daemonEpoch: 1,
  sequence: 7,
  generatedAt: timestamp,
  orderRevision: 4,
  groups: [
    {
      id: "group-backend",
      name: "Backend",
      order: 0,
      membershipRevision: 4,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "group-review",
      name: "Review",
      order: 1,
      membershipRevision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  agentProfiles: [profile],
  memberships,
  runs: [],
  repositories: [],
  checkouts: [],
  worktrees: [],
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
    launchKind: "fresh",
    requestedModelSource: "provider-default",
    startedAt: timestamp,
    stoppedAt: timestamp,
  };
  return {
    createConsole: vi
      .fn()
      .mockResolvedValue({ id: "console-one", runId: "console-one", generation: 1 }),
    closeConsole: vi.fn().mockResolvedValue(undefined),
    loadMetadata: vi.fn().mockResolvedValue({
      apiVersion: 1,
      eventProtocolVersion: 1,
      productVersion: "0.0.0",
      configVersion: 2,
      databaseSchemaVersion: 5,
      repositoryId: "repo-test",
      instanceId: snapshot.instanceId,
      daemonEpoch: snapshot.daemonEpoch,
      lifecycle: "ready",
      remoteAccess: "loopback-only",
      limits: {},
    }),
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
    createAgent: vi.fn().mockResolvedValue(memberships[0]),
    updateAgent: vi.fn().mockResolvedValue(memberships[0]),
    removeAgent: vi.fn().mockResolvedValue({
      groupId: "group-backend",
      agentId: "builder-agent",
      deletedRuns: 0,
      revokedDeliveries: 0,
    }),
    reorderAgents: vi.fn().mockResolvedValue({
      groupId: "group-backend",
      agentIds: ["builder-agent", "reviewer-agent"],
      orderRevision: 4,
    }),
    reorderGroups: vi.fn(),
    reparentAgent: vi.fn(),
    assignCheckout: vi.fn(),
    createWorktree: vi.fn(),
    openCheckout: vi.fn(),
    removeWorktree: vi.fn(),
    updateRolePresentation: vi.fn().mockResolvedValue(config.roles.reviewer),
    startRun: vi.fn().mockResolvedValue(run),
    startAllRuns: vi.fn().mockResolvedValue({ groupId: "group-backend", outcomes: [] }),
    stopRun: vi.fn().mockResolvedValue(run),
    submitMessage: vi.fn().mockImplementation(async () => {
      if (submission === undefined) throw new Error("No submission fixture configured");
      return submission;
    }),
    createAgentAction: vi.fn(),
    loadActionWorkspace: vi.fn().mockResolvedValue({
      groupId: "group-backend",
      actions: [],
      attempts: [],
      acknowledgements: [],
      openWaits: [],
    }),
    replyOpenWait: vi.fn(),
    loadMessages: vi.fn().mockResolvedValue({
      groupId: "group-backend",
      messages: [],
      deliveryOutcomes: [],
      state: {
        groupId: "group-backend",
        latestGroupSeq: 0,
        retainedMessageCount: 0,
        activeDeliveryCount: 0,
        failedRecipientMemberIds: [],
      },
      pageInfo: { hasOlder: false, hasNewer: false },
    }),
    clearMessages: vi.fn().mockResolvedValue({
      groupId: "group-backend",
      deletedMessages: 0,
      deletedDeliveries: 0,
      state: {
        groupId: "group-backend",
        latestGroupSeq: 0,
        retainedMessageCount: 0,
        activeDeliveryCount: 0,
        failedRecipientMemberIds: [],
      },
    }),
    getTerminalEndpointStatus: vi.fn(),
    readTerminal: vi.fn(),
    listTerminalCheckpoints: vi.fn().mockResolvedValue([]),
    getTerminalCheckpoint: vi.fn(),
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

async function openMessageComposer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("Compose message"));
  return screen.getByRole("dialog", { name: "New message" });
}

async function chooseRowAction(
  user: ReturnType<typeof userEvent.setup>,
  menuLabel: string,
  actionLabel: string,
) {
  await user.click(screen.getByRole("button", { name: menuLabel }));
  const menu = screen.getByRole("menu", { name: menuLabel });
  await user.click(within(menu).getByRole("menuitem", { name: actionLabel }));
}

describe("portal application", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(MESSAGE_OVERLAY_OPEN_KEY, "true");
  });

  afterEach(() => vi.restoreAllMocks());

  it("refreshes the snapshot when a typed domain event arrives", async () => {
    const client = createClient();
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    expect(client.loadSnapshot).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(client.createEventsSocket).toHaveBeenCalledTimes(1));
    const socket = vi.mocked(client.createEventsSocket).mock.results.at(-1)?.value;
    await waitFor(() => expect(socket?.onmessage).toEqual(expect.any(Function)));
    await act(async () =>
      socket!.onmessage!(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "domain.event",
            event: {
              sequence: 8,
              id: "event-8",
              type: "group.changed",
              aggregateType: "group",
              aggregateId: "group-backend",
              occurredAt: timestamp,
              payload: {},
            },
          }),
        }),
      ),
    );

    await waitFor(() => expect(client.loadSnapshot).toHaveBeenCalledTimes(2));
  });

  it("coalesces an event burst into one in-flight snapshot and one trailing invalidation", async () => {
    const client = createClient();
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    const socket = vi.mocked(client.createEventsSocket).mock.results.at(-1)?.value;
    await waitFor(() => expect(socket?.onmessage).toEqual(expect.any(Function)));

    let resolveSnapshot: (value: PortalSnapshot) => void = () => undefined;
    vi.mocked(client.loadSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise<PortalSnapshot>((resolve) => {
            resolveSnapshot = resolve;
          }),
      )
      .mockResolvedValue({ ...snapshot, sequence: 1_007 });

    await act(async () => {
      for (let sequence = 8; sequence < 1_008; sequence += 1) {
        socket!.onmessage!(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "domain.event",
              event: {
                sequence,
                id: `event-${sequence}`,
                type: "fixture.changed",
                aggregateType: "fixture",
                aggregateId: "fixture-one",
                occurredAt: timestamp,
                payload: {},
              },
            }),
          }),
        );
      }
    });
    expect(client.loadSnapshot).toHaveBeenCalledTimes(2);
    resolveSnapshot({ ...snapshot, sequence: 1_007 });
    await waitFor(() => expect(client.loadSnapshot).toHaveBeenCalledTimes(3));
  });

  it("replaces the rail Add agent shortcut with Console", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    expect(screen.getByRole("button", { name: "Console" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add agent$/ })).not.toBeInTheDocument();

    await chooseRowAction(user, "Actions for group Backend", "Add agent to Backend");
    expect(screen.getByRole("button", { name: /^Add agent$/ })).toBeInTheDocument();
  });

  it("renames groups and agents inline with Enter and cancels edits with Escape", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await chooseRowAction(user, "Actions for group Backend", "Rename group Backend");
    const groupName = screen.getByRole("textbox", { name: "group name for Backend" });
    await user.clear(groupName);
    await user.type(groupName, "Platform{Enter}");
    await waitFor(() =>
      expect(client.updateGroup).toHaveBeenCalledWith("group-backend", { name: "Platform" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Actions for group Backend" })).toHaveFocus(),
    );

    await chooseRowAction(user, "Actions for agent Reviewer", "Rename agent Reviewer");
    const agentName = screen.getByRole("textbox", { name: "agent name for Reviewer" });
    await user.clear(agentName);
    await user.type(agentName, "Quality reviewer{Escape}");
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "agent name for Reviewer" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Actions for agent Reviewer" })).toHaveFocus(),
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
        onOpenConsole={vi.fn()}
      />,
    );

    await chooseRowAction(user, "Actions for group Backend", "Rename group Backend");
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
      expect(screen.getByRole("button", { name: "Actions for group Backend" })).toHaveFocus(),
    );
  });

  it("copies member IDs from group rows", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<App client={createClient()} />);

    await screen.findByRole("heading", { name: "Backend" });
    await chooseRowAction(user, "Actions for agent Builder", "Copy member ID builder");

    expect(writeText).toHaveBeenCalledWith("builder");
  });

  it("keeps row actions keyboard accessible without obscuring labels", async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    await screen.findByRole("heading", { name: "Backend" });
    const tree = screen.getByRole("navigation", { name: "Group tree" });
    expect(within(tree).getByText("Backend")).toBeVisible();
    expect(within(tree).getByText("Builder")).toBeVisible();
    expect(within(tree).getByLabelText("Role Reviewer")).toHaveClass("role-color-amber");

    const groupTrigger = screen.getByRole("button", { name: "Actions for group Backend" });
    groupTrigger.focus();
    await user.keyboard("{Enter}");
    const groupMenu = screen.getByRole("menu", { name: "Actions for group Backend" });
    const addAgent = within(groupMenu).getByRole("menuitem", { name: "Add agent to Backend" });
    const groupSettings = within(groupMenu).getByRole("menuitem", {
      name: "Edit group settings Backend",
    });
    await waitFor(() => expect(addAgent).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(groupSettings).toHaveFocus();
    await user.keyboard("{End}");
    expect(within(groupMenu).getByRole("menuitem", { name: "Delete group Backend" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(groupTrigger).toHaveFocus());
    expect(
      screen.queryByRole("menu", { name: "Actions for group Backend" }),
    ).not.toBeInTheDocument();

    const agentTrigger = screen.getByRole("button", { name: "Actions for agent Builder" });
    agentTrigger.focus();
    await user.keyboard("{Enter}");
    const agentMenu = screen.getByRole("menu", { name: "Actions for agent Builder" });
    await waitFor(() =>
      expect(
        within(agentMenu).getByRole("menuitem", { name: "Copy member ID builder" }),
      ).toHaveFocus(),
    );
    await user.keyboard("{ArrowUp}");
    expect(within(agentMenu).getByRole("menuitem", { name: "Remove agent Builder" })).toHaveFocus();
  });

  it("updates role presentation from the global role settings dialog", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Role settings" }));
    const dialog = screen.getByRole("dialog", { name: "Role presentation" });
    await user.selectOptions(within(dialog).getByLabelText("Icon"), "scan-search");
    await user.selectOptions(within(dialog).getByLabelText("Color"), "rose");
    await user.clear(within(dialog).getByLabelText("Compact name"));
    await user.type(within(dialog).getByLabelText("Compact name"), "Inspect");
    await user.click(within(dialog).getByRole("button", { name: "Save Reviewer" }));

    await waitFor(() =>
      expect(client.updateRolePresentation).toHaveBeenCalledWith("reviewer", {
        icon: "scan-search",
        color: "rose",
        shortName: "Inspect",
      }),
    );
  });

  it("reorders agents with complete group permutations", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Actions for agent Builder" }));
    const builderMenu = screen.getByRole("menu", { name: "Actions for agent Builder" });
    expect(within(builderMenu).getByRole("menuitem", { name: "Move Builder up" })).toBeDisabled();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Actions for agent Reviewer" }));
    const reviewerMenu = screen.getByRole("menu", { name: "Actions for agent Reviewer" });
    await user.click(within(reviewerMenu).getByRole("menuitem", { name: "Move Reviewer up" }));

    await waitFor(() =>
      expect(client.reorderAgents).toHaveBeenCalledWith("group-backend", {
        agentIds: ["reviewer-agent", "builder-agent"],
        expectedOrderRevision: snapshot.orderRevision,
      }),
    );
  });

  it("requires a dialog confirmation before removing an agent", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await chooseRowAction(user, "Actions for agent Reviewer", "Remove agent Reviewer");
    const dialog = screen.getByRole("dialog", { name: "Remove Reviewer?" });
    expect(dialog).toHaveTextContent("agent will be removed from the group");
    expect(dialog).not.toHaveTextContent("profile");
    expect(client.removeAgent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove agent" }));

    await waitFor(() =>
      expect(client.removeAgent).toHaveBeenCalledWith("group-backend", "reviewer-agent"),
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
    await chooseRowAction(user, "Actions for group Backend", "Delete group Backend");
    const dialog = screen.getByRole("dialog", { name: "Delete Backend?" });
    expect(dialog).toHaveTextContent("0 runs will stop before 2 agents and 0 messages");
    await user.click(screen.getByRole("button", { name: "Delete group" }));

    expect(await screen.findByRole("heading", { name: "Review" })).toHaveFocus();
    expect(client.deleteGroup).toHaveBeenCalledWith("group-backend");
  });

  it("creates groups with shared Markdown instructions", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await user.click(screen.getByRole("button", { name: "Create group" }));
    await user.type(screen.getByLabelText("Group name"), "Platform team");
    await user.type(
      screen.getByLabelText("Group instruction files"),
      ".nanasa/instructions/groups/platform.md",
    );
    const createButtons = screen.getAllByRole("button", { name: "Create group" });
    await user.click(createButtons.at(-1)!);

    expect(client.createGroup).toHaveBeenCalledWith({
      name: "Platform team",
      instructions: [".nanasa/instructions/groups/platform.md"],
    });
  });

  it("edits group name and shared Markdown instructions", async () => {
    const user = userEvent.setup();
    const client = createClient();
    vi.mocked(client.loadConfig).mockResolvedValue({
      ...config,
      groups: {
        "group-backend": {
          name: "Backend",
          instructions: [".nanasa/instructions/groups/backend.md"],
          agents: config.groups["group-backend"]!.agents,
        },
      },
    });
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await chooseRowAction(user, "Actions for group Backend", "Edit group settings Backend");
    const dialog = screen.getByRole("dialog", { name: "Backend" });
    const name = within(dialog).getByLabelText("Group name");
    await user.clear(name);
    await user.type(name, "Platform");
    const files = within(dialog).getByLabelText("Group instruction files");
    await user.clear(files);
    await user.type(files, ".nanasa/instructions/groups/platform.md");
    await user.click(within(dialog).getByRole("button", { name: "Save group" }));

    await waitFor(() =>
      expect(client.updateGroup).toHaveBeenCalledWith("group-backend", {
        name: "Platform",
        instructions: [".nanasa/instructions/groups/platform.md"],
      }),
    );
  });

  it("opens the add-agent dialog from the selected group row", async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    await screen.findByRole("heading", { name: "Backend" });
    await chooseRowAction(user, "Actions for group Backend", "Add agent to Backend");
    const dialog = screen.getByRole("dialog", { name: "Add agent" });

    expect(within(dialog).getByLabelText("Name")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Integration")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Role")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Agent instruction files")).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "Reviewer (reviewer)" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/profile/i)).not.toBeInTheDocument();
  });

  it.each([
    ["custom-agent", "Custom reviewer (custom-agent)"],
    ["claude-copilot", "Claude through Copilot (claude-copilot)"],
  ])("creates one agent with the configured %s integration", async (integrationId, optionName) => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await chooseRowAction(user, "Actions for group Backend", "Add agent to Backend");
    await user.type(screen.getByLabelText("Name"), "Security reviewer");
    await user.selectOptions(screen.getByLabelText("Integration"), integrationId);
    await user.selectOptions(screen.getByLabelText("Role"), "reviewer");
    await user.type(
      screen.getByLabelText("Agent instruction files"),
      ".nanasa/instructions/agents/security.md",
    );
    expect(screen.getByRole("option", { name: optionName })).toBeInTheDocument();
    const form = screen.getByLabelText("Agent instruction files").closest("form");
    expect(form).not.toBeNull();
    await user.click(within(form!).getByRole("button", { name: "Add agent" }));

    expect(client.createAgent).toHaveBeenCalledTimes(1);
    expect(client.createAgent).toHaveBeenCalledWith("group-backend", {
      name: "Security reviewer",
      integrationId,
      roleId: "reviewer",
      instructions: [".nanasa/instructions/agents/security.md"],
    });
  });

  it("edits all direct agent settings with one save", async () => {
    const user = userEvent.setup();
    const client = createClient();
    vi.mocked(client.loadConfig).mockResolvedValue({
      ...config,
      groups: {
        ...config.groups,
        "group-backend": {
          name: "Backend",
          instructions: [],
          agents: {
            ...config.groups["group-backend"]!.agents,
            "reviewer-agent": {
              memberId: "reviewer",
              name: "Reviewer",
              integrationId: "copilot",
              roleId: "reviewer",
              instructions: [".nanasa/instructions/agents/reviewer.md"],
              order: 1,
            },
          },
        },
      },
    });
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await chooseRowAction(user, "Actions for agent Reviewer", "Edit agent settings Reviewer");
    const dialog = screen.getByRole("dialog", { name: "Reviewer" });

    expect(within(dialog).getByText("reviewer")).toBeInTheDocument();
    expect(within(dialog).getByText("reviewer-agent")).toBeInTheDocument();
    expect(within(dialog).getByText("Internal")).toBeInTheDocument();

    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Security reviewer");
    await user.selectOptions(within(dialog).getByLabelText("Integration"), "custom-agent");
    const files = within(dialog).getByLabelText("Agent instruction files");
    await user.clear(files);
    await user.type(files, ".nanasa/instructions/agents/security.md");
    expect(within(dialog).queryByText(/profile|default|override/i)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save agent" }));

    await waitFor(() =>
      expect(client.updateAgent).toHaveBeenCalledWith("group-backend", "reviewer-agent", {
        name: "Security reviewer",
        integrationId: "custom-agent",
        roleId: "reviewer",
        instructions: [".nanasa/instructions/agents/security.md"],
      }),
    );
  });

  it("shows empty instruction fields as state instead of example values", async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    await screen.findByRole("heading", { name: "Backend" });
    await chooseRowAction(user, "Actions for agent Builder", "Edit agent settings Builder");
    const dialog = screen.getByRole("dialog", { name: "Builder" });
    const files = within(dialog).getByLabelText("Agent instruction files");

    expect(files).toHaveValue("");
    expect(files).not.toHaveAttribute("placeholder");
    expect(
      within(dialog).getByText("No agent-specific instruction files configured"),
    ).toBeVisible();
    await user.type(files, ".nanasa/instructions/agents/builder.md");
    expect(files).toHaveValue(".nanasa/instructions/agents/builder.md");
    expect(
      within(dialog).queryByText("No agent-specific instruction files configured"),
    ).not.toBeInTheDocument();
  });

  it("shows inherited global, group, and role instruction files in agent settings", async () => {
    const user = userEvent.setup();
    const client = createClient();
    vi.mocked(client.loadConfig).mockResolvedValue({
      ...config,
      instructions: [".nanasa/instructions/team.md"],
      roles: {
        reviewer: {
          ...config.roles.reviewer!,
          instructions: [".nanasa/instructions/reviewer.md"],
        },
      },
      groups: {
        ...config.groups,
        "group-backend": {
          name: "Backend",
          instructions: [".nanasa/instructions/groups/backend.md"],
          agents: {
            ...config.groups["group-backend"]!.agents,
            "reviewer-agent": {
              memberId: "reviewer",
              name: "Reviewer",
              integrationId: "copilot",
              roleId: "reviewer",
              instructions: [],
              order: 1,
            },
          },
        },
      },
    });
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Backend" });
    await chooseRowAction(user, "Actions for agent Reviewer", "Edit agent settings Reviewer");
    const dialog = screen.getByRole("dialog", { name: "Reviewer" });
    const inherited = within(dialog).getByRole("heading", {
      name: "Inherited instruction files",
    }).parentElement as HTMLElement;

    expect(within(inherited).getByText(".nanasa/instructions/team.md")).toBeVisible();
    expect(within(inherited).getByText(".nanasa/instructions/groups/backend.md")).toBeVisible();
    expect(within(inherited).getByText(".nanasa/instructions/reviewer.md")).toBeVisible();
    expect(within(inherited).getByText("Role · Reviewer")).toBeVisible();
  });

  it("shows a distinct repository configuration error", async () => {
    const client = createClient();
    vi.mocked(client.loadConfig).mockRejectedValue(new Error("integrations is invalid"));
    render(<App client={client} />);

    expect(await screen.findByText("Repository configuration unavailable")).toBeInTheDocument();
    expect(screen.getByText("integrations is invalid")).toBeInTheDocument();
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
    async (recoveryPhase, runStatus, actionName) => {
      const user = userEvent.setup();
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
        launchKind: "fresh",
        requestedModelSource: "provider-default",
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
          onOpenConsole={vi.fn()}
        />,
      );

      expect(screen.getByText(new RegExp(`^${recoveryPhase}`))).toHaveAttribute(
        "title",
        "daemon_restart",
      );
      await user.click(screen.getByRole("button", { name: "Actions for agent Builder" }));
      const menu = screen.getByRole("menu", { name: "Actions for agent Builder" });
      expect(within(menu).getByRole("menuitem", { name: actionName })).toBeInTheDocument();
      expect(
        within(menu).queryByRole("menuitem", { name: "Start Builder" }),
      ).not.toBeInTheDocument();
    },
  );

  it("renders semantic status, progress context, and attention independently of run controls", async () => {
    const user = userEvent.setup();
    const run: AgentRun = {
      id: "run-waiting",
      groupId: "group-backend",
      memberId: "builder",
      agentProfileId: profile.id,
      generation: 1,
      status: "running",
      desiredState: "running",
      recoveryPhase: "idle",
      recoveryAttempts: 0,
      launchKind: "fresh",
      requestedModelSource: "provider-default",
      startedAt: timestamp,
    };
    render(
      <GroupTree
        snapshot={{
          ...snapshot,
          memberships: memberships.slice(0, 1),
          runs: [run],
          agentStatuses: [
            {
              groupId: "group-backend",
              memberId: "builder",
              alias: "Builder",
              agentType: "copilot",
              runId: run.id,
              generation: 1,
              runStatus: "running",
              state: "waiting",
              phase: "permission",
              outcome: "unknown",
              confidence: "high",
              attention: "decision_required",
              observedAt: timestamp,
              stateChangedAt: timestamp,
              statusRevision: 3,
              completionRevision: 0,
              operatorAcknowledgedCompletionRevision: 0,
              completionPending: false,
              interactiveReady: true,
              staleAuthority: false,
              authorityKind: "reporter",
              authorityId: "reporter-one",
              evidenceConfidence: "high",
              processState: "present",
              progressStage: "validation",
              lastProgressSummary: "Implementation complete",
            },
          ],
        }}
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
        onOpenConsole={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/^waiting · permission · decision required · validation/),
    ).toHaveAttribute("title", "Implementation complete");
    expect(screen.getByLabelText("Builder needs decision required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actions for agent Builder" }));
    expect(
      within(screen.getByRole("menu", { name: "Actions for agent Builder" })).getByRole(
        "menuitem",
        { name: "Stop Builder" },
      ),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const memberButton = screen.getByRole("button", { name: "View details for Builder" });
    await user.click(memberButton);
    const details = screen.getByRole("dialog", { name: "Agent details for Builder" });
    await waitFor(() => expect(details).toHaveFocus());
    expect(within(details).getByText("decision required")).toBeInTheDocument();
    expect(within(details).getByText("Implementation complete")).toBeInTheDocument();
    expect(within(details).getByText("builder")).toBeInTheDocument();
    const kindLabel = within(details).getByText("Kind");
    expect(kindLabel.nextElementSibling).toHaveTextContent("copilot");
    await user.click(within(details).getByRole("button", { name: "Close details for Builder" }));
    expect(
      screen.queryByRole("dialog", { name: "Agent details for Builder" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(memberButton).toHaveFocus());
  });

  it("counts explicit input separately from ordinary waiting", async () => {
    const client = createClient();
    vi.mocked(client.loadSnapshot).mockResolvedValue({
      ...snapshot,
      agentStatuses: [
        {
          groupId: "group-backend",
          memberId: "builder",
          alias: "Builder",
          agentType: "copilot",
          runId: "run-builder",
          generation: 1,
          runStatus: "running",
          state: "waiting",
          phase: "question",
          outcome: "unknown",
          confidence: "high",
          attention: "input_required",
          observedAt: timestamp,
          stateChangedAt: timestamp,
          statusRevision: 2,
          completionRevision: 0,
          operatorAcknowledgedCompletionRevision: 0,
          completionPending: false,
          interactiveReady: true,
          staleAuthority: false,
          authorityKind: "reporter",
          authorityId: "reporter-one",
          evidenceConfidence: "high",
          processState: "present",
        },
        {
          groupId: "group-backend",
          memberId: "reviewer",
          alias: "Reviewer",
          agentType: "copilot",
          runId: "run-reviewer",
          generation: 1,
          runStatus: "running",
          state: "waiting",
          phase: "settled",
          outcome: "unknown",
          confidence: "high",
          attention: "none",
          observedAt: timestamp,
          stateChangedAt: timestamp,
          statusRevision: 2,
          completionRevision: 0,
          operatorAcknowledgedCompletionRevision: 0,
          completionPending: false,
          interactiveReady: true,
          staleAuthority: false,
          authorityKind: "reporter",
          authorityId: "reporter-two",
          evidenceConfidence: "high",
          processState: "present",
        },
      ],
    });

    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });

    expect(screen.getByText("2 waiting")).toBeInTheDocument();
    expect(screen.getByText("1 needs attention")).toHaveAttribute(
      "title",
      "Builder: input required",
    );
    expect(screen.getByText(/^waiting · question · input required/)).toBeInTheDocument();
    expect(screen.getByText(/^waiting · settled/)).toBeInTheDocument();
  });

  it("offers Start for a normally stopped desired-stopped run", async () => {
    const user = userEvent.setup();
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
      launchKind: "fresh",
      requestedModelSource: "provider-default",
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
        onOpenConsole={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Unassigned role")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Actions for agent Builder" }));
    expect(
      within(screen.getByRole("menu", { name: "Actions for agent Builder" })).getByRole(
        "menuitem",
        { name: "Start Builder" },
      ),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "View details for Builder" }));
    expect(
      within(screen.getByRole("dialog", { name: "Agent details for Builder" })).getByText(
        /GitHub Copilot \(copilot\)/,
      ),
    ).toBeInTheDocument();
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
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "light"));
  });

  it("selects a group from the tree and updates the workspace", async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    expect(await screen.findByRole("heading", { name: "Backend" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review1" }));

    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByText(/1 agents/)).toBeInTheDocument();
  });

  it("keeps floating Messages open across the workspace and restores launcher focus", async () => {
    const user = userEvent.setup();
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("message-history") ? 1_000 : 0;
    });
    render(<App client={createClient()} />);

    expect(await screen.findByTestId("terminal-surface")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByLabelText("Compose message")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message body")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Workspace input mode" })).not.toBeInTheDocument();

    await user.click(
      within(screen.getByRole("region", { name: "Messages overlay" })).getByRole("button", {
        name: "Close messages",
      }),
    );
    expect(screen.queryByRole("region", { name: "Messages" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Messages" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Messages" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Message history" }).scrollTop).toBe(1_000),
    );
    expect(window.localStorage.getItem(MESSAGE_OVERLAY_OPEN_KEY)).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Messages" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Messages" })).toHaveFocus());
    expect(window.localStorage.getItem(MESSAGE_OVERLAY_OPEN_KEY)).toBe("false");
    await user.click(screen.getByRole("button", { name: "Messages" }));

    const dialog = await openMessageComposer(user);
    expect(within(dialog).getByLabelText("Message body")).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "Builder (builder)" })).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "Reviewer (reviewer)" })).toBeInTheDocument();
    expect(
      within(dialog).getByText("Ask an agent to perform work or provide an answer."),
    ).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Intent"), "inform");
    expect(
      within(dialog).getByText("Share context or a status update. No response is required."),
    ).toBeInTheDocument();
  });

  it("preserves read cursors across refresh and counts only new messages", async () => {
    window.localStorage.setItem(MESSAGE_OVERLAY_OPEN_KEY, "false");
    const client = createClient();
    vi.mocked(client.loadSnapshot).mockResolvedValue({
      ...snapshot,
      messageGroups: [
        {
          groupId: "group-backend",
          latestGroupSeq: 1,
          oldestRetainedGroupSeq: 1,
          retainedMessageCount: 1,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: [],
        },
      ],
    });
    const first = render(<App client={client} />);

    expect(await screen.findByLabelText("1 unread messages")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Messages" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("1 unread messages")).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Close messages" }));
    first.unmount();

    expect(window.localStorage.getItem(MESSAGE_READ_CURSORS_KEY)).not.toBeNull();
    const second = render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    expect(screen.queryByLabelText("1 unread messages")).not.toBeInTheDocument();
    second.unmount();

    vi.mocked(client.loadSnapshot).mockResolvedValue({
      ...snapshot,
      messageGroups: [
        {
          groupId: "group-backend",
          latestGroupSeq: 2,
          oldestRetainedGroupSeq: 1,
          retainedMessageCount: 2,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: [],
        },
      ],
    });
    render(<App client={client} />);

    expect(await screen.findByLabelText("1 unread messages")).toBeInTheDocument();
  });

  it("does not count messages pruned before the read cursor", () => {
    expect(
      messageUnreadCount(
        {
          groupId: "group-backend",
          latestGroupSeq: 100,
          oldestRetainedGroupSeq: 96,
          retainedMessageCount: 5,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: [],
        },
        1,
      ),
    ).toBe(5);
  });

  it("loads the latest 20 messages and prepends an older page near the top", async () => {
    const client = createClient();
    const messages = Array.from({ length: 21 }, (_, index) => ({
      ...submissionResult().message,
      id: `message-${index + 1}`,
      groupSeq: index + 1,
      body: { contentType: "text/markdown" as const, text: `Message ${index + 1}` },
    }));
    vi.mocked(client.loadMessages)
      .mockResolvedValueOnce({
        groupId: "group-backend",
        messages: messages.slice(1),
        deliveryOutcomes: [],
        state: {
          groupId: "group-backend",
          latestGroupSeq: 21,
          oldestRetainedGroupSeq: 1,
          retainedMessageCount: 21,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: [],
        },
        pageInfo: { hasOlder: true, hasNewer: false, nextBefore: 2 },
      })
      .mockResolvedValueOnce({
        groupId: "group-backend",
        messages: messages.slice(0, 1),
        deliveryOutcomes: [],
        state: {
          groupId: "group-backend",
          latestGroupSeq: 21,
          oldestRetainedGroupSeq: 1,
          retainedMessageCount: 21,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: [],
        },
        pageInfo: { hasOlder: false, hasNewer: true, nextAfter: 1 },
      });

    render(
      <MessageWorkspace
        group={snapshot.groups[0]!}
        members={memberships.slice(0, 2)}
        messageState={{
          groupId: "group-backend",
          latestGroupSeq: 21,
          oldestRetainedGroupSeq: 1,
          retainedMessageCount: 21,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: [],
        }}
        client={client}
        onSubmit={vi.fn()}
      />,
    );

    expect(await screen.findByText("Message 21")).toBeInTheDocument();
    expect(client.loadMessages).toHaveBeenNthCalledWith(1, "group-backend", { limit: 20 });
    const viewport = screen.getByRole("region", { name: "Message history" });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 400 });
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);

    expect(await screen.findByText("Message 1")).toBeInTheDocument();
    expect(client.loadMessages).toHaveBeenNthCalledWith(2, "group-backend", {
      limit: 20,
      before: 2,
    });
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
    await openMessageComposer(user);
    await user.type(screen.getByLabelText("Message body"), "Review the API");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("From: Human")).toBeInTheDocument();
    const delivery = screen.getByRole("button", { name: "Sent to 1 · 1 queued" });
    expect(delivery).toHaveAttribute("aria-expanded", "false");
    await user.click(delivery);
    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(window.localStorage.getItem(MESSAGE_HISTORY_KEY)).toBeNull();
    expect(client.submitMessage).toHaveBeenCalledWith(
      "group-backend",
      expect.objectContaining({
        audience: { kind: "dm", memberId: "builder" },
        delivery: {},
      }),
    );
  });

  it("creates Prompt when ready work separately from communication delivery", async () => {
    const user = userEvent.setup();
    const client = createClient(submissionResult());
    vi.mocked(client.createAgentAction).mockResolvedValue({
      version: 1,
      id: "action-1",
      kind: "prompt",
      principal: { kind: "operator", operatorId: "portal-operator" },
      target: {
        groupId: "group-backend",
        memberId: "builder",
        runId: "run-builder",
        generation: 1,
        daemonEpoch: 1,
        reporterSessionId: "reporter-1",
        reporterId: "copilot-hooks",
        reporterEpoch: "epoch-1",
        baselineStatusRevision: 2,
        baselineCompletionRevision: 0,
      },
      messageId: "message-1",
      conversationId: "conversation-1",
      idempotencyKey: "action-key",
      requestDigest: "a".repeat(64),
      prompt: "Review the API",
      allowWorking: false,
      state: "created",
      queueDeadlineAt: "2026-08-29T12:05:00.000Z",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    await openMessageComposer(user);
    await user.type(screen.getByLabelText("Message body"), "Review the API");
    await user.click(
      screen.getByLabelText(
        "Prompt when ready (creates exact durable work separately from delivery)",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(client.submitMessage).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(client.createAgentAction).toHaveBeenCalledWith({
        kind: "prompt",
        groupId: "group-backend",
        memberId: "builder",
        prompt: "Review the API",
        messageId: "message-1",
        conversationId: "conversation-1",
        allowWorking: false,
      }),
    );
    expect(
      screen.getByRole("region", { name: "Action progress and exact waits" }),
    ).toHaveTextContent("Separate from communication delivery and browser unread");
  });

  it("renders exact permission waits separately and sends only closed logical replies", async () => {
    const user = userEvent.setup();
    const client = createClient();
    vi.mocked(client.loadActionWorkspace).mockResolvedValue({
      groupId: "group-backend",
      actions: [],
      attempts: [],
      acknowledgements: [],
      openWaits: [
        {
          id: "wait-1",
          groupId: "group-backend",
          memberId: "builder",
          runId: "run-builder",
          generation: 1,
          reporterSessionId: "reporter-1",
          reporterId: "copilot-hooks",
          reporterEpoch: "epoch-1",
          providerRequestId: "permission-1",
          kind: "permission",
          summary: "Allow one command?",
          replyChannel: "terminal",
          openedStatusRevision: 7,
          state: "open",
          openedAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });
    vi.mocked(client.replyOpenWait).mockResolvedValue({
      ...(await client.loadActionWorkspace("group-backend")).openWaits[0]!,
      state: "replying",
    });
    render(<App client={client} />);
    await screen.findByText("Allow one command?");
    await user.click(screen.getByRole("button", { name: "Allow once" }));

    expect(client.replyOpenWait).toHaveBeenCalledWith("wait-1", {
      expectedRunId: "run-builder",
      expectedGeneration: 1,
      expectedReporterEpoch: "epoch-1",
      expectedStatusRevision: 7,
      reply: { kind: "allow-once" },
    });
    expect(screen.queryByRole("button", { name: /send keys/i })).not.toBeInTheDocument();
  });

  it("restores server message history and clears persisted entries", async () => {
    const user = userEvent.setup();
    const first = render(<App client={createClient(submissionResult())} />);
    await screen.findByRole("heading", { name: "Backend" });
    await openMessageComposer(user);
    await user.type(screen.getByLabelText("Message body"), "Review the API");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Review the API")).toBeInTheDocument();
    first.unmount();
    expect(window.localStorage.getItem(MESSAGE_HISTORY_KEY)).toBeNull();

    const restoredClient = createClient();
    vi.mocked(restoredClient.loadSnapshot).mockResolvedValue({
      ...snapshot,
      messageGroups: [
        {
          groupId: "group-backend",
          latestGroupSeq: 1,
          oldestRetainedGroupSeq: 1,
          retainedMessageCount: 1,
          activeDeliveryCount: 1,
          failedRecipientMemberIds: [],
        },
      ],
    });
    vi.mocked(restoredClient.loadMessages).mockResolvedValue({
      groupId: "group-backend",
      messages: [submissionResult().message],
      deliveryOutcomes: submissionResult().deliveryOutcomes,
      state: {
        groupId: "group-backend",
        latestGroupSeq: 1,
        oldestRetainedGroupSeq: 1,
        retainedMessageCount: 1,
        activeDeliveryCount: 1,
        failedRecipientMemberIds: [],
      },
      pageInfo: { hasOlder: false, hasNewer: false },
    });
    render(<App client={restoredClient} />);
    await screen.findByRole("heading", { name: "Backend" });
    expect(await screen.findByText("Review the API")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear all message history" }));
    const dialog = screen.getByRole("dialog", { name: "Clear all message history?" });
    expect(screen.getByText("Review the API")).toBeInTheDocument();
    expect(restoredClient.clearMessages).not.toHaveBeenCalled();
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
    expect(screen.queryByText("Review the API")).not.toBeInTheDocument();
    expect(restoredClient.clearMessages).toHaveBeenCalledWith("group-backend");
    expect(window.localStorage.getItem(MESSAGE_HISTORY_KEY)).toBeNull();
  });

  it("renders authoritative Human and agent-to-agent messages in chronological order", async () => {
    const user = userEvent.setup();
    const humanMessage = submissionResult().message;
    const agentMessage: Message = {
      ...humanMessage,
      id: "message-2",
      groupSeq: 2,
      sender: { kind: "agent", memberId: "reviewer", runId: "run-reviewer" },
      audience: { kind: "dm", memberId: "builder" },
      body: { contentType: "text/markdown", text: "Builder, the review is complete." },
      createdAt: "2026-08-09T12:01:00.000Z",
    };
    const authoritativeSnapshot: PortalSnapshot = {
      ...snapshot,
      messageGroups: [
        {
          groupId: "group-backend",
          latestGroupSeq: 2,
          oldestRetainedGroupSeq: 1,
          retainedMessageCount: 2,
          activeDeliveryCount: 1,
          failedRecipientMemberIds: [],
        },
      ],
    };
    const client = createClient();
    vi.mocked(client.loadSnapshot).mockResolvedValue(authoritativeSnapshot);
    vi.mocked(client.loadMessages).mockResolvedValue({
      groupId: "group-backend",
      messages: [humanMessage, agentMessage],
      deliveryOutcomes: [
        ...submissionResult().deliveryOutcomes,
        {
          messageId: agentMessage.id,
          recipientMemberId: "builder",
          status: "terminal_injected",
          attempts: 2,
          updatedAt: agentMessage.createdAt,
        },
      ],
      state: authoritativeSnapshot.messageGroups![0]!,
      pageInfo: { hasOlder: false, hasNewer: false },
    });

    const { container } = render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });

    expect((await screen.findAllByText(/^From:/)).map((heading) => heading.textContent)).toEqual([
      "From: Human",
      "From: Reviewer · reviewer",
    ]);
    expect(container.querySelectorAll(".actor-avatar")).toHaveLength(2);
    expect(container.querySelectorAll(".actor-avatar")[0]).toHaveTextContent("H");
    expect(container.querySelectorAll(".actor-avatar")[1]).toHaveTextContent("RE");
    expect(container.querySelectorAll(".actor-avatar")[1]).toHaveAttribute(
      "title",
      "Reviewer · reviewer",
    );
    const agentBubble = screen.getByText(/^From: Reviewer/).closest("article");
    expect(agentBubble).not.toBeNull();
    const agentDelivery = within(agentBubble!).getByRole("button", {
      name: "Sent to 1 · 1 terminal_injected",
    });
    await user.click(agentDelivery);
    expect(within(agentBubble!).getByText("Builder")).toBeInTheDocument();
    expect(within(agentBubble!).getByText("Retried once")).toBeInTheDocument();
    expect(within(agentBubble!).queryByText("2 attempts")).not.toBeInTheDocument();
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

    await openMessageComposer(user);
    await user.type(screen.getByLabelText("Message body"), "Backend message");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("button", { name: "Sent to 1 · 1 queued" })).toBeInTheDocument();

    rerender(
      <MessageWorkspace
        group={snapshot.groups[1]!}
        members={[memberships[2]!]}
        onSubmit={onSubmit}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Sent to 1 · 1 queued" }),
      ).not.toBeInTheDocument(),
    );
    await openMessageComposer(user);
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

    await openMessageComposer(user);
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

    await openMessageComposer(user);
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

    await openMessageComposer(user);
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
    expect(screen.queryByRole("button", { name: "Sent to 1 · 1 queued" })).not.toBeInTheDocument();
  });

  it("requires valid recipients for multicast and group audiences", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Backend" });
    await openMessageComposer(user);
    await user.selectOptions(screen.getByLabelText("Audience"), "multicast");
    expect(screen.getByLabelText("Builder (builder)")).toBeChecked();
    expect(screen.getByLabelText("Reviewer (reviewer)")).toBeChecked();
    await user.click(screen.getByLabelText("Reviewer (reviewer)"));
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Audience"), "group");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });
});
