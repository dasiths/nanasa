import type {
  ReorderGroupAgentsCommand,
  StartGroupRunsResult,
  SubmitMessageCommand,
  UpdateGroupAgentCommand,
  UpdateGroupCommand,
  UpdateRolePresentationCommand,
} from "@nanasa/contracts";
import {
  ArrowLeft,
  Bell,
  Cable,
  CircleAlert,
  Command,
  Grid2X2,
  Menu,
  Play,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { api, type PortalClient } from "./api.js";
import {
  attentionReviewCount,
  attentionReviewCountsByGroup,
  deriveAttentionItems,
} from "./attention-items.js";
import {
  deriveVisibleTerminalRunIds,
  useAttentionNotifications,
} from "./attention-notifications.js";
import { AdHocConsoleDialog } from "./components/ad-hoc-console-dialog.js";
import { type AddAgentInput, GroupTree } from "./components/group-tree.js";
import { MessageWorkspace } from "./components/message-workspace.js";
import { useAttentionWorkspaces } from "./hooks/use-attention-workspaces.js";
import { useMessageReadCursors } from "./hooks/use-message-read-cursors.js";
import {
  type TerminalColumnsPreference,
  useAppliedTheme,
  usePortalPreferences,
} from "./hooks/use-portal-preferences.js";
import { useDomainEvents, usePortalSnapshot } from "./hooks/use-portal-snapshot.js";
import { memberStatusView } from "./member-status.js";
import {
  globalDestinationDefinition,
  globalDestinationDefinitions,
  groupDestinations,
} from "./router/portal-destinations.js";
import { groupRoute, usePortalRouter } from "./router/portal-router.js";
import { CommandPalette, type PortalCommand, useScopedShortcuts } from "./shell/command-palette.js";
import {
  GroupNavigation,
  MobileNavigationDialog,
  PortalUtilities,
  RepositoryNavigation,
} from "./shell/portal-navigation.js";
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

function TerminalNavigationActions({
  columns,
  focused,
  onSetColumns,
  onRestore,
}: {
  columns: TerminalColumnsPreference;
  focused: boolean;
  onSetColumns(columns: TerminalColumnsPreference): void;
  onRestore(): void;
}) {
  if (focused) {
    return (
      <button
        type="button"
        className="compact-button terminal-restore-button"
        aria-label="All terminals"
        onClick={onRestore}
      >
        <ArrowLeft aria-hidden="true" size={14} />
        All terminals
        <span>Esc</span>
      </button>
    );
  }
  return (
    <div className="terminal-column-control">
      <span className="terminal-column-label">
        <Grid2X2 aria-hidden="true" size={13} />
        <span>Layout</span>
      </span>
      <div className="segmented-control" role="group" aria-label="Terminal columns">
        {(["auto", 1, 2, 3] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-label={
              value === "auto"
                ? "Automatic terminal columns"
                : `${value} terminal ${value === 1 ? "column" : "columns"}`
            }
            title={value === "auto" ? "Automatic terminal columns" : `${value} columns`}
            aria-pressed={columns === value}
            onClick={() => onSetColumns(value)}
          >
            {value === "auto" ? "Auto" : value}
          </button>
        ))}
      </div>
    </div>
  );
}

export function App({ client = api }: AppProps) {
  const { snapshot, config, status, error, errorSource, refresh } = usePortalSnapshot(client);
  const eventStatus = useDomainEvents(client, snapshot, () => void refresh());
  const {
    preferences,
    setTheme,
    setSelectedGroup,
    setActiveRun,
    setTerminalColumns,
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
  const [focusedTerminalGroupId, setFocusedTerminalGroupId] = useState<string>();
  const [terminalConnectionRevision, setTerminalConnectionRevision] = useState(0);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
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
  const globalMemberStatusViews = useMemo(
    () =>
      (snapshot?.memberships ?? [])
        .filter((member) => member.state === "active")
        .map((member) => ({
          member,
          ...memberStatusView(snapshot?.agentStatuses, snapshot?.runs ?? [], member),
        })),
    [snapshot],
  );
  const memberStatusViews = useMemo(
    () => globalMemberStatusViews.filter(({ member }) => member.groupId === selectedGroupId),
    [globalMemberStatusViews, selectedGroupId],
  );
  const workingCount = memberStatusViews.filter(({ key }) => key === "working").length;
  const selectedMessageState = snapshot?.messageGroups?.find(
    (state) => state.groupId === selectedGroupId,
  );
  const { unreadCounts, markReadThrough } = useMessageReadCursors(
    snapshot?.configStatus?.repoRoot,
    snapshot?.groups ?? [],
    snapshot?.messageGroups ?? [],
  );
  const attentionWorkspaceGroupIds = useMemo(
    () => (snapshot?.groups ?? []).map((group) => group.id),
    [snapshot?.groups],
  );
  const attentionWorkspaces = useAttentionWorkspaces(
    client,
    attentionWorkspaceGroupIds,
    snapshot?.instanceId,
    snapshot?.daemonEpoch,
    snapshot?.sequence,
  );
  const attentionItems = useMemo(
    () =>
      snapshot === undefined
        ? []
        : deriveAttentionItems(snapshot, {
            workspaces: attentionWorkspaces.workspaces,
            unreadCounts,
          }),
    [attentionWorkspaces.workspaces, snapshot, unreadCounts],
  );
  const attentionCountsByGroup = useMemo(
    () => attentionReviewCountsByGroup(attentionItems),
    [attentionItems],
  );
  const groupAttentionCount =
    selectedGroupId === undefined ? 0 : (attentionCountsByGroup.get(selectedGroupId) ?? 0);
  const globalAttentionCount = attentionReviewCount(attentionItems);
  const routeSection = route.kind === "group" ? route.section : undefined;
  const focusedTerminalRunId =
    route.kind === "group" &&
    route.section === "terminals" &&
    focusedTerminalGroupId === route.groupId
      ? (route.runId ?? preferences.activeRunByGroup[route.groupId])
      : undefined;
  const visibleTerminalRunIds = useMemo(
    () =>
      deriveVisibleTerminalRunIds({
        route,
        runIds: memberStatusViews.flatMap(({ run }) => (run === undefined ? [] : [run.id])),
        ...(focusedTerminalRunId === undefined ? {} : { focusedRunId: focusedTerminalRunId }),
      }),
    [focusedTerminalRunId, memberStatusViews, route],
  );
  const routeLabel =
    route.kind === "global"
      ? globalDestinationDefinition(route.destination).heading
      : `${selectedGroup?.name ?? "Workspace"} ${groupDestinations.find(({ id }) => id === routeSection)?.label ?? "Terminals"}`;
  const attentionNotifications = useAttentionNotifications({
    items: attentionItems,
    ready:
      snapshot !== undefined && attentionWorkspaces.ready && attentionWorkspaces.errors.size === 0,
    hydrationKey:
      snapshot === undefined ? undefined : `${snapshot.instanceId}:${snapshot.daemonEpoch}`,
    route,
    visibleTerminalRunIds,
    preferences: {
      ...preferences.notifications,
      completionNotificationMemberIdsByGroup: preferences.completionNotificationMemberIdsByGroup,
    },
    navigate,
  });

  useEffect(() => {
    if (snapshot === undefined) return;
    const resources = new Map<string, ReadonlySet<string>>();
    for (const group of snapshot.groups) {
      resources.set(
        group.id,
        new Set(snapshot.runs.filter((run) => run.groupId === group.id).map((run) => run.id)),
      );
    }
    const memberResources = new Map<string, ReadonlySet<string>>();
    for (const group of snapshot.groups) {
      memberResources.set(
        group.id,
        new Set(
          snapshot.memberships
            .filter((member) => member.groupId === group.id && member.state === "active")
            .map((member) => member.memberId),
        ),
      );
    }
    reconcileResources(resources, memberResources);
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
    document.title = `${globalAttentionCount > 0 ? `(${globalAttentionCount}) ` : ""}${routeLabel} · Nanasa`;
  }, [globalAttentionCount, routeLabel]);

  const commands = useMemo<PortalCommand[]>(() => {
    const global: PortalCommand[] = globalDestinationDefinitions.map((destination) => ({
      id: `route:${destination.id}`,
      label: destination.commandLabel,
      description: destination.commandDescription,
      keywords: [...destination.keywords, destination.label],
      ...("shortcut" in destination ? { shortcut: destination.shortcut } : {}),
      run: () => navigate(`/${destination.id}`),
    }));
    const groups = (snapshot?.groups ?? []).flatMap((group, index) =>
      groupDestinations.map(
        (destination): PortalCommand => ({
          id: `group:${group.id}:${destination.id}`,
          label: `${destination.label} · ${group.name}`,
          description: destination.commandDescription,
          ...(destination.id === "terminals" && index < 9 ? { shortcut: `Alt+${index + 1}` } : {}),
          keywords: [group.id, group.name, ...destination.keywords],
          run: () => {
            setSelectedGroup(group.id, destination.id);
            navigate(groupRoute(group.id, destination.id));
          },
        }),
      ),
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
    const result = await client.submitMessage(selectedGroup.id, command);
    await refresh();
    return result;
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
      notifications={attentionNotifications.toasts}
      onOpenNotification={attentionNotifications.openToast}
      onDismissNotification={attentionNotifications.dismissToast}
      rail={
        <aside className="group-rail" aria-label="Groups and agents">
          <GroupTree
            snapshot={snapshot}
            config={config}
            repositoryNavigation={
              <RepositoryNavigation
                currentDestination={route.kind === "global" ? route.destination : undefined}
                attentionCount={globalAttentionCount}
                onLink={link}
              />
            }
            utilities={
              <PortalUtilities
                currentDestination={route.kind === "global" ? route.destination : undefined}
                theme={preferences.theme}
                onSetTheme={setTheme}
                onLink={link}
              />
            }
            unreadCounts={unreadCounts}
            {...(selectedGroupId === undefined ? {} : { selectedGroupId })}
            {...(busyAction === undefined ? {} : { busyAction })}
            onSelectGroup={(groupId) => {
              const section = preferences.lastSectionByGroup[groupId] ?? "terminals";
              if (focusedTerminalGroupId !== groupId) setFocusedTerminalGroupId(undefined);
              setSelectedGroup(groupId, section);
              navigate(groupRoute(groupId, section));
            }}
            onSelectTerminal={(groupId, runId) => {
              if (runId === undefined || focusedTerminalGroupId !== groupId) {
                setFocusedTerminalGroupId(undefined);
              }
              setSelectedGroup(groupId, "terminals");
              if (runId !== undefined) setActiveRun(groupId, runId);
              navigate(groupRoute(groupId, "terminals", runId));
            }}
            onOpenMessages={(groupId) => {
              setSelectedGroup(groupId, "messages");
              navigate(groupRoute(groupId, "messages"));
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
      <header
        className={`workspace-header${route.kind === "group" && selectedGroup !== undefined ? " workspace-header-group" : ""}`}
      >
        <div className="workspace-identity">
          {route.kind === "group" && selectedGroup !== undefined ? (
            <>
              <span className="workspace-identity-mark" aria-hidden="true">
                <Users size={18} />
              </span>
              <div className="workspace-identity-copy">
                <h1 ref={workspaceHeadingRef} tabIndex={-1} data-route-heading>
                  {selectedGroup.name}
                </h1>
                <p
                  className="group-status-summary"
                  aria-label={`${members.length} agents, ${runningCount} live terminals, ${workingCount} working`}
                >
                  <span className="group-status-agents">{members.length} agents</span>
                  <span
                    className={`group-status-live${runningCount === 0 ? " group-status-empty" : ""}`}
                  >
                    {runningCount} live
                  </span>
                  <span
                    className={`group-status-working${workingCount === 0 ? " group-status-empty" : ""}`}
                  >
                    {workingCount} working
                  </span>
                </p>
              </div>
            </>
          ) : (
            <div className="workspace-identity-copy">
              <span className="eyebrow">Global operations</span>
              <h1 ref={workspaceHeadingRef} tabIndex={-1} data-route-heading>
                {route.kind === "global"
                  ? globalDestinationDefinition(route.destination).heading
                  : "No group selected"}
              </h1>
            </div>
          )}
        </div>
        {route.kind === "group" && selectedGroup !== undefined && (
          <GroupNavigation
            group={selectedGroup}
            route={route}
            unreadCount={unreadCounts.get(selectedGroup.id) ?? 0}
            attentionCount={groupAttentionCount}
            {...(route.kind === "group" && route.section === "terminals"
              ? {
                  actions: (
                    <TerminalNavigationActions
                      columns={preferences.terminalColumnsByGroup[selectedGroup.id] ?? "auto"}
                      focused={focusedTerminalRunId !== undefined}
                      onSetColumns={(columns) => setTerminalColumns(selectedGroup.id, columns)}
                      onRestore={() => setFocusedTerminalGroupId(undefined)}
                    />
                  ),
                }
              : {})}
            onLink={link}
          />
        )}
        <div className="header-actions">
          <button
            type="button"
            className="icon-button mobile-navigation-trigger"
            aria-label="Open application menu"
            onClick={() => setMobileNavigationOpen(true)}
          >
            <Menu aria-hidden="true" size={15} />
          </button>
          <a
            className="compact-button header-attention-link"
            href="/attention"
            aria-label={
              globalAttentionCount === 0
                ? "Open Attention"
                : `Open Attention, ${globalAttentionCount} ${globalAttentionCount === 1 ? "review item" : "review items"} across all groups`
            }
            onClick={link("/attention")}
          >
            <Bell aria-hidden="true" size={15} />
            {globalAttentionCount > 0 && (
              <span className="navigation-badge attention-navigation-badge">
                {globalAttentionCount > 99 ? "99+" : globalAttentionCount}
              </span>
            )}
          </a>
          <button
            type="button"
            className="compact-button command-palette-button"
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
                attentionItems={attentionItems}
                attentionWorkspaceLoading={attentionWorkspaces.loadingGroupIds}
                attentionWorkspaceErrors={attentionWorkspaces.errors}
                onNavigate={navigate}
                onRefresh={refresh}
                onReloadAttentionWorkspace={attentionWorkspaces.reloadGroup}
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
                  theme={appliedTheme}
                  columns={preferences.terminalColumnsByGroup[selectedGroup.id] ?? "auto"}
                  {...(() => {
                    const activeRunId =
                      route.kind === "group" && route.runId !== undefined
                        ? route.runId
                        : preferences.activeRunByGroup[selectedGroup.id];
                    return activeRunId === undefined ? {} : { activeRunId };
                  })()}
                  {...(focusedTerminalRunId === undefined
                    ? {}
                    : { focusedRunId: focusedTerminalRunId })}
                  onSetFocusedRun={(runId) => {
                    if (runId === undefined) {
                      setFocusedTerminalGroupId(undefined);
                      return;
                    }
                    setFocusedTerminalGroupId(selectedGroup.id);
                    setActiveRun(selectedGroup.id, runId);
                    navigate(groupRoute(selectedGroup.id, "terminals", runId));
                  }}
                />
              </Suspense>
            </section>
            {route.kind === "group" && route.section === "messages" && (
              <MessageWorkspace
                presentation="route"
                group={selectedGroup}
                members={members}
                historyMembers={groupMemberships}
                onReadThrough={(sequence) => markReadThrough(selectedGroup.id, sequence)}
                {...(selectedMessageState === undefined
                  ? {}
                  : { messageState: selectedMessageState })}
                client={client}
                onSubmit={submitMessage}
              />
            )}
            {route.kind === "group" && route.section === "terminals" && (
              <MessageWorkspace
                presentation="quick"
                group={selectedGroup}
                members={members}
                historyMembers={groupMemberships}
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
                  attentionItems={attentionItems}
                  attentionWorkspaceLoading={attentionWorkspaces.loadingGroupIds}
                  attentionWorkspaceErrors={attentionWorkspaces.errors}
                  onNavigate={navigate}
                  onRefresh={refresh}
                  onReloadAttentionWorkspace={attentionWorkspaces.reloadGroup}
                  onPatchPreferences={patchPreferences}
                />
              </Suspense>
            )}
          </div>
        )}
      </div>
      {consoleOpen && <AdHocConsoleDialog client={client} onClose={() => setConsoleOpen(false)} />}
      <MobileNavigationDialog
        open={mobileNavigationOpen}
        route={route}
        groups={snapshot.groups}
        {...(selectedGroupId === undefined ? {} : { selectedGroupId })}
        lastSectionByGroup={preferences.lastSectionByGroup}
        attentionCount={globalAttentionCount}
        theme={preferences.theme}
        onSetTheme={setTheme}
        onLink={link}
        onSelectGroup={(groupId, section) => {
          setSelectedGroup(groupId, section);
          navigate(groupRoute(groupId, section));
        }}
        onClose={() => setMobileNavigationOpen(false)}
      />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
    </PortalShell>
  );
}
