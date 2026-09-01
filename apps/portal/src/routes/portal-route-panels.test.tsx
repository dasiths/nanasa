import type {
  AgentAction,
  AgentActionWorkspace,
  AgentRun,
  AgentStatusSummary,
  GroupMembership,
  OpenWait,
  PortalSnapshot,
} from "@nanasa/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  it("keeps denied desktop permission disabled and can disable an enabled preference", async () => {
    const onPatchPreferences = vi.fn();
    const requestPermission = vi.fn().mockResolvedValue("denied");
    vi.stubGlobal("Notification", { requestPermission });
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
  it("shows only projected attention statuses in precedence order with qualified actions", async () => {
    const doneMember = membership("group-done", "Builder");
    const staleMember = membership("group-stale", "Watcher");
    const approvalMember = membership("group-approval", "Reviewer");
    const doneRun = run(doneMember);
    const staleRun = run(staleMember);
    const approvalRun = run(approvalMember);
    const acknowledgeCompletion = vi.fn().mockResolvedValue(undefined);
    const client = { acknowledgeCompletion } as unknown as PortalClient;
    let resolveRefresh: () => void = () => undefined;
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const routeProps = {
      ...props("attention", client),
      onRefresh,
      snapshot: snapshot(
        [doneMember, staleMember, approvalMember],
        [doneRun, staleRun, approvalRun],
        [
          status(doneMember, doneRun, {
            state: "idle",
            phase: "settled",
            outcome: "succeeded",
            completionRevision: 2,
            completionPending: true,
          }),
          status(staleMember, staleRun, {
            state: "unknown",
            phase: "startup",
            attention: "reporter_stale",
            staleAuthority: true,
          }),
          status(approvalMember, approvalRun, {
            state: "blocked",
            phase: "plan_approval",
            attention: "decision_required",
          }),
        ],
      ),
    };

    const view = render(<PortalRoutePanel {...routeProps} />);
    const { container } = view;

    expect(
      [...container.querySelectorAll(".workflow-row strong")].map((item) => item.textContent),
    ).toEqual(["Reviewer · Needs approval", "Builder · Completion ready"]);
    expect(screen.queryByText(/Watcher/)).not.toBeInTheDocument();
    expect(screen.queryByText(/reporter stale|decision required|plan approval/i)).toBeNull();
    screen.getByRole("button", { name: "Completions 1" }).click();
    await waitFor(() =>
      expect(screen.queryByText("Reviewer · Needs approval")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Builder · Completion ready")).toBeInTheDocument();
    screen.getByRole("button", { name: "All 2" }).click();
    const reviewer = (await screen.findByText("Reviewer · Needs approval")).closest("li")!;
    within(reviewer).getByRole("button", { name: "Open terminal" }).click();
    expect(routeProps.onNavigate).toHaveBeenCalledWith(
      "/groups/group-approval/terminals/run-group-approval-reviewer",
    );
    const builder = screen.getByText("Builder · Completion ready").closest("li")!;
    within(builder).getByRole("button", { name: "Acknowledge" }).click();
    await waitFor(() =>
      expect(acknowledgeCompletion).toHaveBeenCalledWith("group-done", "builder"),
    );
    expect(screen.queryByText("Builder · Completion ready")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Completions 0" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Completion acknowledged for Builder.");
    expect(onRefresh).toHaveBeenCalledOnce();

    const newerSnapshot = snapshot(
      [doneMember, staleMember, approvalMember],
      [doneRun, staleRun, approvalRun],
      [
        status(doneMember, doneRun, {
          state: "idle",
          phase: "settled",
          outcome: "succeeded",
          statusRevision: 4,
          completionRevision: 3,
          completionPending: true,
        }),
        status(staleMember, staleRun, {
          state: "unknown",
          phase: "startup",
          attention: "reporter_stale",
          staleAuthority: true,
        }),
        status(approvalMember, approvalRun, {
          state: "blocked",
          phase: "plan_approval",
          attention: "decision_required",
        }),
      ],
    );
    view.rerender(<PortalRoutePanel {...routeProps} snapshot={newerSnapshot} />);
    expect(screen.getByText("Completion revision 3 is ready for review.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Completions 1" })).toBeInTheDocument();
    resolveRefresh();
  });

  it("keeps exact wait and cancellation controls safe in group Attention", async () => {
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
    const replyOpenWait = vi.fn().mockResolvedValue({ ...exactWait, state: "replying" });
    const cancelAgentAction = vi.fn().mockResolvedValue({ ...action, state: "cancelled" });
    const reload = vi.fn().mockResolvedValue(undefined);
    const client = { replyOpenWait, cancelAgentAction } as unknown as PortalClient;
    const routeProps = {
      ...props("attention", client),
      route: { kind: "group", groupId: owner.groupId, section: "activity" } as const,
      group: input.groups[0]!,
      snapshot: input,
      members: [owner],
      attentionItems: deriveAttentionItems(input, [workspace]),
      attentionWorkspaceLoading: new Set<string>(),
      attentionWorkspaceErrors: new Map([[owner.groupId, "temporarily unavailable"]]),
      onReloadAttentionWorkspace: reload,
    };
    window.history.replaceState({}, "", `/groups/${owner.groupId}/activity#action-action-1`);

    render(<PortalRoutePanel {...routeProps} />);

    expect(screen.getByRole("heading", { name: "Attention" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All 1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Requires response 1" })).toBeInTheDocument();
    expect(screen.getByText("1 active action")).toBeInTheDocument();
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById("action-action-1")).toHaveFocus());

    screen.getByRole("button", { name: "Allow once" }).click();
    await waitFor(() =>
      expect(replyOpenWait).toHaveBeenCalledWith("wait-1", {
        expectedRunId: ownerRun.id,
        expectedGeneration: ownerRun.generation,
        expectedReporterEpoch: "epoch-one",
        expectedStatusRevision: 7,
        reply: { kind: "allow-once" },
      }),
    );
    expect(await screen.findByText(/Waiting for the reporter to close this wait/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();

    screen.getByRole("button", { name: "Cancel" }).click();
    await waitFor(() => expect(cancelAgentAction).toHaveBeenCalledWith("action-1"));
    expect(screen.getByRole("button", { name: "Cancellation requested" })).toBeDisabled();
    expect(reload).toHaveBeenCalledWith(owner.groupId);
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
    screen.getByRole("button", { name: "Open Messages" }).click();

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
      within(screen.getByText("Alpha").closest("li")!).getByText("Unknown · model-one"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByText("Beta").closest("li")!).getByText("Failed · model-two"),
    ).toBeInTheDocument();
  });
});
