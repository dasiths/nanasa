import type {
  ReorderGroupAgentsCommand,
  StartGroupRunsResult,
  SubmitMessageCommand,
  UpdateGroupAgentCommand,
  UpdateGroupCommand,
  UpdateRolePresentationCommand,
} from "@nanasa/contracts";
import { Cable, CircleAlert, GitBranch, Laptop, Moon, Play, RefreshCw, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type PortalClient } from "./api.js";
import { AdHocConsoleDialog } from "./components/ad-hoc-console-dialog.js";
import { CheckoutWorktreeDialog } from "./components/checkout-worktree-dialog.js";
import { type AddAgentInput, GroupTree } from "./components/group-tree.js";
import { MessageWorkspace } from "./components/message-workspace.js";
import { TerminalWorkspace } from "./components/terminal-workspace.js";
import { useMessageReadCursors } from "./hooks/use-message-read-cursors.js";
import { useAppliedTheme, usePortalPreferences } from "./hooks/use-portal-preferences.js";
import { useDomainEvents, usePortalSnapshot } from "./hooks/use-portal-snapshot.js";
import { memberStatusView } from "./member-status.js";

export interface AppProps {
  client?: PortalClient;
}

export function App({ client = api }: AppProps) {
  const { snapshot, config, status, error, errorSource, refresh } = usePortalSnapshot(client);
  const eventStatus = useDomainEvents(client, snapshot, () => void refresh());
  const { preferences, setTheme } = usePortalPreferences();
  useAppliedTheme(preferences.theme);
  const [requestedGroupId, setRequestedGroupId] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [startAllResult, setStartAllResult] = useState<StartGroupRunsResult>();
  const [startingAllGroupId, setStartingAllGroupId] = useState<string>();
  const [focusSelectedGroupAfterDelete, setFocusSelectedGroupAfterDelete] = useState(false);
  const [terminalConnectionRevision, setTerminalConnectionRevision] = useState(0);
  const [portalSubmissionSuspended, setPortalSubmissionSuspended] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [checkoutsOpen, setCheckoutsOpen] = useState(false);
  const startAllInFlight = useRef(new Map<string, Promise<void>>());
  const previousEventStatus = useRef(eventStatus);
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);

  const selectedGroupId =
    snapshot?.groups.some((group) => group.id === requestedGroupId) === true
      ? requestedGroupId
      : snapshot?.groups[0]?.id;
  const selectedGroup = snapshot?.groups.find((group) => group.id === selectedGroupId);
  const groupMemberships =
    snapshot?.memberships.filter((member) => member.groupId === selectedGroupId) ?? [];
  const members = groupMemberships.filter((member) => member.state === "active");
  const runs = snapshot?.runs.filter((run) => run.groupId === selectedGroupId) ?? [];
  const runningCount = runs.filter((run) => run.status === "running").length;
  const memberStatusViews = members.map((member) =>
    memberStatusView(snapshot?.agentStatuses, runs, member),
  );
  const workingCount = memberStatusViews.filter(({ label }) => label === "working").length;
  const waitingCount = memberStatusViews.filter(({ label }) => label === "waiting").length;
  const attentionStatuses = memberStatusViews.flatMap(({ status: memberStatus }) =>
    memberStatus !== undefined && memberStatus.attention !== "none" ? [memberStatus] : [],
  );
  const attentionCount = attentionStatuses.length;
  const attentionSummary = attentionStatuses
    .map((memberStatus) => `${memberStatus.alias}: ${memberStatus.attention.replaceAll("_", " ")}`)
    .join("; ");
  const selectedMessageState = snapshot?.messageGroups?.find(
    (state) => state.groupId === selectedGroupId,
  );
  const deliveryInProgress = (selectedMessageState?.activeDeliveryCount ?? 0) > 0;
  const terminalDeliverySuspended = portalSubmissionSuspended || deliveryInProgress;
  const { unreadCounts, markReadThrough } = useMessageReadCursors(
    snapshot?.configStatus?.repoRoot,
    snapshot?.groups ?? [],
    snapshot?.messageGroups ?? [],
  );

  useEffect(() => {
    if (!focusSelectedGroupAfterDelete || selectedGroup === undefined) return;
    workspaceHeadingRef.current?.focus();
    setFocusSelectedGroupAfterDelete(false);
  }, [focusSelectedGroupAfterDelete, selectedGroup]);

  useEffect(() => {
    if (eventStatus === "connected" && previousEventStatus.current !== "connected") {
      setTerminalConnectionRevision((current) => current + 1);
    }
    previousEventStatus.current = eventStatus;
  }, [eventStatus]);

  const runAction = async (key: string, operation: () => Promise<unknown>) => {
    setBusyAction(key);
    setActionError(undefined);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The operation failed");
      throw cause;
    } finally {
      setBusyAction(undefined);
    }
  };

  const createGroup = async (name: string, instructions: string[]) => {
    let groupId: string | undefined;
    await runAction("group:create", async () => {
      const group = await client.createGroup({ name, instructions });
      groupId = group.id;
    });
    setRequestedGroupId(groupId);
  };

  const renameGroup = (groupId: string, name: string) =>
    runAction(`${groupId}:rename`, () => client.updateGroup(groupId, { name }));
  const updateGroup = (groupId: string, command: UpdateGroupCommand) =>
    runAction(`${groupId}:settings`, () => client.updateGroup(groupId, command));
  const deleteGroup = async (groupId: string) => {
    const groupIndex = snapshot?.groups.findIndex((group) => group.id === groupId) ?? -1;
    const fallbackGroupId =
      groupIndex < 0
        ? undefined
        : (snapshot?.groups[groupIndex + 1]?.id ?? snapshot?.groups[groupIndex - 1]?.id);
    await runAction(`${groupId}:delete`, () => client.deleteGroup(groupId));
    setStartAllResult((current) => (current?.groupId === groupId ? undefined : current));
    setRequestedGroupId((current) => (current === groupId ? fallbackGroupId : current));
    if (fallbackGroupId !== undefined) setFocusSelectedGroupAfterDelete(true);
  };

  const addAgent = async (input: AddAgentInput) => {
    await runAction(`${input.groupId}:add-agent`, () =>
      client.createAgent(input.groupId, {
        name: input.name,
        integrationId: input.integrationId,
        instructions: input.instructions,
        ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
      }),
    );
  };

  const renameAgent = (groupId: string, agentId: string, name: string) =>
    runAction(`${groupId}:${agentId}:rename`, () => client.updateAgent(groupId, agentId, { name }));
  const updateAgent = (groupId: string, agentId: string, command: UpdateGroupAgentCommand) =>
    runAction(`${groupId}:${agentId}:settings`, () =>
      client.updateAgent(groupId, agentId, command),
    );
  const updateRolePresentation = (roleId: string, command: UpdateRolePresentationCommand) =>
    runAction(`role:${roleId}:presentation`, () => client.updateRolePresentation(roleId, command));
  const reorderAgents = (groupId: string, command: ReorderGroupAgentsCommand) =>
    runAction(`${groupId}:reorder`, () => client.reorderAgents(groupId, command));
  const reorderGroups = (groupIds: string[], expectedOrderRevision: number) =>
    runAction("groups:reorder", () => client.reorderGroups({ groupIds, expectedOrderRevision }));
  const reparentAgent = (sourceGroupId: string, agentId: string, targetGroupId: string) =>
    runAction(`${sourceGroupId}:${agentId}:reparent`, () =>
      client.reparentAgent(sourceGroupId, agentId, {
        targetGroupId,
        expectedOrderRevision: snapshot?.orderRevision ?? 0,
      }),
    );
  const removeAgent = (groupId: string, agentId: string) =>
    runAction(`${groupId}:${agentId}:remove`, () => client.removeAgent(groupId, agentId));

  const startRun = (groupId: string, agentId: string) =>
    runAction(`${groupId}:${agentId}`, () => client.startRun(groupId, agentId));
  const stopRun = (groupId: string, agentId: string) =>
    runAction(`${groupId}:${agentId}`, () => client.stopRun(groupId, agentId));
  const startAll = (groupId: string): Promise<void> => {
    const existing = startAllInFlight.current.get(groupId);
    if (existing !== undefined) return existing;
    const idempotencyKey = crypto.randomUUID();
    setStartingAllGroupId(groupId);
    const operation = runAction(`${groupId}:start-all`, async () => {
      setStartAllResult(await client.startAllRuns(groupId, idempotencyKey));
    }).finally(() => {
      startAllInFlight.current.delete(groupId);
      setStartingAllGroupId((current) => (current === groupId ? undefined : current));
    });
    startAllInFlight.current.set(groupId, operation);
    return operation;
  };
  const submitMessage = async (command: SubmitMessageCommand) => {
    if (selectedGroup === undefined) throw new Error("Select a group before sending a message");
    setPortalSubmissionSuspended(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const result = await client.submitMessage(selectedGroup.id, command);
      await refresh();
      return result;
    } finally {
      setPortalSubmissionSuspended(false);
      setTerminalConnectionRevision((current) => current + 1);
    }
  };

  if (status === "loading") {
    return (
      <main className="portal-shell portal-state-shell">
        <div className="loading-state" role="status">
          <RefreshCw className="spin" aria-hidden="true" size={22} />
          <strong>Loading Nanasa operations...</strong>
          <span>Connecting to the daemon snapshot.</span>
        </div>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="portal-shell portal-state-shell">
        <div className="loading-state error-state" role="alert">
          <CircleAlert aria-hidden="true" size={24} />
          <strong>
            {errorSource === "config"
              ? "Repository configuration unavailable"
              : "Portal state unavailable"}
          </strong>
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" size={16} />
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (snapshot === undefined || config === undefined) {
    return null;
  }

  return (
    <main className="portal-shell">
      <aside className="group-rail" aria-label="Groups and agents">
        <GroupTree
          snapshot={snapshot}
          config={config}
          unreadCounts={unreadCounts}
          {...(selectedGroupId === undefined ? {} : { selectedGroupId })}
          {...(busyAction === undefined ? {} : { busyAction })}
          onSelectGroup={setRequestedGroupId}
          onCreateGroup={createGroup}
          onRenameGroup={renameGroup}
          onUpdateGroup={updateGroup}
          onDeleteGroup={deleteGroup}
          onAddAgent={addAgent}
          onRenameAgent={renameAgent}
          onUpdateAgent={updateAgent}
          onUpdateRolePresentation={updateRolePresentation}
          onReorderAgents={reorderAgents}
          onReorderGroups={reorderGroups}
          onReparentAgent={reparentAgent}
          onRemoveAgent={removeAgent}
          onStartRun={startRun}
          onStopRun={stopRun}
          onOpenConsole={() => setConsoleOpen(true)}
        />
      </aside>
      <section className="workspace">
        <header className="workspace-header">
          <div className="workspace-identity">
            <span className="eyebrow">Group workspace</span>
            <h1 ref={workspaceHeadingRef} tabIndex={-1}>
              {selectedGroup?.name ?? "No group selected"}
            </h1>
            {selectedGroup !== undefined && (
              <p className="group-status-summary">
                <span>{members.length} agents</span>
                <span>{runningCount} terminals</span>
                {memberStatusViews.length > 0 && (
                  <>
                    <span>{workingCount} working</span>
                    <span>{waitingCount} waiting</span>
                    <span
                      className={attentionCount > 0 ? "needs-attention" : undefined}
                      title={attentionSummary || undefined}
                    >
                      {attentionCount} {attentionCount === 1 ? "needs" : "need"} attention
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="compact-button"
              aria-label="Manage Git checkouts and worktrees"
              onClick={() => setCheckoutsOpen(true)}
            >
              <GitBranch aria-hidden="true" size={15} />
              <span>Checkouts</span>
            </button>
            {selectedGroup !== undefined && (
              <button
                type="button"
                className="compact-button start-all-button"
                aria-label={`Start all non-running agents in ${selectedGroup.name}`}
                title={`Start all non-running agents in ${selectedGroup.name}`}
                disabled={startingAllGroupId === selectedGroup.id || members.length === 0}
                onClick={() => void startAll(selectedGroup.id).catch(() => undefined)}
              >
                {startingAllGroupId === selectedGroup.id ? (
                  <RefreshCw className="spin" aria-hidden="true" size={15} />
                ) : (
                  <Play aria-hidden="true" size={15} />
                )}
                <span>Start all</span>
              </button>
            )}
            <span className={`event-status event-${eventStatus}`} title="Domain event connection">
              <Cable aria-hidden="true" size={14} />
              {eventStatus}
            </span>
            <div className="theme-switch" role="group" aria-label="Color theme">
              <button
                type="button"
                aria-label="Use light theme"
                title="Light theme"
                aria-pressed={preferences.theme === "light"}
                onClick={() => setTheme("light")}
              >
                <Sun aria-hidden="true" size={15} />
                <span>Light</span>
              </button>
              <button
                type="button"
                aria-label="Use system theme"
                title="System theme"
                aria-pressed={preferences.theme === "system"}
                onClick={() => setTheme("system")}
              >
                <Laptop aria-hidden="true" size={15} />
                <span>System</span>
              </button>
              <button
                type="button"
                aria-label="Use dark theme"
                title="Dark theme"
                aria-pressed={preferences.theme === "dark"}
                onClick={() => setTheme("dark")}
              >
                <Moon aria-hidden="true" size={15} />
                <span>Dark</span>
              </button>
            </div>
          </div>
        </header>
        {actionError !== undefined && (
          <div className="action-banner" role="alert">
            <CircleAlert aria-hidden="true" size={16} />
            <span>{actionError}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setActionError(undefined)}
            >
              <X aria-hidden="true" size={16} />
            </button>
          </div>
        )}
        {startAllResult !== undefined && startAllResult.groupId === selectedGroupId && (
          <section className="start-all-results" role="status" aria-live="polite">
            <div>
              <strong>Start all complete</strong>
              <span>
                {startAllResult.outcomes.filter((outcome) => outcome.status === "started").length}{" "}
                started,{" "}
                {
                  startAllResult.outcomes.filter((outcome) => outcome.status === "already-running")
                    .length
                }{" "}
                already running,{" "}
                {startAllResult.outcomes.filter((outcome) => outcome.status === "failed").length}{" "}
                failed
              </span>
            </div>
            <ul>
              {startAllResult.outcomes.map((outcome) => (
                <li key={outcome.memberId} className={`start-all-${outcome.status}`}>
                  <span>
                    {members.find((member) => member.memberId === outcome.memberId)?.alias ??
                      outcome.memberId}
                  </span>
                  <strong>{outcome.status.replace("-", " ")}</strong>
                  {outcome.reason !== undefined && <small>{outcome.reason}</small>}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss Start all results"
              title="Dismiss results"
              onClick={() => setStartAllResult(undefined)}
            >
              <X aria-hidden="true" size={15} />
            </button>
          </section>
        )}
        <div className="workspace-body">
          {selectedGroup === undefined ? (
            <div className="empty-state workspace-empty">
              <h2>Create a group to begin</h2>
              <p>Groups contain agents, active runs, terminals, and routed messages.</p>
            </div>
          ) : (
            <div className="unified-workspace">
              <section className="terminal-surface" aria-label="Agent terminals">
                <TerminalWorkspace
                  client={client}
                  config={config}
                  members={members}
                  roles={config.roles}
                  runs={runs}
                  agentStatuses={snapshot.agentStatuses ?? []}
                  connectionRevision={terminalConnectionRevision}
                  suspended={terminalDeliverySuspended}
                />
              </section>
              <MessageWorkspace
                group={selectedGroup}
                members={members}
                historyMembers={groupMemberships}
                unreadCount={unreadCounts.get(selectedGroup.id) ?? 0}
                activityRevision={snapshot.sequence}
                onReadThrough={(sequence) => markReadThrough(selectedGroup.id, sequence)}
                {...(selectedMessageState === undefined
                  ? {}
                  : { messageState: selectedMessageState })}
                client={client}
                onSubmit={submitMessage}
              />
            </div>
          )}
        </div>
      </section>
      {consoleOpen && <AdHocConsoleDialog client={client} onClose={() => setConsoleOpen(false)} />}
      {checkoutsOpen && (
        <CheckoutWorktreeDialog
          client={client}
          snapshot={snapshot}
          config={config}
          onChanged={refresh}
          onClose={() => setCheckoutsOpen(false)}
        />
      )}
    </main>
  );
}
