import type {
  ReorderGroupAgentsCommand,
  StartGroupRunsResult,
  SubmitMessageCommand,
  UpdateGroupAgentCommand,
  UpdateGroupCommand,
  UpdateRolePresentationCommand,
} from "@nanasa/contracts";
import {
  Cable,
  CircleAlert,
  Command,
  Laptop,
  Menu,
  Moon,
  Play,
  RefreshCw,
  Sun,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { api, type PortalClient } from "./api.js";
import { AdHocConsoleDialog } from "./components/ad-hoc-console-dialog.js";
import { CheckoutWorktreeDialog } from "./components/checkout-worktree-dialog.js";
import { type AddAgentInput, GroupTree } from "./components/group-tree.js";
import { MessageWorkspace } from "./components/message-workspace.js";
import { useMessageReadCursors } from "./hooks/use-message-read-cursors.js";
import { useAppliedTheme, usePortalPreferences } from "./hooks/use-portal-preferences.js";
import { useDomainEvents, usePortalSnapshot } from "./hooks/use-portal-snapshot.js";
import { memberStatusView } from "./member-status.js";
import { playAttentionSound } from "./notification-sound.js";
import { groupRoute, usePortalRouter } from "./router/portal-router.js";
import { CommandPalette, type PortalCommand, useScopedShortcuts } from "./shell/command-palette.js";
import { PortalShell } from "./shell/portal-shell.js";

const TerminalWorkspace = lazy(() =>
  import("./components/terminal-workspace.js").then((module) => ({
    default: module.TerminalWorkspace,
  })),
);
const PortalRoutePanel = lazy(() =>
  import("./routes/portal-route-panels.js").then((module) => ({
    default: module.PortalRoutePanel,
  })),
);

export interface AppProps {
  client?: PortalClient;
}

export function App({ client = api }: AppProps) {
  const { snapshot, config, status, error, errorSource, refresh } = usePortalSnapshot(client);
  const eventStatus = useDomainEvents(client, snapshot, () => void refresh());
  const {
    preferences,
    setTheme,
    setSelectedGroup,
    setActiveRun,
    patchPreferences,
    reconcileResources,
  } = usePortalPreferences();
  const appliedTheme = useAppliedTheme(preferences.theme);
  const { route, navigate, link } = usePortalRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  const routedGroupId = route.kind === "group" ? route.groupId : undefined;
  const selectedGroupId =
    snapshot?.groups.some((group) => group.id === routedGroupId) === true
      ? routedGroupId
      : snapshot?.groups.some((group) => group.id === preferences.selectedGroupId) === true
        ? preferences.selectedGroupId
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
  const routeSection = route.kind === "group" ? route.section : undefined;
  const routeLabel =
    route.kind === "global"
      ? route.destination[0]!.toUpperCase() + route.destination.slice(1)
      : `${selectedGroup?.name ?? "Workspace"} ${routeSection ?? "terminals"}`;

  useEffect(() => {
    if (snapshot === undefined) return;
    const resources = new Map<string, ReadonlySet<string>>();
    for (const group of snapshot.groups) {
      resources.set(
        group.id,
        new Set(snapshot.runs.filter((run) => run.groupId === group.id).map((run) => run.id)),
      );
    }
    reconcileResources(resources);
  }, [reconcileResources, snapshot]);

  useEffect(() => {
    if (snapshot === undefined) return;
    const fallback = snapshot.groups[0];
    if (route.kind === "home" || route.kind === "invalid") {
      if (fallback !== undefined) navigate(groupRoute(fallback.id), { replace: true });
      return;
    }
    if (route.kind !== "group") return;
    const groupExists = snapshot.groups.some((group) => group.id === route.groupId);
    if (!groupExists) {
      if (fallback !== undefined) navigate(groupRoute(fallback.id), { replace: true });
      else navigate("/agents", { replace: true });
      return;
    }
    if (
      route.runId !== undefined &&
      !snapshot.runs.some((run) => run.groupId === route.groupId && run.id === route.runId)
    ) {
      navigate(groupRoute(route.groupId, "terminals"), { replace: true });
    }
  }, [navigate, route, snapshot]);

  useEffect(() => {
    document.title = `${attentionCount > 0 ? `(${attentionCount}) ` : ""}${routeLabel} · Nanasa`;
  }, [attentionCount, routeLabel]);

  const previousAttention = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(
      attentionStatuses.map((status) =>
        [status.groupId, status.memberId, status.attention, status.completionRevision].join(":"),
      ),
    );
    const fresh = [...current].filter((id) => !previousAttention.current.has(id));
    previousAttention.current = current;
    if (fresh.length === 0 || document.visibilityState === "visible") return;
    void playAttentionSound({
      enabled: preferences.notifications.sound,
      eventId: fresh.sort().join("|"),
    });
    if (
      preferences.notifications.desktop &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      const notification = new Notification("Nanasa attention required", {
        body: attentionSummary || `${fresh.length} agent updates require attention`,
        tag: "nanasa-attention",
      });
      notification.onclick = () => {
        window.focus();
        navigate("/attention");
        notification.close();
      };
    }
  }, [
    attentionStatuses,
    attentionSummary,
    navigate,
    preferences.notifications.desktop,
    preferences.notifications.sound,
  ]);

  const commands = useMemo<PortalCommand[]>(() => {
    const global: PortalCommand[] = [
      ["attention", "Open attention", "Review waits, blockers, and completion", "Alt+a"],
      ["agents", "Open all agents", "Browse agents across every group", "Alt+g"],
      ["checkouts", "Open checkouts", "Manage Git checkouts and worktrees", "Alt+c"],
      ["settings", "Open settings", "Change browser presentation and notifications", "Ctrl+,"],
      ["diagnostics", "Open diagnostics", "Inspect configuration and provider state", "Alt+d"],
      ["help", "Open help", "Read keyboard and workflow help", "Alt+h"],
      ["service", "Open service", "Inspect lifecycle and planned reconnect behavior", undefined],
      ["remote", "Open remote access", "Review loopback SSH tunnel status and guidance", undefined],
    ].map(([id, label, description, shortcut]) => ({
      id: `route:${id}`,
      label: label!,
      description: description!,
      ...(shortcut === undefined ? {} : { shortcut }),
      run: () => navigate(`/${id}`),
    }));
    const groups = (snapshot?.groups ?? []).map(
      (group, index): PortalCommand => ({
        id: `group:${group.id}`,
        label: `Open ${group.name}`,
        description: "Open group terminals",
        ...(index < 9 ? { shortcut: `Alt+${index + 1}` } : {}),
        keywords: [group.id, "group", "terminal"],
        run: () => {
          setSelectedGroup(group.id, "terminals");
          navigate(groupRoute(group.id));
        },
      }),
    );
    return [...global, ...groups];
  }, [navigate, setSelectedGroup, snapshot?.groups]);
  useScopedShortcuts(commands, () => setPaletteOpen(true));

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
    if (groupId !== undefined) {
      setSelectedGroup(groupId, "terminals");
      navigate(groupRoute(groupId));
    }
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
    if (fallbackGroupId !== undefined) {
      setSelectedGroup(fallbackGroupId, "terminals");
      navigate(groupRoute(fallbackGroupId), { replace: true });
      setFocusSelectedGroupAfterDelete(true);
    } else {
      navigate("/agents", { replace: true });
    }
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
    await new Promise((resolve) => setTimeout(resolve, 500));
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
    <PortalShell
      routeLabel={routeLabel}
      density={preferences.density}
      motion={preferences.motion}
      contrast={preferences.contrast}
      rail={
        <aside className="group-rail" aria-label="Groups and agents">
          <GroupTree
            snapshot={snapshot}
            config={config}
            unreadCounts={unreadCounts}
            {...(selectedGroupId === undefined ? {} : { selectedGroupId })}
            {...(busyAction === undefined ? {} : { busyAction })}
            onSelectGroup={(groupId) => {
              const section = preferences.lastSectionByGroup[groupId] ?? "terminals";
              setSelectedGroup(groupId, section);
              navigate(groupRoute(groupId, section));
            }}
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
      }
    >
      <header className="workspace-header">
        <div className="workspace-identity">
          <span className="eyebrow">
            {route.kind === "global" ? "Global operations" : "Group workspace"}
          </span>
          <h1 ref={workspaceHeadingRef} tabIndex={-1} data-route-heading>
            {route.kind === "global"
              ? route.destination[0]!.toUpperCase() + route.destination.slice(1)
              : (selectedGroup?.name ?? "No group selected")}
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
          <label className="mobile-switcher">
            <span className="visually-hidden">Switch group</span>
            <Menu aria-hidden="true" size={15} />
            <select
              aria-label="Switch group"
              value={selectedGroupId ?? ""}
              onChange={(event) => {
                setSelectedGroup(event.target.value, "terminals");
                navigate(groupRoute(event.target.value));
              }}
            >
              {snapshot.groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="compact-button"
            aria-label="Open command palette"
            onClick={() => setPaletteOpen(true)}
          >
            <Command aria-hidden="true" size={15} />
            <span>Commands</span>
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
      <nav className="route-navigation" aria-label="Portal destinations">
        {selectedGroup !== undefined &&
          ["terminals", "messages", "activity", "settings"].map((section) => (
            <a
              key={section}
              href={groupRoute(
                selectedGroup.id,
                section as "terminals" | "messages" | "activity" | "settings",
              )}
              aria-current={
                route.kind === "group" && route.section === section ? "page" : undefined
              }
              onClick={link(
                groupRoute(
                  selectedGroup.id,
                  section as "terminals" | "messages" | "activity" | "settings",
                ),
              )}
            >
              {section}
            </a>
          ))}
        <span aria-hidden="true" />
        {[
          "attention",
          "agents",
          "checkouts",
          "extensions",
          "settings",
          "diagnostics",
          "help",
          "release",
        ].map((destination) => (
          <a
            key={destination}
            href={`/${destination}`}
            aria-current={
              route.kind === "global" && route.destination === destination ? "page" : undefined
            }
            onClick={link(`/${destination}`)}
          >
            {destination}
          </a>
        ))}
      </nav>
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
        {route.kind === "global" ? (
          <div className="unified-workspace">
            <Suspense
              fallback={
                <div className="loading-state" role="status">
                  Loading route...
                </div>
              }
            >
              <PortalRoutePanel
                route={route}
                snapshot={snapshot}
                config={config}
                members={members}
                client={client}
                preferences={preferences}
                commands={commands}
                onNavigate={navigate}
                onOpenCheckouts={() => setCheckoutsOpen(true)}
                onRefresh={refresh}
                onPatchPreferences={patchPreferences}
              />
            </Suspense>
          </div>
        ) : selectedGroup === undefined ? (
          <div className="empty-state workspace-empty">
            <h2>Create a group to begin</h2>
            <p>Groups contain agents, active runs, terminals, and routed messages.</p>
          </div>
        ) : (
          <div className="unified-workspace">
            <section
              className="terminal-surface persistent-route-surface"
              aria-label="Agent terminals"
              hidden={route.kind !== "group" || route.section !== "terminals"}
            >
              <Suspense
                fallback={
                  <div className="loading-state" role="status">
                    Loading terminal workspace...
                  </div>
                }
              >
                <TerminalWorkspace
                  client={client}
                  config={config}
                  members={members}
                  roles={config.roles}
                  runs={runs}
                  agentStatuses={snapshot.agentStatuses ?? []}
                  connectionRevision={terminalConnectionRevision}
                  suspended={terminalDeliverySuspended}
                  theme={appliedTheme}
                  {...(() => {
                    const activeRunId =
                      route.kind === "group" && route.runId !== undefined
                        ? route.runId
                        : preferences.activeRunByGroup[selectedGroup.id];
                    return activeRunId === undefined ? {} : { activeRunId };
                  })()}
                  onSelectRun={(runId) => {
                    setActiveRun(selectedGroup.id, runId);
                    navigate(groupRoute(selectedGroup.id, "terminals", runId));
                  }}
                />
              </Suspense>
            </section>
            {route.kind === "group" && route.section === "messages" ? (
              <MessageWorkspace
                presentation="route"
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
            ) : (
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
            )}
            {!(route.kind === "group" && ["terminals", "messages"].includes(route.section)) && (
              <Suspense
                fallback={
                  <div className="loading-state" role="status">
                    Loading route...
                  </div>
                }
              >
                <PortalRoutePanel
                  route={route}
                  snapshot={snapshot}
                  config={config}
                  group={selectedGroup}
                  members={members}
                  client={client}
                  preferences={preferences}
                  commands={commands}
                  onNavigate={navigate}
                  onOpenCheckouts={() => setCheckoutsOpen(true)}
                  onRefresh={refresh}
                  onPatchPreferences={patchPreferences}
                />
              </Suspense>
            )}
          </div>
        )}
      </div>
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
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
    </PortalShell>
  );
}
