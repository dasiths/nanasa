import type {
  AgentRun,
  AgentStatusSummary,
  GroupMembership,
  PortalSnapshot,
  TerminalEndpointStatus,
} from "@nanasa/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { launchConsentRequest } from "../test/launch-consent-fixture.js";
import { TerminalWorkspace } from "./terminal-workspace.js";

vi.mock("../terminal/terminal-console.js", () => ({
  TerminalConsole: ({
    label,
    visible,
    headerIdentity,
    memberIdentity,
    paneActions,
  }: {
    label: string;
    visible?: boolean;
    headerIdentity?: ReactNode;
    memberIdentity?: ReactNode;
    paneActions?: ReactNode;
  }) => (
    <div data-testid="owned-xterm" data-terminal-visible={visible}>
      {label}
      {headerIdentity}
      {memberIdentity}
      {paneActions}
    </div>
  ),
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
    recoverGroupRuns: vi.fn(),
    recoverAgentRun: vi.fn(),
    stopRun: vi.fn(),
    stopAllRuns: vi.fn(),
    listLaunchConsents: vi.fn().mockResolvedValue([]),
    getLaunchConsent: vi.fn(),
    approveLaunchConsent: vi.fn(),
    denyLaunchConsent: vi.fn(),
    cancelLaunchConsent: vi.fn(),
    revokeLaunchConsent: vi.fn(),
    submitMessage: vi.fn(),
    createAgentAction: vi.fn(),
    loadActionWorkspace: vi.fn(),
    cancelAgentAction: vi.fn(),
    replyOpenWait: vi.fn(),
    acknowledgeCompletion: vi.fn(),
    listAttentionDismissals: vi.fn().mockResolvedValue({ dismissals: [] }),
    dismissAttentionItems: vi.fn().mockResolvedValue({ dismissals: [] }),
    listAttentionSubscriptions: vi.fn(),
    setAttentionSubscription: vi.fn(),
    resetAttentionSubscriptions: vi.fn(),
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
  it("renders and keyboard-operates a no-PTY launch consent pane with safely wrapped details", async () => {
    const user = userEvent.setup();
    const request = launchConsentRequest();
    const member: GroupMembership = {
      id: request.agentId,
      groupId: request.groupId,
      memberId: request.memberId,
      agentProfileId: "profile-one",
      alias: "Builder",
      order: 0,
      state: "active",
      joinedAt: timestamp,
    };
    const approve = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockResolvedValue(undefined);
    render(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[]}
        launchConsents={[request]}
        onApproveLaunchConsent={approve}
        onCancelLaunchConsent={cancel}
      />,
    );

    const pane = screen.getByRole("region", { name: "Approval required" });
    expect(pane).toHaveClass("launch-consent-pane");
    expect(screen.getByLabelText("Exact configured command and arguments")).toHaveTextContent(
      '"sh" "bin/custom launcher" "--mode=review"',
    );
    expect(screen.getByText("Provider managed")).toBeInTheDocument();
    expect(screen.getByText("inherit · wrapper behavior not enforced")).toBeInTheDocument();

    await user.click(screen.getByText("Environment and generated access"));
    expect(screen.getByText("NANASA_MCP_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("Nanasa MCP endpoint and run-scoped credential")).toBeInTheDocument();
    expect(screen.getByText("bin/custom launcher")).toBeInTheDocument();

    await user.tab();
    while (document.activeElement?.textContent !== "Trust and start") await user.tab();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(approve).toHaveBeenCalledWith(request));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("shows unresolved consent instead of an inactive historical terminal", () => {
    const request = launchConsentRequest();
    const member: GroupMembership = {
      id: request.agentId,
      groupId: request.groupId,
      memberId: request.memberId,
      agentProfileId: "profile-one",
      alias: "Builder",
      order: 0,
      state: "active",
      joinedAt: timestamp,
    };
    const stoppedRun: AgentRun = {
      id: "run-stopped",
      groupId: request.groupId,
      memberId: request.memberId,
      agentProfileId: "profile-one",
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
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[stoppedRun]}
        launchConsents={[request]}
      />,
    );

    expect(screen.getByRole("region", { name: "Approval required" })).toBeInTheDocument();
    expect(screen.queryByText("Terminal stopped")).toBeNull();
  });

  it("reuses launch consent with provider-update copy and actions", () => {
    const request = launchConsentRequest();
    const member: GroupMembership = {
      id: request.agentId,
      groupId: request.groupId,
      memberId: request.memberId,
      agentProfileId: "profile-one",
      alias: "Builder",
      order: 0,
      state: "active",
      joinedAt: timestamp,
    };
    const run: AgentRun = {
      id: "run-old",
      groupId: member.groupId,
      memberId: member.memberId,
      agentProfileId: member.agentProfileId,
      generation: 1,
      status: "failed",
      desiredState: "running",
      recoveryPhase: "failed",
      recoveryAttempts: 1,
      launchKind: "fresh",
      requestedModelSource: "provider-default",
      providerUpdate: {
        id: "update-one",
        runId: "run-old",
        generation: 1,
        memberId: member.memberId,
        providerId: "custom",
        previousSnapshotDigest: "a".repeat(64),
        currentSnapshotDigest: "b".repeat(64),
        state: "completed",
        outcome: "approval-required",
        detectedAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      },
      startedAt: timestamp,
    };

    render(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[run]}
        launchConsents={[request]}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Review before restarting Builder" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The agent tools or launch settings changed. Confirm the command Nanasa will run.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve and restart" })).toBeVisible();
  });

  it("shows stale, denied, cancelled, loading, and API error states distinctly", async () => {
    const request = launchConsentRequest();
    const member: GroupMembership = {
      id: request.agentId,
      groupId: request.groupId,
      memberId: request.memberId,
      agentProfileId: "profile-one",
      alias: "Builder",
      order: 0,
      state: "active",
      joinedAt: timestamp,
    };
    const approve = vi.fn().mockRejectedValue(new Error("approval changed"));
    const view = render(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[]}
        launchConsents={[request]}
        onApproveLaunchConsent={approve}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trust and start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to trust and start this launcher",
    );

    for (const [state, heading] of [
      ["stale", "Request stale"],
      ["denied", "Launch denied"],
      ["cancelled", "Request cancelled"],
    ] as const) {
      view.rerender(
        <TerminalWorkspace
          client={client()}
          members={[member]}
          runs={[]}
          launchConsents={[launchConsentRequest({ state })]}
        />,
      );
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Trust and start" })).toBeNull();
    }

    view.rerender(
      <TerminalWorkspace client={client()} members={[member]} runs={[]} launchConsentsLoading />,
    );
    expect(screen.getByRole("heading", { name: "Loading launch requests" })).toBeInTheDocument();
  });

  it("keeps review details and both actions available at a narrow viewport", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    const request = launchConsentRequest({
      subject: {
        ...launchConsentRequest().subject,
        configuredCommand: ["custom-launcher", `--long=${"value".repeat(200)}`],
        environmentNames: Array.from({ length: 24 }, (_, index) => `LONG_ENVIRONMENT_${index}`),
      },
    });
    const member: GroupMembership = {
      id: request.agentId,
      groupId: request.groupId,
      memberId: request.memberId,
      agentProfileId: "profile-one",
      alias: "Builder",
      order: 0,
      state: "active",
      joinedAt: timestamp,
    };

    render(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[]}
        launchConsents={[request]}
      />,
    );

    expect(screen.getByRole("region", { name: "Approval required" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Trust and start" })).toBeVisible();
    expect(screen.getByLabelText("Exact configured command and arguments")).toHaveTextContent(
      "valuevaluevalue",
    );
    fireEvent.click(screen.getByText("Environment and generated access"));
    expect(screen.getByText("LONG_ENVIRONMENT_23")).toBeVisible();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  });

  it("mounts a portal-owned terminal without an iframe", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
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
    fireEvent.click(screen.getByRole("button", { name: "Copy agent name member-one" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("member-one"));
    expect(screen.queryByRole("button", { name: "Copy agent alias Builder" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy member ID/ })).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("projects semantic, completion, and recovery states in terminal panes", async () => {
    const members: GroupMembership[] = [
      {
        id: "agent-working",
        groupId: "group-one",
        memberId: "member-working",
        agentProfileId: "profile-one",
        alias: "Worker",
        order: 0,
        state: "active",
        joinedAt: timestamp,
      },
      {
        id: "agent-done",
        groupId: "group-one",
        memberId: "member-done",
        agentProfileId: "profile-one",
        alias: "Finisher",
        order: 1,
        state: "active",
        joinedAt: timestamp,
      },
      {
        id: "agent-recovering",
        groupId: "group-one",
        memberId: "member-recovering",
        agentProfileId: "profile-one",
        alias: "Recovering",
        order: 2,
        state: "active",
        joinedAt: timestamp,
      },
    ];
    const runs: AgentRun[] = members.map((member, index) => ({
      id: `run-${index + 1}`,
      groupId: member.groupId,
      memberId: member.memberId,
      agentProfileId: member.agentProfileId,
      generation: 1,
      status: "running",
      desiredState: "running",
      recoveryPhase: index === 2 ? "restarting" : "idle",
      recoveryAttempts: 0,
      launchKind: "fresh",
      requestedModelSource: "provider-default",
      terminal: {
        serverName: "nanasa",
        sessionId: "$1",
        windowId: `@${index + 1}`,
        paneId: `%${index + 1}`,
      },
      startedAt: timestamp,
    }));
    const statuses: AgentStatusSummary[] = [
      {
        groupId: "group-one",
        memberId: "member-working",
        alias: "Worker",
        agentType: "copilot",
        runId: "run-1",
        generation: 1,
        runStatus: "running",
        state: "waiting",
        phase: "tool",
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
      },
      {
        groupId: "group-one",
        memberId: "member-done",
        alias: "Finisher",
        agentType: "copilot",
        runId: "run-2",
        generation: 1,
        runStatus: "running",
        state: "idle",
        phase: "settled",
        outcome: "succeeded",
        confidence: "high",
        attention: "none",
        observedAt: timestamp,
        stateChangedAt: timestamp,
        statusRevision: 2,
        completionRevision: 1,
        operatorAcknowledgedCompletionRevision: 0,
        completionPending: true,
        interactiveReady: true,
        staleAuthority: false,
        authorityKind: "reporter",
        evidenceConfidence: "high",
        processState: "present",
      },
    ];

    render(
      <TerminalWorkspace
        client={client()}
        members={members}
        runs={runs}
        agentStatuses={statuses}
      />,
    );
    await screen.findAllByTestId("owned-xterm");

    expect(screen.getByLabelText("Working agent status")).toHaveClass("status-working");
    expect(screen.getByLabelText("Working agent status")).toHaveAttribute("title", "Working");
    expect(screen.getByLabelText("Done agent status")).toHaveClass("status-done");
    expect(screen.getByLabelText("Starting agent status")).toHaveClass("status-starting");
    expect(document.querySelectorAll(".status-dot")).toHaveLength(3);
    expect(document.querySelector(".connection-dot")).toBeNull();
  });

  it("projects updating, successful restart, and detailed uncertain recovery responsively", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    const member: GroupMembership = {
      id: "agent-one",
      groupId: "group-one",
      memberId: "member-one",
      agentProfileId: "profile-one",
      alias: "Builder",
      order: 0,
      state: "active",
      joinedAt: timestamp,
    };
    const transition = {
      id: "update-one",
      runId: "run-one",
      generation: 1,
      memberId: member.memberId,
      providerId: "copilot",
      previousSnapshotDigest: "a".repeat(64),
      currentSnapshotDigest: "b".repeat(64),
      state: "in-progress" as const,
      detectedAt: timestamp,
      updatedAt: timestamp,
    };
    const run: AgentRun = {
      id: "run-one",
      groupId: member.groupId,
      memberId: member.memberId,
      agentProfileId: member.agentProfileId,
      generation: 1,
      status: "running",
      desiredState: "running",
      recoveryPhase: "restarting",
      recoveryAttempts: 1,
      launchKind: "fresh",
      requestedModelSource: "provider-default",
      providerUpdate: transition,
      terminal: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
      startedAt: timestamp,
    };
    const recover = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[run]}
        onRecoverAgent={recover}
      />,
    );

    expect(screen.getByRole("region", { name: "Updating Builder" })).toHaveTextContent(
      "Agent tools changed. Nanasa is restarting Builder with the latest setup.",
    );
    expect(screen.queryByTestId("owned-xterm")).toBeNull();

    view.rerender(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[
          {
            ...run,
            status: "failed",
            recoveryPhase: "failed",
            providerUpdate: {
              ...transition,
              state: "completed",
              outcome: "ownership-uncertain",
              safeError: {
                code: "provider_update_ownership_uncertain",
                message: "Nanasa could not safely identify the old process",
                retryable: false,
              },
              completedAt: timestamp,
            },
          },
        ]}
        onRecoverAgent={recover}
      />,
    );
    expect(screen.getByRole("region", { name: "Builder needs help" })).toHaveTextContent(
      "It will not stop anything automatically.",
    );
    expect(screen.queryByRole("button", { name: "Stop the old process and restart" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(recover).toHaveBeenCalledWith("group-one", "agent-one", false));
    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByText("a".repeat(64))).toBeVisible();
    expect(screen.getByText("b".repeat(64))).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop the old process and restart" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Stop the old process and restart" }));
    expect(screen.getByRole("dialog", { name: "Restart without verification?" })).toHaveTextContent(
      "Continuing may stop the wrong process.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop and restart" }));
    await waitFor(() => expect(recover).toHaveBeenCalledWith("group-one", "agent-one", true));

    view.rerender(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[
          {
            ...run,
            id: "run-two",
            generation: 2,
            recoveryPhase: "recovered",
            providerUpdate: {
              ...transition,
              state: "completed",
              outcome: "restarted",
              replacementRunId: "run-two",
              completedAt: timestamp,
            },
          },
        ]}
      />,
    );
    expect(
      await screen.findByRole("complementary", { name: "Builder restarted" }),
    ).toHaveTextContent(
      "The agent is using the latest setup. Its previous terminal remains in history.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Builder restart notice" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Builder restarted" })).toBeNull(),
    );

    await waitFor(() =>
      expect(window.localStorage.getItem("nanasa.portal.preferences.v2")).toContain(transition.id),
    );
    view.unmount();
    const remounted = render(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[
          {
            ...run,
            id: "run-two",
            generation: 2,
            recoveryPhase: "recovered",
            providerUpdate: {
              ...transition,
              state: "completed",
              outcome: "restarted",
              replacementRunId: "run-two",
              completedAt: timestamp,
            },
          },
        ]}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Builder restarted" })).toBeNull(),
    );
    remounted.rerender(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[
          {
            ...run,
            id: "run-three",
            generation: 3,
            recoveryPhase: "recovered",
            providerUpdate: {
              ...transition,
              id: "transition-two",
              state: "completed",
              outcome: "restarted",
              replacementRunId: "run-three",
              completedAt: timestamp,
            },
          },
        ]}
      />,
    );
    expect(await screen.findByRole("complementary", { name: "Builder restarted" })).toBeVisible();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  });

  it("keeps explicit columns while pinning and focusing without remounting terminals", async () => {
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
    const portalClient = client();
    const setFocusedRun = vi.fn();
    const view = render(
      <TerminalWorkspace
        client={portalClient}
        members={members}
        runs={runs}
        columns={3}
        onSetFocusedRun={setFocusedRun}
      />,
    );
    const { container } = view;
    const initialMounts = await screen.findAllByTestId("owned-xterm");
    expect(initialMounts).toHaveLength(2);
    expect(initialMounts.map((terminal) => terminal.dataset.terminalVisible)).toEqual([
      "true",
      "true",
    ]);
    expect(container.querySelector(".terminal-layout")).toHaveClass("terminal-layout-3");
    fireEvent.click(screen.getByRole("button", { name: "Pin Reviewer terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus Builder terminal" }));
    expect(setFocusedRun).toHaveBeenLastCalledWith("run-1");
    view.rerender(
      <TerminalWorkspace
        client={portalClient}
        members={members}
        runs={runs}
        focusedRunId="run-1"
        columns={3}
        onSetFocusedRun={setFocusedRun}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Unpin Reviewer terminal", hidden: true }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show all terminals from Builder terminal" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    expect(container.querySelector(".terminal-pane-slot[hidden]")).not.toBeNull();
    expect(container.querySelector(".terminal-layout")).toHaveClass("terminal-layout-focused");
    expect(screen.getAllByTestId("owned-xterm")).toEqual([initialMounts[1], initialMounts[0]]);
    expect(initialMounts.map((terminal) => terminal.dataset.terminalVisible)).toEqual([
      "true",
      "false",
    ]);
    setFocusedRun.mockClear();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(setFocusedRun).toHaveBeenLastCalledWith(undefined);
    fireEvent.click(
      screen.getByRole("button", { name: "Show all terminals from Builder terminal" }),
    );
    expect(setFocusedRun).toHaveBeenLastCalledWith(undefined);
    expect(
      JSON.parse(window.localStorage.getItem("nanasa.portal.preferences.v2") ?? "{}"),
    ).toMatchObject({
      pinnedRunIdsByGroup: { "group-one": ["run-2"] },
    });
  });

  it("configures server-backed Attention subscriptions from the terminal bell", async () => {
    const user = userEvent.setup();
    const member = {
      id: "agent-one",
      groupId: "group-one",
      memberId: "member-one",
      agentProfileId: "profile-one",
      alias: "Builder",
      order: 0,
      state: "active" as const,
      joinedAt: timestamp,
    };
    const createRun = (id: string, generation: number) => ({
      id,
      groupId: member.groupId,
      memberId: member.memberId,
      agentProfileId: member.agentProfileId,
      generation,
      status: "running" as const,
      desiredState: "running" as const,
      recoveryPhase: "recovered" as const,
      recoveryAttempts: 0,
      launchKind: "fresh" as const,
      requestedModelSource: "provider-default" as const,
      terminal: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
      startedAt: timestamp,
    });
    const subscriptions = {
      groupId: member.groupId,
      memberId: member.memberId,
      subscriptions: [
        {
          eventType: "response-required" as const,
          enabled: true,
          source: "repository-default" as const,
        },
        {
          eventType: "agent-health" as const,
          enabled: true,
          source: "repository-default" as const,
        },
        { eventType: "completion" as const, enabled: true, source: "agent-config" as const },
        {
          eventType: "delivery-failure" as const,
          enabled: true,
          source: "repository-default" as const,
        },
        {
          eventType: "action-state" as const,
          enabled: false,
          source: "repository-default" as const,
        },
        {
          eventType: "provider-update-failed" as const,
          enabled: true,
          source: "repository-default" as const,
        },
        {
          eventType: "provider-update-succeeded" as const,
          enabled: false,
          source: "repository-default" as const,
        },
        {
          eventType: "unread-message" as const,
          enabled: false,
          source: "repository-default" as const,
        },
      ],
    };
    const setSubscription = vi.fn().mockResolvedValue(undefined);
    const resetSubscriptions = vi.fn().mockResolvedValue(undefined);
    render(
      <TerminalWorkspace
        client={client()}
        members={[member]}
        runs={[createRun("run-one", 1)]}
        attentionSubscriptions={[subscriptions]}
        onSetAttentionSubscription={setSubscription}
        onResetAttentionSubscriptions={resetSubscriptions}
      />,
    );

    await screen.findByTestId("owned-xterm");
    const bell = await screen.findByRole("button", {
      name: "Configure Attention for Builder, 5 events subscribed",
    });
    await user.click(bell);
    const menu = screen.getByRole("dialog", { name: "Builder Attention subscriptions" });
    expect(menu).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Completes work/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Changes action state/ })).not.toBeChecked();
    expect(screen.getAllByText("config").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Subscribe all" }));
    await waitFor(() => expect(setSubscription).toHaveBeenCalledTimes(3));
    expect(setSubscription.mock.calls).toEqual([
      [member.groupId, member.memberId, "action-state", true],
      [member.groupId, member.memberId, "provider-update-succeeded", true],
      [member.groupId, member.memberId, "unread-message", true],
    ]);

    setSubscription.mockClear();
    await user.click(screen.getByRole("button", { name: "Unsubscribe all" }));
    await waitFor(() => expect(setSubscription).toHaveBeenCalledTimes(5));
    expect(setSubscription.mock.calls).toEqual([
      [member.groupId, member.memberId, "response-required", false],
      [member.groupId, member.memberId, "agent-health", false],
      [member.groupId, member.memberId, "completion", false],
      [member.groupId, member.memberId, "delivery-failure", false],
      [member.groupId, member.memberId, "provider-update-failed", false],
    ]);

    setSubscription.mockClear();
    await user.click(screen.getByRole("checkbox", { name: /Changes action state/ }));
    expect(setSubscription).toHaveBeenCalledWith(
      member.groupId,
      member.memberId,
      "action-state",
      true,
    );
    await user.click(screen.getByRole("button", { name: "Reset to config defaults" }));
    expect(resetSubscriptions).toHaveBeenCalledWith(member.groupId, member.memberId);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Builder Attention subscriptions" })).toBeNull();
    expect(bell).toHaveFocus();
  });
});
