import type {
  AgentAction,
  AgentActionWorkspace,
  AgentRun,
  AgentStatusSummary,
  GroupMembership,
  OpenWait,
  PortalSnapshot,
} from "@nanasa/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { deriveAttentionItems } from "../attention-items.js";
import { defaultPortalPreferences } from "../hooks/use-portal-preferences.js";
import { PortalRoutePanel } from "./portal-route-panels.js";

const timestamp = "2026-08-31T12:00:00.000Z";

const service = {
  formatVersion: 1,
  repositoryId: "repo-fixture",
  instanceName: "nanasa-aaaaaaaaaaaaaaaaaaaa",
  unitName: "nanasa-aaaaaaaaaaaaaaaaaaaa.service",
  repositoryRoot: "/repo",
  packageRoot: "/package",
  nodePath: "/usr/bin/node",
  cliPath: "/package/bin/nanasa.js",
  portalUrl: "http://127.0.0.1:3210",
  state: "ready",
  detail: "Service is ready",
  killMode: "process",
} as const;

function props(
  destination: "attention" | "agents" | "service" | "remote" | "settings",
  client: PortalClient,
) {
  return {
    route: { kind: "global", destination } as const,
    snapshot: { groups: [] },
    config: {},
    members: [],
    client,
    preferences: {},
    commands: [],
    onNavigate: vi.fn(),
    onRefresh: vi.fn(),
    onDismissAttentionItems: vi.fn().mockResolvedValue(true),
    onPatchPreferences: vi.fn(),
  } as unknown as Parameters<typeof PortalRoutePanel>[0];
}

function membership(
  groupId: string,
  alias: string,
  memberId = alias.toLowerCase(),
): GroupMembership {
  return {
    id: `${groupId}-${memberId}`,
    groupId,
    memberId,
    agentProfileId: "profile-one",
    alias,
    order: 0,
    state: "active",
    joinedAt: timestamp,
  };
}

function run(member: GroupMembership, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: `run-${member.groupId}-${member.memberId}`,
    groupId: member.groupId,
    memberId: member.memberId,
    agentProfileId: member.agentProfileId,
    generation: 1,
    status: "running",
    desiredState: "running",
    recoveryPhase: "idle",
    recoveryAttempts: 0,
    launchKind: "fresh",
    requestedModelSource: "provider-default",
    startedAt: timestamp,
    ...overrides,
  };
}

function status(
  member: GroupMembership,
  currentRun: AgentRun,
  overrides: Partial<AgentStatusSummary> = {},
): AgentStatusSummary {
  return {
    groupId: member.groupId,
    memberId: member.memberId,
    alias: member.alias,
    agentType: "copilot",
    runId: currentRun.id,
    generation: currentRun.generation,
    runStatus: currentRun.status,
    state: "working",
    phase: "model",
    outcome: "unknown",
    confidence: "high",
    attention: "none",
    observedAt: timestamp,
    stateChangedAt: timestamp,
    statusRevision: 1,
    completionRevision: 0,
    operatorAcknowledgedCompletionRevision: 0,
    completionPending: false,
    interactiveReady: true,
    staleAuthority: false,
    authorityKind: "reporter",
    evidenceConfidence: "high",
    processState: "present",
    ...overrides,
  };
}

function snapshot(
  memberships: GroupMembership[],
  runs: AgentRun[],
  agentStatuses: AgentStatusSummary[],
): PortalSnapshot {
  return {
    instanceId: "instance-one",
    daemonEpoch: 1,
    sequence: 1,
    generatedAt: timestamp,
    orderRevision: 0,
    groups: [...new Set(memberships.map((member) => member.groupId))].map((groupId, order) => ({
      id: groupId,
      name: `Group ${order + 1}`,
      order,
      membershipRevision: 1,
      checkoutRevision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    agentProfiles: [],
    memberships,
    runs,
    repositories: [],
    checkouts: [],
    worktrees: [],
    agentStatuses,
    messages: [],
    deliveryOutcomes: [],
    messageGroups: [],
  };
}

describe("service and remote route panels", () => {
  it("loads shared lifecycle descriptors and renders continuity boundaries", async () => {
    const client = {
      loadServiceStatus: vi.fn().mockResolvedValue(service),
      planServiceRestart: vi.fn().mockResolvedValue({
        version: 1,
        type: "service.restart",
        reason: "operator-restart",
        instanceId: "instance-fixture",
        retryAfterMs: 1_000,
        resnapshotRequired: true,
        terminalHandoff: false,
      }),
      loadRemoteStatus: vi.fn().mockResolvedValue({
        formatVersion: 1,
        repositoryId: "repo-fixture",
        instanceId: "instance-fixture",
        build: { packageVersion: "0.1.0-next.11.0", commit: "a".repeat(40) },
        apiVersion: 1,
        eventProtocolVersion: 1,
        terminalProtocolVersion: 1,
        service: {
          instanceName: service.instanceName,
          unitName: service.unitName,
          state: "ready",
        },
        loopbackHost: "127.0.0.1",
        port: 3210,
      }),
    } as unknown as PortalClient;

    const view = render(<PortalRoutePanel {...props("service", client)} />);
    expect(await screen.findByText("Service is ready")).toBeInTheDocument();
    expect(
      screen.getByText("tmux processes survive; terminal WebSockets reconnect"),
    ).toBeInTheDocument();
    screen.getByRole("button", { name: "Preview planned restart" }).click();
    expect(
      await screen.findByText(/resnapshot required, PTY handoff disabled/),
    ).toBeInTheDocument();

    view.rerender(<PortalRoutePanel {...props("remote", client)} />);
    await waitFor(() => expect(client.loadRemoteStatus).toHaveBeenCalled());
    expect(await screen.findByText("0.1.0-next.11.0")).toBeInTheDocument();
    expect(screen.getByText(/Direct portal exposure/)).toBeInTheDocument();
  });
});

describe("notification preferences", () => {
  it("sends a test browser notification after permission is granted", () => {
    const notifications: Array<{
      title: string;
      options: NotificationOptions | undefined;
    }> = [];
    class TestNotification {
      public static readonly permission = "granted";

      public constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, options });
      }
    }
    vi.stubGlobal("Notification", TestNotification);
    render(
      <PortalRoutePanel
        {...props("settings", {} as PortalClient)}
        preferences={{
          ...defaultPortalPreferences,
          notifications: { ...defaultPortalPreferences.notifications, desktop: true },
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Browser notifications: On");
    screen.getByRole("button", { name: "Send test notification" }).click();
    expect(notifications).toEqual([
      {
        title: "Nanasa browser notifications",
        options: {
          body: "Subscribed Attention items can appear here while the portal is open.",
          silent: true,
        },
      },
    ]);
  });

  it("keeps denied desktop permission disabled and can disable an enabled preference", async () => {
    const onPatchPreferences = vi.fn();
    const requestPermission = vi.fn().mockResolvedValue("denied");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const base = {
      ...props("settings", {} as PortalClient),
      preferences: defaultPortalPreferences,
      onPatchPreferences,
    };
    const view = render(<PortalRoutePanel {...base} />);

    expect(screen.queryByLabelText(/completion notifications/i)).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Request desktop notifications" }).click();
    await waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());
    expect(onPatchPreferences).toHaveBeenCalledWith({
      notifications: { ...defaultPortalPreferences.notifications, desktop: false },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Browser notifications: Blocked");
    expect(screen.getByRole("button", { name: "Send test notification" })).toBeDisabled();

    onPatchPreferences.mockClear();
    view.rerender(
      <PortalRoutePanel
        {...base}
        preferences={{
          ...defaultPortalPreferences,
          notifications: { ...defaultPortalPreferences.notifications, desktop: true },
        }}
      />,
    );
    screen.getByRole("button", { name: "Disable desktop notifications" }).click();
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(onPatchPreferences).toHaveBeenCalledWith({
      notifications: { ...defaultPortalPreferences.notifications, desktop: false },
    });
  });
});

describe("projected status route panels", () => {
  it("renders the subscribed inbox with filters and exactly two actions per item", () => {
    const builder = membership("group-done", "Builder");
    const reviewer = membership("group-approval", "Reviewer");
    const recipient = membership("group-delivery", "Recipient");
    const builderRun = run(builder);
    const reviewerRun = run(reviewer);
    const input = snapshot(
      [builder, reviewer, recipient],
      [builderRun, reviewerRun],
      [
        status(builder, builderRun, {
          state: "idle",
          completionRevision: 2,
          completionPending: true,
        }),
        status(reviewer, reviewerRun, {
          state: "blocked",
          phase: "plan_approval",
          attention: "decision_required",
        }),
      ],
    );
    input.messageGroups = [
      {
        groupId: recipient.groupId,
        latestGroupSeq: 3,
        retainedMessageCount: 3,
        activeDeliveryCount: 0,
        failedRecipientMemberIds: [recipient.memberId],
      },
    ];
    const onDismissAttentionItems = vi.fn().mockResolvedValue(true);
    const routeProps = {
      ...props("attention", {} as PortalClient),
      onDismissAttentionItems,
      snapshot: input,
      attentionItems: deriveAttentionItems(input),
    };
    const { container } = render(<PortalRoutePanel {...routeProps} />);

    expect(screen.getByText(/subscribed inbox/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Needs action 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const row of container.querySelectorAll(".attention-inbox-row")) {
      expect(within(row as HTMLElement).getAllByRole("button")).toHaveLength(2);
    }
    expect(
      screen.queryByRole("button", { name: /acknowledge|approve|reply|retry|cancel/i }),
    ).toBeNull();

    const reviewerRow = screen.getByText("Reviewer · Needs approval").closest("li")!;
    within(reviewerRow).getByRole("button", { name: "Open terminal" }).click();
    expect(routeProps.onNavigate).toHaveBeenCalledWith(
      "/groups/group-approval/terminals/run-group-approval-reviewer",
    );
    within(reviewerRow).getByRole("button", { name: "Dismiss Reviewer · Needs approval" }).click();
    expect(onDismissAttentionItems).toHaveBeenCalledWith([expect.any(String)]);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "delivery" } });
    expect(screen.getByText("Recipient · Delivery failed")).toBeInTheDocument();
    expect(screen.queryByText("Builder · Completion ready")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by type" }), {
      target: { value: "completion" },
    });
    expect(screen.getByText("Builder · Completion ready")).toBeInTheDocument();
    expect(screen.queryByText("Reviewer · Needs approval")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by type" }), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by team" }), {
      target: { value: reviewer.groupId },
    });
    expect(screen.getByText("Reviewer · Needs approval")).toBeInTheDocument();
    expect(screen.queryByText("Recipient · Delivery failed")).not.toBeInTheDocument();
  });

  it("offers selection with durable bulk dismissal and clear selection only", async () => {
    const builder = membership("group-done", "Builder");
    const reviewer = membership("group-done", "Reviewer");
    const builderRun = run(builder);
    const reviewerRun = run(reviewer);
    const input = snapshot(
      [builder, reviewer],
      [builderRun, reviewerRun],
      [
        status(builder, builderRun, { completionRevision: 2, completionPending: true }),
        status(reviewer, reviewerRun, { completionRevision: 3, completionPending: true }),
      ],
    );
    const onDismissAttentionItems = vi.fn().mockResolvedValue(true);
    render(
      <PortalRoutePanel
        {...props("attention", {} as PortalClient)}
        snapshot={input}
        attentionItems={deriveAttentionItems(input)}
        onDismissAttentionItems={onDismissAttentionItems}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Builder · Completion ready" }));
    const selection = screen.getByRole("group", { name: "Selected Attention items" });
    expect(
      within(selection)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Dismiss selected", "Clear selection"]);
    fireEvent.click(within(selection).getByRole("button", { name: "Clear selection" }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Selected Attention items" })).toBeNull(),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Builder · Completion ready" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Reviewer · Completion ready" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss selected" }));
    await waitFor(() =>
      expect(onDismissAttentionItems).toHaveBeenCalledWith([
        expect.any(String),
        expect.any(String),
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Selected Attention items" })).toBeNull(),
    );
  });

  it("preserves partial workspace errors, retry, and action hash focus", async () => {
    const owner = membership("group-scope", "Builder", "builder");
    const ownerRun = run(owner);
    const input = snapshot(
      [owner],
      [ownerRun],
      [status(owner, ownerRun, { state: "waiting", attention: "input_required" })],
    );
    const action: AgentAction = {
      version: 1,
      id: "action-1",
      kind: "prompt",
      principal: { kind: "operator", operatorId: "operator-one" },
      target: {
        groupId: owner.groupId,
        memberId: owner.memberId,
        runId: ownerRun.id,
        generation: ownerRun.generation,
        daemonEpoch: 1,
        reporterSessionId: "session-one",
        reporterId: "reporter-one",
        reporterEpoch: "epoch-one",
        baselineStatusRevision: 1,
        baselineCompletionRevision: 0,
      },
      idempotencyKey: "action-key",
      requestDigest: "a".repeat(64),
      prompt: "Continue",
      allowWorking: false,
      state: "created",
      queueDeadlineAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const exactWait: OpenWait = {
      id: "wait-1",
      groupId: owner.groupId,
      memberId: owner.memberId,
      runId: ownerRun.id,
      generation: ownerRun.generation,
      reporterSessionId: "session-one",
      reporterId: "reporter-one",
      reporterEpoch: "epoch-one",
      providerRequestId: "permission-one",
      kind: "permission",
      summary: "Allow one command?",
      replyChannel: "terminal",
      openedStatusRevision: 7,
      state: "open",
      openedAt: timestamp,
      updatedAt: timestamp,
    };
    const workspace: AgentActionWorkspace = {
      groupId: owner.groupId,
      actions: [action],
      attempts: [],
      acknowledgements: [],
      openWaits: [exactWait],
    };
    const reload = vi.fn().mockResolvedValue(undefined);
    const routeProps = {
      ...props("attention", {} as PortalClient),
      route: { kind: "group", groupId: owner.groupId, section: "activity" } as const,
      group: input.groups[0]!,
      snapshot: input,
      members: [owner],
      attentionItems: deriveAttentionItems(input, [workspace]),
      attentionWorkspaceLoading: new Set<string>(),
      attentionWorkspaceErrors: new Map([
        [
          owner.groupId,
          {
            message: "Unable to load Attention details",
            details: { cause: "temporarily unavailable" },
            code: "portal_operation_failed",
          },
        ],
      ]),
      onReloadAttentionWorkspace: reload,
    };
    window.history.replaceState({}, "", `/groups/${owner.groupId}/activity#action-action-1`);

    render(<PortalRoutePanel {...routeProps} />);

    expect(screen.getByRole("heading", { name: "Attention" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Needs action 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All 2" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter by team" })).toHaveValue(owner.groupId);
    expect(screen.getByRole("combobox", { name: "Filter by team" })).toBeDisabled();
    expect(screen.getByText("Unable to load Attention details")).toBeInTheDocument();
    expect(screen.getByText("portal_operation_failed")).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById("action-action-1")).toHaveFocus());
    expect(screen.getByRole("button", { name: "Active 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Builder · Action created")).toBeVisible();
    expect(screen.queryByRole("button", { name: /allow once|cancel/i })).toBeNull();

    screen.getByRole("button", { name: "Retry" }).click();
    expect(reload).toHaveBeenCalledWith(owner.groupId);
  });

  it("separates active and history views with action diagnostics and timestamps", () => {
    const owner = membership("group-history", "Builder", "builder");
    const ownerRun = run(owner);
    const active: AgentAction = {
      version: 1,
      id: "action-active",
      kind: "prompt",
      principal: { kind: "operator", operatorId: "operator-one" },
      target: {
        groupId: owner.groupId,
        memberId: owner.memberId,
        runId: ownerRun.id,
        generation: ownerRun.generation,
        daemonEpoch: 1,
        reporterSessionId: "session-one",
        reporterId: "reporter-one",
        reporterEpoch: "epoch-one",
        baselineStatusRevision: 1,
        baselineCompletionRevision: 0,
      },
      idempotencyKey: "active-key",
      requestDigest: "b".repeat(64),
      prompt: "Continue",
      allowWorking: false,
      state: "created",
      queueDeadlineAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const stalled: AgentAction = {
      ...active,
      id: "action-stalled",
      idempotencyKey: "stalled-key",
      state: "stalled",
      error: {
        code: "agent_prompt_stalled",
        message: "Reporter did not acknowledge",
        retryable: false,
      },
    };
    const input = snapshot([owner], [ownerRun], []);
    const workspace: AgentActionWorkspace = {
      groupId: owner.groupId,
      actions: [active, stalled],
      attempts: [],
      acknowledgements: [],
      openWaits: [],
    };

    const { container } = render(
      <PortalRoutePanel
        {...props("attention", {} as PortalClient)}
        snapshot={input}
        attentionItems={deriveAttentionItems(input, [workspace])}
      />,
    );

    expect(screen.getByRole("button", { name: "Active 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "History 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Active 1" }));
    expect(screen.getByText("Builder · Action created")).toBeVisible();
    expect(screen.queryByText("Delivery unconfirmed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "History 1" }));
    expect(screen.queryByText("Builder · Action created")).not.toBeInTheDocument();
    expect(screen.getByText("Delivery unconfirmed")).toBeVisible();
    const diagnostic = screen.getByTitle("Diagnostic code: agent_prompt_stalled");
    expect(diagnostic).toHaveTextContent(
      "Nanasa sent this prompt to Builder, but could not confirm that the agent received it. The prompt may still have run.",
    );
    expect(within(diagnostic).getByText("agent_prompt_stalled")).toBeVisible();
    expect(container.querySelector("time")).toHaveAttribute("datetime", timestamp);
    const row = screen.getByText("Delivery unconfirmed").closest("li")!;
    expect(within(row).getAllByRole("button")).toHaveLength(2);
  });

  it("keeps provider-update preferences as post-dismiss cleanup, not inbox filtering", async () => {
    const builder = membership("group-update", "Builder");
    const currentRun = run(builder);
    const restartedRun = {
      ...currentRun,
      providerUpdate: {
        id: "update-builder",
        runId: currentRun.id,
        generation: currentRun.generation,
        memberId: currentRun.memberId,
        providerId: "copilot",
        previousSnapshotDigest: "a".repeat(64),
        currentSnapshotDigest: "b".repeat(64),
        state: "completed" as const,
        outcome: "restarted" as const,
        replacementRunId: currentRun.id,
        detectedAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      },
    };
    const input = snapshot([builder], [restartedRun], []);
    const onDismissAttentionItems = vi.fn().mockResolvedValue(true);
    const onPatchPreferences = vi.fn();
    render(
      <PortalRoutePanel
        {...props("attention", {} as PortalClient)}
        snapshot={input}
        attentionItems={deriveAttentionItems(input)}
        preferences={{
          ...defaultPortalPreferences,
          dismissedProviderUpdateIds: ["update-builder"],
        }}
        onDismissAttentionItems={onDismissAttentionItems}
        onPatchPreferences={onPatchPreferences}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "History 1" }));
    expect(screen.getByText("Builder restarted")).toBeVisible();
    screen.getByRole("button", { name: "Dismiss Builder restarted" }).click();
    await waitFor(() => expect(onDismissAttentionItems).toHaveBeenCalledWith([expect.any(String)]));
    expect(onPatchPreferences).toHaveBeenCalledWith({
      dismissedProviderUpdateIds: ["update-builder"],
    });
  });

  it("routes delivery summaries to group Messages without inventing a message ID", () => {
    const recipient = membership("group-delivery", "Recipient", "recipient");
    const input = {
      ...snapshot([recipient], [], []),
      messageGroups: [
        {
          groupId: recipient.groupId,
          latestGroupSeq: 3,
          retainedMessageCount: 3,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: [recipient.memberId],
        },
      ],
    };
    const routeProps = {
      ...props("attention", {} as PortalClient),
      snapshot: input,
      attentionItems: deriveAttentionItems(input),
    };

    render(<PortalRoutePanel {...routeProps} />);
    screen.getByRole("button", { name: "Open messages" }).click();

    expect(routeProps.onNavigate).toHaveBeenCalledWith("/groups/group-delivery/messages");
  });

  it("uses exact group runs and projected labels in All agents", () => {
    const first = membership("group-one", "Alpha", "shared");
    const second = membership("group-two", "Beta", "shared");
    const firstRun = run(first, { effectiveModel: "model-one" });
    const secondRun = run(second, {
      generation: 9,
      status: "failed",
      effectiveModel: "model-two",
    });
    const routeProps = {
      ...props("agents", {} as PortalClient),
      snapshot: snapshot(
        [first, second],
        [firstRun, secondRun],
        [
          status(first, firstRun, {
            state: "unknown",
            attention: "reporter_stale",
            staleAuthority: true,
          }),
        ],
      ),
    };

    render(<PortalRoutePanel {...routeProps} />);

    expect(
      within(screen.getByRole("button", { name: "Inspect Alpha" })).getByText(
        "Unknown · model-one",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: "Inspect Beta" })).getByText("Failed · model-two"),
    ).toBeInTheDocument();
  });
});
