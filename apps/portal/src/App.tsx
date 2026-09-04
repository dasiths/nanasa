import type {
  AttentionSubscriptionsSnapshot,
  CustomLaunchConsentRequest,
  ProviderUpdateOutcome,
  ProviderUpdateRecoveryResult,
  ReorderGroupAgentsCommand,
  StartGroupRunsResult,
  SubmitMessageCommand,
  UpdateGroupAgentCommand,
  UpdateGroupCommand,
  UpdateRolePresentationCommand,
} from "@nanasa/contracts";
import {
  Activity,
  ArrowLeft,
  Bell,
  Bot,
  Cable,
  Grid2X2,
  LoaderCircle,
  Menu,
  Play,
  RadioTower,
  RefreshCw,
  ScanSearch,
  Square,
  UserPlus,
  Users,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { api, type PortalClient } from "./api.js";
import {
  attentionReviewCount,
  attentionReviewCountsByGroup,
  deriveAttentionItems,
  filterAttentionItemsBySubscriptions,
} from "./attention-items.js";
import {
  deriveVisibleTerminalRunIds,
  useAttentionNotifications,
} from "./attention-notifications.js";
import { AdHocConsoleDialog } from "./components/ad-hoc-console-dialog.js";
import {
  AddAgentDialog,
  type AddAgentInput,
  GroupTree,
  RoleSettingsDialog,
} from "./components/group-tree.js";
import { MessageWorkspace } from "./components/message-workspace.js";
import { TeamRecoveryResults } from "./components/team-recovery-results.js";
import { ErrorNotice, type PortalError, toPortalError } from "./errors.js";
import { useAttentionWorkspaces } from "./hooks/use-attention-workspaces.js";
import { useLaunchConsents } from "./hooks/use-launch-consents.js";
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
import { Dialog } from "./a11y/primitives.js";

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

type TeamRecoveryCategory = "kept" | "restarted" | "approval" | "failed";

function providerUpdateCategory(outcome: ProviderUpdateOutcome): TeamRecoveryCategory {
  if (outcome.status === "retained") return "kept";
  if (outcome.status === "restarted") return "restarted";
  if (outcome.status === "approval-required") return "approval";
  return "failed";
}

function teamRecoveryCounts(
  recovery: ProviderUpdateRecoveryResult | undefined,
  started: StartGroupRunsResult | undefined,
): Record<TeamRecoveryCategory, number> {
  const categories = new Map<string, TeamRecoveryCategory>();
  for (const outcome of recovery?.outcomes ?? []) {
    categories.set(outcome.memberId, providerUpdateCategory(outcome));
  }
  for (const outcome of started?.outcomes ?? []) {
    if (categories.has(outcome.memberId)) continue;
    categories.set(
      outcome.memberId,
      outcome.status === "already-running"
        ? "kept"
        : outcome.status === "started"
          ? "restarted"
          : outcome.status === "approval-required"
            ? "approval"
            : "failed",
    );
  }
  const counts = { kept: 0, restarted: 0, approval: 0, failed: 0 };
  for (const category of categories.values()) counts[category] += 1;
  return counts;
}

function shouldShowRecoveryResults(
  recovery: ProviderUpdateRecoveryResult | undefined,
  started: StartGroupRunsResult | undefined,
): boolean {
  if (
    started?.outcomes.some((outcome) =>
      ["approval-required", "denied", "failed"].includes(outcome.status),
    ) === true
  ) {
    return true;
  }
  if (recovery === undefined) return false;
  if (recovery.dryRun) {
    return recovery.outcomes.some((outcome) => outcome.status !== "retained");
  }
  return recovery.outcomes.some((outcome) =>
    ["approval-required", "ownership-uncertain", "failed"].includes(outcome.status),
  );
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

function StopAllDialog({
  open,
  groupName,
  activeCount,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  groupName: string;
  activeCount: number;
  busy: boolean;
  onClose(): void;
  onConfirm(): Promise<void>;
}) {
  return (
    <Dialog
      open={open}
      labelledBy="stop-all-title"
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnBackdrop
    >
      <form
        className="confirmation-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          void onConfirm().catch(() => undefined);
        }}
      >
        <h2 id="stop-all-title">Stop all agents?</h2>
        <p>
          This stops {activeCount} active {activeCount === 1 ? "agent" : "agents"} in {groupName}
          and closes their terminal panes.
        </p>
        <div className="confirmation-actions">
          <button type="button" className="compact-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="compact-button danger-button" disabled={busy}>
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
            Stop all
          </button>
        </div>
      </form>
    </Dialog>
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
  const [roleSettingsOpen, setRoleSettingsOpen] = useState(false);
  const [addAgentGroupId, setAddAgentGroupId] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [actionError, setActionError] = useState<PortalError>();
  const [startAllResult, setStartAllResult] = useState<StartGroupRunsResult>();
  const [recoveryResult, setRecoveryResult] = useState<ProviderUpdateRecoveryResult>();
  const [startingAllGroupId, setStartingAllGroupId] = useState<string>();
  const [stoppingAllGroupId, setStoppingAllGroupId] = useState<string>();
  const [confirmStopAllGroupId, setConfirmStopAllGroupId] = useState<string>();
  const [dismissedRestartAdvisory, setDismissedRestartAdvisory] = useState<string>();
  const [recoveringGroupId, setRecoveringGroupId] = useState<string>();
  const [approvingStartAllGroupId, setApprovingStartAllGroupId] = useState<string>();
  const [focusSelectedGroupAfterDelete, setFocusSelectedGroupAfterDelete] = useState(false);
  const [focusedTerminalGroupId, setFocusedTerminalGroupId] = useState<string>();
  const [terminalConnectionRevision, setTerminalConnectionRevision] = useState(0);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [dismissedAttentionItemIds, setDismissedAttentionItemIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [attentionDismissalsReady, setAttentionDismissalsReady] = useState(false);
  const [attentionSubscriptions, setAttentionSubscriptions] =
    useState<AttentionSubscriptionsSnapshot>();
  const [attentionSubscriptionsReady, setAttentionSubscriptionsReady] = useState(false);
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
  const runningCount = memberStatusViews.filter(
    ({ key, run }) => run?.status === "running" && key !== "updating",
  ).length;
  const startingCount = memberStatusViews.filter(
    ({ key }) => key === "starting" || key === "updating",
  ).length;
  const workingCount = memberStatusViews.filter(({ key }) => key === "working").length;
  const hasStartableMembers = memberStatusViews.some(
    ({ run }) => run === undefined || run.status === "stopped" || run.status === "failed",
  );
  const activeRunCount = runs.filter((run) => ["starting", "running"].includes(run.status)).length;
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
  const launchConsents = useLaunchConsents(
    client,
    snapshot === undefined ? undefined : `${snapshot.instanceId}:${snapshot.daemonEpoch}`,
    snapshot?.sequence,
  );
  useEffect(() => {
    let active = true;
    setAttentionDismissalsReady(false);
    void client.listAttentionDismissals().then(
      ({ dismissals }) => {
        if (!active) return;
        setDismissedAttentionItemIds(new Set(dismissals.map(({ itemId }) => itemId)));
        setAttentionDismissalsReady(true);
      },
      (cause: unknown) => {
        if (!active) return;
        setActionError(toPortalError(cause, "Unable to load Attention dismissals"));
        setAttentionDismissalsReady(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  useEffect(() => {
    let active = true;
    setAttentionSubscriptionsReady(false);
    void client.listAttentionSubscriptions().then(
      (subscriptions) => {
        if (!active) return;
        setAttentionSubscriptions(subscriptions);
        setAttentionSubscriptionsReady(true);
      },
      (cause: unknown) => {
        if (!active) return;
        setActionError(toPortalError(cause, "Unable to load Attention subscriptions"));
        setAttentionSubscriptionsReady(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  const attentionItems = useMemo(() => {
    if (
      snapshot === undefined ||
      !attentionDismissalsReady ||
      attentionSubscriptions === undefined
    ) {
      return [];
    }
    const candidates = deriveAttentionItems(snapshot, {
      workspaces: attentionWorkspaces.workspaces,
      unreadCounts,
      launchConsents: launchConsents.latestRequests,
    });
    return filterAttentionItemsBySubscriptions(candidates, attentionSubscriptions).filter(
      (item) => !dismissedAttentionItemIds.has(item.id),
    );
  }, [
    attentionDismissalsReady,
    attentionWorkspaces.workspaces,
    attentionSubscriptions,
    dismissedAttentionItemIds,
    launchConsents.latestRequests,
    snapshot,
    unreadCounts,
  ]);
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
      snapshot !== undefined &&
      attentionDismissalsReady &&
      attentionSubscriptionsReady &&
      attentionSubscriptions !== undefined &&
      attentionWorkspaces.ready &&
      attentionWorkspaces.errors.size === 0 &&
      !launchConsents.loading &&
      launchConsents.error === undefined,
    hydrationKey:
      snapshot === undefined ? undefined : `${snapshot.instanceId}:${snapshot.daemonEpoch}`,
    route,
    visibleTerminalRunIds,
    preferences: {
      ...preferences.notifications,
    },
    navigate,
  });

  const dismissAttentionItems = async (itemIds: readonly string[]): Promise<boolean> => {
    try {
      const result = await client.dismissAttentionItems({ itemIds: [...itemIds] });
      setDismissedAttentionItemIds(new Set(result.dismissals.map(({ itemId }) => itemId)));
      return true;
    } catch (cause) {
      setActionError(toPortalError(cause, "Unable to persist Attention dismissal"));
      return false;
    }
  };

  const replaceMemberAttentionSubscriptions = (
    memberSubscriptions: AttentionSubscriptionsSnapshot["members"][number],
  ) => {
    setAttentionSubscriptions((current) => {
      if (current === undefined) return current;
      const members = current.members.filter(
        (member) =>
          member.groupId !== memberSubscriptions.groupId ||
          member.memberId !== memberSubscriptions.memberId,
      );
      return { ...current, members: [...members, memberSubscriptions] };
    });
  };
  const setMemberAttentionSubscription = async (
    groupId: string,
    memberId: string,
    eventType: Parameters<PortalClient["setAttentionSubscription"]>[2],
    enabled: boolean,
  ) => {
    const updated = await client.setAttentionSubscription(groupId, memberId, eventType, {
      enabled,
    });
    replaceMemberAttentionSubscriptions(updated);
  };
  const resetMemberAttentionSubscriptions = async (groupId: string, memberId: string) => {
    const updated = await client.resetAttentionSubscriptions(groupId, memberId);
    replaceMemberAttentionSubscriptions(updated);
  };

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
      setActionError(toPortalError(cause, "The operation failed"));
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
    setRecoveryResult((current) => (current?.groupId === groupId ? undefined : current));
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

  const launchConsentPath = (request: CustomLaunchConsentRequest) =>
    `${groupRoute(request.groupId, "terminals")}#launch-consent-${encodeURIComponent(request.id)}`;
  const startRun = async (groupId: string, agentId: string) => {
    let request: CustomLaunchConsentRequest | undefined;
    await runAction(`${groupId}:${agentId}`, async () => {
      const result = await client.startRun(groupId, agentId);
      if (result.status === "approval-required" || result.status === "denied") {
        request = result.request;
      }
    });
    await launchConsents.reload();
    if (request !== undefined) {
      setSelectedGroup(groupId, "terminals");
      navigate(launchConsentPath(request));
    }
  };
  const stopRun = (groupId: string, agentId: string) =>
    runAction(`${groupId}:${agentId}`, () => client.stopRun(groupId, agentId));
  const stopAll = async (groupId: string) => {
    setStoppingAllGroupId(groupId);
    try {
      await runAction(`${groupId}:stop-all`, () => client.stopAllRuns(groupId));
      setConfirmStopAllGroupId(undefined);
    } finally {
      setStoppingAllGroupId((current) => (current === groupId ? undefined : current));
    }
  };
  const recoverAgent = (groupId: string, agentId: string, forceIndeterminate: boolean) =>
    runAction(`${groupId}:${agentId}:recover`, () =>
      client.recoverAgentRun(groupId, agentId, { dryRun: false, forceIndeterminate }),
    );
  const recoverGroup = async (groupId: string, dryRun: boolean) => {
    setRecoveringGroupId(groupId);
    setStartAllResult(undefined);
    try {
      await runAction(`${groupId}:recover`, async () => {
        setRecoveryResult(
          await client.recoverGroupRuns(groupId, { dryRun, forceIndeterminate: false }),
        );
      });
      await launchConsents.reload();
    } finally {
      setRecoveringGroupId((current) => (current === groupId ? undefined : current));
    }
  };
  const startAll = (groupId: string): Promise<void> => {
    const existing = startAllInFlight.current.get(groupId);
    if (existing !== undefined) return existing;
    const idempotencyKey = crypto.randomUUID();
    setStartingAllGroupId(groupId);
    setRecoveryResult(undefined);
    setStartAllResult(undefined);
    const operation = runAction(`${groupId}:start-all`, async () => {
      setRecoveryResult(
        await client.recoverGroupRuns(groupId, {
          dryRun: false,
          forceIndeterminate: false,
        }),
      );
      setStartAllResult(await client.startAllRuns(groupId, idempotencyKey));
    }).finally(() => {
      startAllInFlight.current.delete(groupId);
      setStartingAllGroupId((current) => (current === groupId ? undefined : current));
    });
    startAllInFlight.current.set(groupId, operation);
    return operation;
  };
  const approveLaunchConsent = async (request: CustomLaunchConsentRequest) => {
    try {
      await client.approveLaunchConsent(request.id, {
        expectedSubjectDigest: request.subjectDigest,
        configRevision: request.configRevision,
      });
      const member = snapshot?.memberships.find(
        (candidate) =>
          candidate.groupId === request.groupId && candidate.memberId === request.memberId,
      );
      const update =
        member === undefined
          ? undefined
          : memberStatusView(snapshot?.agentStatuses, snapshot?.runs ?? [], member).run
              ?.providerUpdate;
      if (update?.state === "completed" && update.outcome === "approval-required") {
        await client.recoverAgentRun(request.groupId, request.agentId, {
          dryRun: false,
          forceIndeterminate: false,
        });
      } else {
        await client.startRun(request.groupId, request.agentId);
      }
    } finally {
      await Promise.all([refresh(), launchConsents.reload()]);
    }
  };
  const cancelLaunchConsent = async (request: CustomLaunchConsentRequest) => {
    try {
      await client.cancelLaunchConsent(request.id, {
        expectedSubjectDigest: request.subjectDigest,
        configRevision: request.configRevision,
      });
    } finally {
      await Promise.all([refresh(), launchConsents.reload()]);
    }
  };
  const approveStartAll = async (groupId: string, requests: CustomLaunchConsentRequest[]) => {
    setApprovingStartAllGroupId(groupId);
    setActionError(undefined);
    try {
      for (const request of requests) {
        await client.approveLaunchConsent(request.id, {
          expectedSubjectDigest: request.subjectDigest,
          configRevision: request.configRevision,
        });
      }
      await launchConsents.reload();
      await startAll(groupId);
    } catch (cause) {
      setActionError(toPortalError(cause, "Unable to approve all custom launchers"));
      await launchConsents.reload();
    } finally {
      setApprovingStartAllGroupId(undefined);
    }
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
        <div className="loading-state error-state">
          <strong>
            {errorSource === "config"
              ? "Repository configuration unavailable"
              : "Portal state unavailable"}
          </strong>
          {error !== undefined && <ErrorNotice error={error} className="portal-load-error" />}
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

  const startAllPendingRequests = [
    ...new Map([
      ...(startAllResult?.outcomes ?? []).flatMap((outcome) =>
        outcome.status === "approval-required" && outcome.request !== undefined
          ? [[outcome.request.id, outcome.request] as const]
          : [],
      ),
      ...(recoveryResult?.outcomes ?? []).flatMap((outcome) =>
        outcome.status === "approval-required" && outcome.consentRequest !== undefined
          ? [[outcome.consentRequest.id, outcome.consentRequest] as const]
          : [],
      ),
    ]).values(),
  ];
  const displayedRecoveryResult =
    recoveryResult?.groupId === selectedGroupId ? recoveryResult : undefined;
  const displayedStartAllResult =
    startAllResult?.groupId === selectedGroupId ? startAllResult : undefined;
  const recoveryCounts = teamRecoveryCounts(displayedRecoveryResult, displayedStartAllResult);
  const showRecoveryResults = shouldShowRecoveryResults(
    displayedRecoveryResult,
    displayedStartAllResult,
  );
  const selectedRestartAdvisories = (snapshot.restartAdvisories ?? []).filter(
    (advisory) => advisory.groupId === selectedGroupId,
  );
  const restartAdvisorySignature = selectedRestartAdvisories
    .map((advisory) => `${advisory.runId}:${advisory.reasons.join(",")}`)
    .sort()
    .join("|");
  const showRestartAdvisory =
    restartAdvisorySignature.length > 0 && restartAdvisorySignature !== dismissedRestartAdvisory;

  return (
    <PortalShell
      routeLabel={routeLabel}
      density={preferences.density}
      motion={preferences.motion}
      contrast={preferences.contrast}
      notifications={attentionNotifications.toasts}
      onOpenNotification={attentionNotifications.openToast}
      onDismissNotification={attentionNotifications.dismissToast}
      onPauseNotification={attentionNotifications.pauseToast}
      onResumeNotification={attentionNotifications.resumeToast}
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
            onReorderAgents={reorderAgents}
            onReorderGroups={reorderGroups}
            onReparentAgent={reparentAgent}
            onRemoveAgent={removeAgent}
            onStartRun={startRun}
            onStopRun={stopRun}
            onOpenConsole={() => setConsoleOpen(true)}
            onOpenCommandPalette={() => setPaletteOpen(true)}
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
                  aria-label={`${members.length} agents, ${runningCount} live terminals, ${workingCount} working${startingCount > 0 ? `, ${startingCount} starting or recovering` : ""}`}
                >
                  <span className="group-status-agents" title="Configured agents">
                    <Bot aria-hidden="true" size={12} />
                    {members.length} agents
                  </span>
                  <span
                    className={`group-status-live${runningCount === 0 ? " group-status-empty" : ""}`}
                    title="Live terminals"
                  >
                    <RadioTower aria-hidden="true" size={12} />
                    {runningCount} live
                  </span>
                  <span
                    className={`group-status-working${workingCount === 0 ? " group-status-empty" : ""}`}
                    title="Agents currently working"
                  >
                    <Activity aria-hidden="true" size={12} />
                    {workingCount} working
                  </span>
                  {startingCount > 0 && (
                    <span className="group-status-starting" title="Agents starting or recovering">
                      <LoaderCircle className="spin" aria-hidden="true" size={12} />
                      {startingCount} starting
                    </span>
                  )}
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
          {route.kind === "group" && selectedGroup !== undefined && (
            <button
              type="button"
              className="compact-button header-icon-button add-agent-button"
              aria-label={`Add agent to ${selectedGroup.name}`}
              title={`Add agent to ${selectedGroup.name}`}
              onClick={() => setAddAgentGroupId(selectedGroup.id)}
            >
              <UserPlus aria-hidden="true" size={15} />
            </button>
          )}
          {route.kind === "group" && selectedGroup !== undefined && (
            <button
              type="button"
              className="compact-button header-icon-button recovery-check-button"
              aria-label={`Check setup and restart needs for ${selectedGroup.name}`}
              title="Check whether running agents need a restart for updated prompts, hooks, MCP, or provider tools. Preview only; makes no changes."
              disabled={recoveringGroupId === selectedGroup.id || members.length === 0}
              onClick={() => void recoverGroup(selectedGroup.id, true).catch(() => undefined)}
            >
              {recoveringGroupId === selectedGroup.id ? (
                <RefreshCw className="spin" aria-hidden="true" size={15} />
              ) : (
                <ScanSearch aria-hidden="true" size={15} />
              )}
            </button>
          )}
          {route.kind === "group" && selectedGroup !== undefined && (
            <button
              type="button"
              className="compact-button header-icon-button start-all-button"
              aria-label={`Start all non-running agents in ${selectedGroup.name}`}
              title={
                hasStartableMembers
                  ? `Start all non-running agents in ${selectedGroup.name}`
                  : `All agents are active in ${selectedGroup.name}`
              }
              disabled={startingAllGroupId === selectedGroup.id || !hasStartableMembers}
              onClick={() => void startAll(selectedGroup.id).catch(() => undefined)}
            >
              {startingAllGroupId === selectedGroup.id ? (
                <RefreshCw className="spin" aria-hidden="true" size={15} />
              ) : (
                <Play aria-hidden="true" size={15} />
              )}
            </button>
          )}
          {route.kind === "group" && selectedGroup !== undefined && (
            <button
              type="button"
              className="compact-button header-icon-button stop-all-button"
              aria-label={`Stop all active agents in ${selectedGroup.name}`}
              title={`Stop all active agents in ${selectedGroup.name} and close their terminals`}
              disabled={stoppingAllGroupId === selectedGroup.id || activeRunCount === 0}
              onClick={() => setConfirmStopAllGroupId(selectedGroup.id)}
            >
              {stoppingAllGroupId === selectedGroup.id ? (
                <LoaderCircle className="spin" aria-hidden="true" size={15} />
              ) : (
                <Square aria-hidden="true" size={14} />
              )}
            </button>
          )}
          <span className={`event-status event-${eventStatus}`} title="Domain event connection">
            <Cable aria-hidden="true" size={14} />
            {eventStatus}
          </span>
        </div>
      </header>
      {actionError !== undefined && (
        <ErrorNotice
          className="action-banner"
          error={actionError}
          onDismiss={() => setActionError(undefined)}
        />
      )}
      {showRestartAdvisory && selectedGroup !== undefined && (
        <div className="restart-advisory-banner" role="status">
          <RefreshCw aria-hidden="true" size={15} />
          <span>
            Configuration or provider setup changed. {selectedRestartAdvisories.length} active
            {selectedRestartAdvisories.length === 1 ? " agent may" : " agents may"} need a restart.
          </span>
          <div className="restart-advisory-actions">
            <button
              type="button"
              className="compact-button"
              onClick={() => setConfirmStopAllGroupId(selectedGroup.id)}
            >
              Stop all
            </button>
            <button
              type="button"
              className="compact-button"
              onClick={() => setDismissedRestartAdvisory(restartAdvisorySignature)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {showRecoveryResults && (
        <TeamRecoveryResults
          recoveryResult={displayedRecoveryResult}
          startAllResult={displayedStartAllResult}
          counts={recoveryCounts}
          agentNames={new Map(members.map((member) => [member.memberId, member.alias]))}
          pendingApprovalCount={startAllPendingRequests.length}
          recovering={recoveringGroupId === displayedRecoveryResult?.groupId}
          approving={approvingStartAllGroupId === selectedGroupId}
          onRecover={() => {
            if (displayedRecoveryResult !== undefined) {
              void recoverGroup(displayedRecoveryResult.groupId, false).catch(() => undefined);
            }
          }}
          onApproveAndRetry={() => {
            if (selectedGroupId !== undefined) {
              void approveStartAll(selectedGroupId, startAllPendingRequests);
            }
          }}
          onReview={(outcome) => {
            if (outcome.request !== undefined) navigate(launchConsentPath(outcome.request));
          }}
          onDismiss={() => {
            setStartAllResult(undefined);
            setRecoveryResult(undefined);
          }}
        />
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
                onApproveLaunchConsent={approveLaunchConsent}
                onDismissAttentionItems={dismissAttentionItems}
                onOpenRoleSettings={() => setRoleSettingsOpen(true)}
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
                  attentionSubscriptions={attentionSubscriptions?.members ?? []}
                  launchConsents={launchConsents.latestRequests.filter(
                    (request) => request.groupId === selectedGroup.id,
                  )}
                  launchConsentsLoading={launchConsents.loading}
                  launchConsentsError={
                    launchConsents.error === undefined ? undefined : (
                      <div className="launch-consent-load-error">
                        <ErrorNotice error={launchConsents.error} />
                        <button type="button" onClick={() => void launchConsents.reload()}>
                          <RefreshCw aria-hidden="true" size={15} />
                          Retry
                        </button>
                      </div>
                    )
                  }
                  onApproveLaunchConsent={approveLaunchConsent}
                  onCancelLaunchConsent={cancelLaunchConsent}
                  onRecoverAgent={recoverAgent}
                  onSetAttentionSubscription={setMemberAttentionSubscription}
                  onResetAttentionSubscriptions={resetMemberAttentionSubscriptions}
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
                  onApproveLaunchConsent={approveLaunchConsent}
                  onDismissAttentionItems={dismissAttentionItems}
                  onOpenRoleSettings={() => setRoleSettingsOpen(true)}
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
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onClose={() => setMobileNavigationOpen(false)}
      />
      {roleSettingsOpen && (
        <RoleSettingsDialog
          roles={config.roles}
          onClose={() => setRoleSettingsOpen(false)}
          onUpdate={updateRolePresentation}
        />
      )}
      {addAgentGroupId !== undefined && (
        <AddAgentDialog
          group={snapshot.groups.find((group) => group.id === addAgentGroupId)!}
          config={config}
          onAdd={addAgent}
          onClose={() => setAddAgentGroupId(undefined)}
        />
      )}
      {selectedGroup !== undefined && (
        <StopAllDialog
          open={confirmStopAllGroupId === selectedGroup.id}
          groupName={selectedGroup.name}
          activeCount={activeRunCount}
          busy={stoppingAllGroupId === selectedGroup.id}
          onClose={() => setConfirmStopAllGroupId(undefined)}
          onConfirm={() => stopAll(selectedGroup.id)}
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
