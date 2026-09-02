import type {
  AgentKind,
  AgentRun,
  AgentStatusSummary,
  GroupMembership,
  NanasaConfig,
  RoleDefinition,
  TerminalEndpointState,
} from "@nanasa/contracts";
import {
  BellOff,
  BellRing,
  CircleAlert,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Monitor,
  Pin,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import type { PortalClient } from "../api.js";
import { copyToClipboard } from "../copy-to-clipboard.js";
import {
  type TerminalColumnsPreference,
  usePortalPreferences,
} from "../hooks/use-portal-preferences.js";
import { useTerminalEndpoint } from "../hooks/use-terminal-endpoint.js";
import { memberStatusView } from "../member-status.js";
import { TerminalConsole } from "../terminal/terminal-console.js";
import { RoleIdentity, roleColorClass } from "./role-identity.js";

const endpointLabels: Record<Exclude<TerminalEndpointState, "ready">, string> = {
  starting: "Terminal starting",
  unavailable: "Terminal unavailable",
  stopped: "Terminal stopped",
};

function TerminalPane({
  client,
  run,
  alias,
  memberId,
  kind,
  role,
  connectionRevision,
  visible,
  theme,
  completionNotificationsEnabled,
  pinned,
  focused,
  statusKey,
  statusLabel,
  onToggleCompletionNotifications,
  onTogglePinned,
  onToggleFocus,
}: {
  client: PortalClient;
  run: AgentRun;
  alias: string;
  memberId: string;
  kind: AgentKind | undefined;
  role: RoleDefinition | undefined;
  connectionRevision: number;
  visible: boolean;
  theme: "light" | "dark";
  completionNotificationsEnabled: boolean;
  pinned: boolean;
  focused: boolean;
  statusKey: string;
  statusLabel: string;
  onToggleCompletionNotifications(): void;
  onTogglePinned(): void;
  onToggleFocus(): void;
}) {
  const runRevision = `${run.generation}:${run.status}:${run.terminal?.paneId ?? "pending"}:${connectionRevision}`;
  const { status, loading, error, retry } = useTerminalEndpoint(client, run.id, runRevision);
  const endpointState = status?.state;
  const detail = status?.error?.message ?? error;
  const stateLabel =
    endpointState === undefined || endpointState === "ready"
      ? "Loading terminal"
      : endpointLabels[endpointState];
  const identity: ReactNode = (
    <>
      <span
        className={`status-dot status-${statusKey}`}
        title={statusLabel}
        aria-label={`${statusLabel} agent status`}
      />
      <span
        className={`connection-dot connection-${endpointState ?? "starting"}`}
        aria-hidden="true"
      />
      <strong>{alias}</strong>
      {kind !== undefined && (
        <span className="terminal-agent-kind" aria-label={`Agent kind ${kind}`} title="Agent kind">
          {kind}
        </span>
      )}
      <RoleIdentity role={role} compact />
    </>
  );
  const memberIdentity = (
    <button
      type="button"
      className="terminal-member-id"
      aria-label={`Copy agent name ${memberId}`}
      title={`Copy ${memberId}`}
      onClick={() => void copyToClipboard(memberId).catch(() => undefined)}
    >
      {memberId}
    </button>
  );
  const paneActions = (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={`${completionNotificationsEnabled ? "Disable" : "Enable"} completion notifications for ${alias}`}
        title={`${completionNotificationsEnabled ? "Disable" : "Enable"} completion notifications for ${alias}`}
        aria-pressed={completionNotificationsEnabled}
        onClick={onToggleCompletionNotifications}
      >
        {completionNotificationsEnabled ? (
          <BellRing aria-hidden="true" size={12} />
        ) : (
          <BellOff aria-hidden="true" size={12} />
        )}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`${pinned ? "Unpin" : "Pin"} ${alias} terminal`}
        aria-pressed={pinned}
        onClick={onTogglePinned}
      >
        <Pin aria-hidden="true" size={12} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`${focused ? "Show all terminals from" : "Focus"} ${alias} terminal`}
        aria-pressed={focused}
        onClick={onToggleFocus}
      >
        {focused ? (
          <Minimize2 aria-hidden="true" size={12} />
        ) : (
          <Maximize2 aria-hidden="true" size={12} />
        )}
      </button>
    </>
  );

  return (
    <section
      className={`terminal-pane ${status?.state === "ready" ? "terminal-pane-ready" : ""} ${roleColorClass(role)}`}
      aria-label={`${alias} (${memberId}) terminal`}
    >
      {status?.state === "ready" ? (
        <TerminalConsole
          client={client}
          endpoint={status}
          runGeneration={run.generation}
          theme={theme}
          label={`${alias} (${memberId}) terminal console`}
          visible={visible}
          headerIdentity={identity}
          memberIdentity={memberIdentity}
          paneActions={paneActions}
        />
      ) : (
        <>
          <div className="terminal-statusbar">
            {identity}
            <span className="status-separator" aria-hidden="true" />
            <span>{endpointState ?? (loading ? "loading" : "unavailable")}</span>
            <span className="terminal-header-spacer" />
            {memberIdentity}
            <div className="terminal-pane-actions">{paneActions}</div>
          </div>
          <div
            className="terminal-state"
            role={endpointState === "unavailable" || error !== undefined ? "alert" : "status"}
          >
            {loading || endpointState === "starting" ? (
              <LoaderCircle className="spin" aria-hidden="true" size={22} />
            ) : (
              <CircleAlert aria-hidden="true" size={22} />
            )}
            <strong>{stateLabel}</strong>
            {detail !== undefined && <span>{detail}</span>}
            {(endpointState === "unavailable" || error !== undefined) && (
              <button type="button" onClick={retry}>
                <RefreshCw aria-hidden="true" size={15} />
                Retry
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

interface TerminalWorkspaceProps {
  client: PortalClient;
  config?: NanasaConfig;
  members: GroupMembership[];
  roles?: NanasaConfig["roles"];
  runs: AgentRun[];
  agentStatuses?: AgentStatusSummary[];
  connectionRevision?: number;
  activeRunId?: string;
  focusedRunId?: string;
  columns?: TerminalColumnsPreference;
  onSetFocusedRun?(runId: string | undefined): void;
  theme?: "light" | "dark";
}

export function TerminalWorkspace({
  client,
  config,
  members,
  roles = {},
  runs,
  agentStatuses = [],
  connectionRevision = 0,
  activeRunId: requestedActiveRunId,
  focusedRunId: requestedFocusedRunId,
  columns = "auto",
  onSetFocusedRun,
  theme = "dark",
}: TerminalWorkspaceProps) {
  const memberViews = members.map((member) => ({
    member,
    status: memberStatusView(agentStatuses, runs, member),
  }));
  const availableRuns = memberViews
    .map(({ status }) => status.run)
    .filter((run): run is AgentRun => run !== undefined);
  const statusByRunId = new Map(
    memberViews.flatMap(({ status }) =>
      status.run === undefined ? [] : [[status.run.id, status]],
    ),
  );
  const groupId = availableRuns[0]?.groupId;
  const { preferences, updatePreferences } = usePortalPreferences();
  const pinnedRunIds =
    groupId === undefined ? [] : (preferences.pinnedRunIdsByGroup[groupId] ?? []);
  const pinnedSet = new Set(pinnedRunIds);
  const pinnedOrder = new Map(pinnedRunIds.map((runId, index) => [runId, index]));
  const orderedRuns = availableRuns
    .map((run, index) => ({ run, index }))
    .sort(
      (left, right) =>
        Number(pinnedSet.has(right.run.id)) - Number(pinnedSet.has(left.run.id)) ||
        (pinnedOrder.get(left.run.id) ?? Number.MAX_SAFE_INTEGER) -
          (pinnedOrder.get(right.run.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ run }) => run);
  const focusedRunId = availableRuns.some((run) => run.id === requestedFocusedRunId)
    ? requestedFocusedRunId
    : undefined;
  const completionNotificationMemberIds =
    groupId === undefined
      ? []
      : (preferences.completionNotificationMemberIdsByGroup[groupId] ?? []);
  const completionNotificationMemberIdSet = new Set(completionNotificationMemberIds);
  const activeRunId = availableRuns.some((run) => run.id === requestedActiveRunId)
    ? requestedActiveRunId
    : undefined;
  const paneElements = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (activeRunId === undefined || focusedRunId !== undefined) return;
    const frame = requestAnimationFrame(() =>
      paneElements.current.get(activeRunId)?.scrollIntoView?.({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [activeRunId, focusedRunId]);
  useEffect(() => {
    if (focusedRunId === undefined) return;
    const restoreOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onSetFocusedRun?.(undefined);
    };
    document.addEventListener("keydown", restoreOnEscape);
    return () => document.removeEventListener("keydown", restoreOnEscape);
  }, [focusedRunId, onSetFocusedRun]);
  const togglePinned = (runId: string) => {
    if (groupId === undefined) return;
    updatePreferences((current) => {
      const existing = current.pinnedRunIdsByGroup[groupId] ?? [];
      const next = existing.includes(runId)
        ? existing.filter((candidate) => candidate !== runId)
        : [...existing, runId];
      return {
        ...current,
        pinnedRunIdsByGroup: { ...current.pinnedRunIdsByGroup, [groupId]: next },
      };
    });
  };
  const toggleCompletionNotifications = (memberId: string) => {
    if (groupId === undefined) return;
    updatePreferences((current) => {
      const existing = current.completionNotificationMemberIdsByGroup[groupId] ?? [];
      const next = existing.includes(memberId)
        ? existing.filter((candidate) => candidate !== memberId)
        : [...existing, memberId];
      return {
        ...current,
        completionNotificationMemberIdsByGroup: {
          ...current.completionNotificationMemberIdsByGroup,
          [groupId]: next,
        },
      };
    });
  };
  const memberForRun = (run: AgentRun) =>
    members.find((member) => member.groupId === run.groupId && member.memberId === run.memberId);
  const memberAlias = (run: AgentRun) => memberForRun(run)?.alias ?? run.memberId;
  const memberRole = (run: AgentRun) => {
    const roleId = memberForRun(run)?.roleId;
    return roleId === undefined ? undefined : roles[roleId];
  };
  const memberKind = (run: AgentRun) => {
    const member = memberForRun(run);
    const integrationId =
      member === undefined
        ? undefined
        : config?.groups[run.groupId]?.agents[member.id]?.integrationId;
    return integrationId === undefined ? undefined : config?.integrations[integrationId]?.kind;
  };

  if (availableRuns.length === 0) {
    return (
      <div className="empty-state terminal-empty">
        <Monitor aria-hidden="true" size={28} />
        <h2>No active terminals</h2>
        <p>Start an agent from the tree to open its tmux terminal.</p>
      </div>
    );
  }

  return (
    <div className="terminal-workspace">
      <div
        className={`terminal-layout terminal-layout-${focusedRunId === undefined ? columns : "focused"}`}
      >
        {orderedRuns.map((run) => {
          const visible = focusedRunId === undefined || run.id === focusedRunId;
          const status = statusByRunId.get(run.id);
          return (
            <div
              className={`terminal-pane-slot${run.id === activeRunId ? " terminal-pane-slot-active" : ""}`}
              key={run.id}
              hidden={!visible}
              ref={(element) => {
                if (element === null) paneElements.current.delete(run.id);
                else paneElements.current.set(run.id, element);
              }}
            >
              <TerminalPane
                client={client}
                run={run}
                alias={memberAlias(run)}
                memberId={run.memberId}
                kind={memberKind(run)}
                role={memberRole(run)}
                connectionRevision={connectionRevision}
                visible={visible}
                theme={theme}
                completionNotificationsEnabled={completionNotificationMemberIdSet.has(run.memberId)}
                pinned={pinnedSet.has(run.id)}
                focused={focusedRunId === run.id}
                statusKey={status?.key ?? "unknown"}
                statusLabel={status?.label ?? "Unknown"}
                onToggleCompletionNotifications={() => toggleCompletionNotifications(run.memberId)}
                onTogglePinned={() => togglePinned(run.id)}
                onToggleFocus={() =>
                  onSetFocusedRun?.(focusedRunId === run.id ? undefined : run.id)
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
