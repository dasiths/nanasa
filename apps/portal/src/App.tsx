import type { StartGroupRunsResult, SubmitMessageCommand } from "@nanasa/contracts";
import { Cable, CircleAlert, Laptop, Moon, Play, RefreshCw, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type PortalClient } from "./api.js";
import { type AddAgentInput, GroupTree } from "./components/group-tree.js";
import { MessageWorkspace } from "./components/message-workspace.js";
import { TerminalWorkspace } from "./components/terminal-workspace.js";
import { useAppliedTheme, usePortalPreferences } from "./hooks/use-portal-preferences.js";
import { useDomainEvents, usePortalSnapshot } from "./hooks/use-portal-snapshot.js";

export interface AppProps {
  client?: PortalClient;
}

export function App({ client = api }: AppProps) {
  const { snapshot, config, status, error, errorSource, refresh } = usePortalSnapshot(client);
  const eventStatus = useDomainEvents(client, snapshot, () => void refresh());
  const { preferences, setTheme } = usePortalPreferences();
  useAppliedTheme(preferences.theme);
  const [requestedGroupId, setRequestedGroupId] = useState<string>();
  const [seenMessageSequence, setSeenMessageSequence] = useState<Map<string, number>>(new Map());
  const [busyAction, setBusyAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [startAllResult, setStartAllResult] = useState<StartGroupRunsResult>();
  const [startingAllGroupId, setStartingAllGroupId] = useState<string>();
  const [focusSelectedGroupAfterDelete, setFocusSelectedGroupAfterDelete] = useState(false);
  const [terminalConnectionRevision, setTerminalConnectionRevision] = useState(0);
  const [portalSubmissionSuspended, setPortalSubmissionSuspended] = useState(false);
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
  const selectedMessageIds = new Set(
    snapshot?.messages
      .filter((message) => message.groupId === selectedGroupId)
      .map((message) => message.id) ?? [],
  );
  const deliveryInProgress =
    snapshot?.deliveryOutcomes.some(
      (outcome) =>
        selectedMessageIds.has(outcome.messageId) &&
        ["queued", "received", "delivering", "retrying"].includes(outcome.status),
    ) ?? false;
  const terminalDeliverySuspended = portalSubmissionSuspended || deliveryInProgress;

  const latestMessageSequence = new Map<string, number>();
  for (const message of snapshot?.messages ?? []) {
    latestMessageSequence.set(
      message.groupId,
      Math.max(latestMessageSequence.get(message.groupId) ?? 0, message.groupSeq),
    );
  }
  const unreadCounts = new Map<string, number>();
  for (const [groupId, latest] of latestMessageSequence) {
    unreadCounts.set(groupId, Math.max(0, latest - (seenMessageSequence.get(groupId) ?? 0)));
  }

  const selectedLatestMessageSequence = latestMessageSequence.get(selectedGroupId ?? "") ?? 0;
  useEffect(() => {
    if (selectedGroupId === undefined) {
      return;
    }
    setSeenMessageSequence((current) => {
      if ((current.get(selectedGroupId) ?? 0) >= selectedLatestMessageSequence) return current;
      const next = new Map(current);
      next.set(selectedGroupId, selectedLatestMessageSequence);
      return next;
    });
  }, [selectedGroupId, selectedLatestMessageSequence]);

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

  const createGroup = async (name: string) => {
    let groupId: string | undefined;
    await runAction("group:create", async () => {
      const group = await client.createGroup({ name });
      groupId = group.id;
    });
    setRequestedGroupId(groupId);
  };

  const renameGroup = (groupId: string, name: string) =>
    runAction(`${groupId}:rename`, () => client.updateGroup(groupId, { name }));
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
    await runAction(`${input.groupId}:add-agent`, async () => {
      let profileId = input.profileId;
      if (input.newProfile !== undefined) {
        const profile = await client.createAgentProfile({
          name: input.newProfile.name,
          agentType: input.newProfile.agentType,
        });
        profileId = profile.id;
      }
      if (profileId === undefined) {
        throw new Error("Select or create an agent profile");
      }
      await client.addMembership(input.groupId, {
        agentProfileId: profileId,
        alias: input.alias,
      });
    });
  };

  const renameAgent = (groupId: string, memberId: string, alias: string) =>
    runAction(`${groupId}:${memberId}:rename`, () =>
      client.updateMembership(groupId, memberId, { alias }),
    );
  const removeAgent = (groupId: string, memberId: string) =>
    runAction(`${groupId}:${memberId}:remove`, () => client.removeMembership(groupId, memberId));

  const startRun = (groupId: string, memberId: string) =>
    runAction(`${groupId}:${memberId}`, () => client.startRun(groupId, memberId));
  const stopRun = (groupId: string, memberId: string) =>
    runAction(`${groupId}:${memberId}`, () => client.stopRun(groupId, memberId));
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
          onDeleteGroup={deleteGroup}
          onAddAgent={addAgent}
          onRenameAgent={renameAgent}
          onRemoveAgent={removeAgent}
          onStartRun={startRun}
          onStopRun={stopRun}
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
              <p>
                {members.length} members <span aria-hidden="true">/</span> {runningCount} running
              </p>
            )}
          </div>
          <div className="header-actions">
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
              <p>Groups contain agent profiles, active runs, terminals, and routed messages.</p>
            </div>
          ) : (
            <div className="unified-workspace">
              <section className="terminal-surface" aria-label="Agent terminals">
                <TerminalWorkspace
                  client={client}
                  members={members}
                  runs={runs}
                  connectionRevision={terminalConnectionRevision}
                  suspended={terminalDeliverySuspended}
                />
              </section>
              <MessageWorkspace
                group={selectedGroup}
                members={members}
                historyMembers={groupMemberships}
                messages={snapshot.messages}
                deliveryOutcomes={snapshot.deliveryOutcomes}
                onSubmit={submitMessage}
              />
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
