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
  Grid2X2,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Monitor,
  Pin,
  RefreshCw,
  Rows3,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

import type { PortalClient } from "../api.js";
import { copyToClipboard } from "../copy-to-clipboard.js";
import { usePortalPreferences } from "../hooks/use-portal-preferences.js";
import { memberStatusView } from "../member-status.js";
import { useTerminalEndpoint } from "../hooks/use-terminal-endpoint.js";
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
  suspended,
  visible,
  theme,
  completionNotificationsEnabled,
  pinned,
  maximized,
  onToggleCompletionNotifications,
  onTogglePinned,
  onToggleMaximized,
}: {
  client: PortalClient;
  run: AgentRun;
  alias: string;
  memberId: string;
  kind: AgentKind | undefined;
  role: RoleDefinition | undefined;
  connectionRevision: number;
  suspended: boolean;
  visible: boolean;
  theme: "light" | "dark";
  completionNotificationsEnabled: boolean;
  pinned: boolean;
  maximized: boolean;
  onToggleCompletionNotifications(): void;
  onTogglePinned(): void;
  onToggleMaximized(): void;
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
        aria-label={`${maximized ? "Restore" : "Maximize"} ${alias} terminal`}
        aria-pressed={maximized}
        onClick={onToggleMaximized}
      >
        {maximized ? (
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
          suspended={suspended}
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
      {suspended && (
        <div className="terminal-suspension-overlay" role="status">
          <LoaderCircle className="spin" aria-hidden="true" size={22} />
          <strong>Routing message</strong>
        </div>
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
  suspended?: boolean;
  activeRunId?: string;
  onSelectRun?(runId: string): void;
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
  suspended = false,
  activeRunId: requestedActiveRunId,
  onSelectRun,
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
  const { preferences, setTerminalLayout, updatePreferences } = usePortalPreferences();
  const layout = preferences.terminalLayout;
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
  const requestedMaximizedRunId =
    groupId === undefined ? undefined : preferences.maximizedRunByGroup[groupId];
  const maximizedRunId = availableRuns.some((run) => run.id === requestedMaximizedRunId)
    ? requestedMaximizedRunId
    : undefined;
  const splitRatio =
    groupId === undefined ? 50 : (preferences.terminalSplitRatioByGroup[groupId] ?? 50);
  const completionNotificationMemberIds =
    groupId === undefined
      ? []
      : (preferences.completionNotificationMemberIdsByGroup[groupId] ?? []);
  const completionNotificationMemberIdSet = new Set(completionNotificationMemberIds);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const selectedCandidate = requestedActiveRunId ?? selectedRunId;
  const activeRunId = availableRuns.some((run) => run.id === selectedCandidate)
    ? selectedCandidate
    : availableRuns[0]?.id;
  const selectRun = (runId: string) => {
    setSelectedRunId(runId);
    onSelectRun?.(runId);
  };
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
  const toggleMaximized = (runId: string) => {
    if (groupId === undefined) return;
    updatePreferences((current) => {
      const maximizedRunByGroup = { ...current.maximizedRunByGroup };
      if (maximizedRunByGroup[groupId] === runId) delete maximizedRunByGroup[groupId];
      else maximizedRunByGroup[groupId] = runId;
      return { ...current, maximizedRunByGroup };
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
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="Agent terminals">
          {orderedRuns.map((run) => {
            const status = statusByRunId.get(run.id);
            return (
              <div className="terminal-tab-item" role="presentation" key={run.id}>
                <button
                  type="button"
                  className={`terminal-tab-select ${roleColorClass(memberRole(run))}`}
                  role="tab"
                  aria-selected={run.id === activeRunId}
                  onClick={() => selectRun(run.id)}
                >
                  <span
                    className={`status-dot status-${status?.key ?? "unknown"}`}
                    title={status?.label ?? "Unknown"}
                    aria-label={`${status?.label ?? "Unknown"} agent status`}
                  />
                  <span>{memberAlias(run)}</span>
                  <RoleIdentity role={memberRole(run)} compact />
                </button>
              </div>
            );
          })}
        </div>
        <div className="segmented-control" role="group" aria-label="Terminal layout">
          <button
            type="button"
            aria-label="Tabbed terminal layout"
            title="Tabbed terminal layout"
            aria-pressed={layout === "tabs"}
            onClick={() => setTerminalLayout("tabs")}
          >
            <Rows3 aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label="Grid terminal layout"
            title="Grid terminal layout"
            aria-pressed={layout === "grid"}
            onClick={() => setTerminalLayout("grid")}
          >
            <Grid2X2 aria-hidden="true" size={16} />
          </button>
        </div>
        {layout === "grid" && availableRuns.length > 1 && groupId !== undefined && (
          <label className="terminal-split-control">
            Split
            <input
              type="range"
              aria-label="Terminal split ratio"
              min="25"
              max="75"
              value={splitRatio}
              onChange={(event) => {
                const ratio = Number(event.target.value);
                updatePreferences((current) => ({
                  ...current,
                  terminalSplitRatioByGroup: {
                    ...current.terminalSplitRatioByGroup,
                    [groupId]: ratio,
                  },
                }));
              }}
            />
            <span>{splitRatio}%</span>
          </label>
        )}
      </div>
      <div
        className={`terminal-layout terminal-layout-${layout}${maximizedRunId === undefined ? "" : " terminal-layout-maximized"}`}
        style={{ "--terminal-first-ratio": `${splitRatio}%` } as CSSProperties}
      >
        {orderedRuns.map((run) => {
          const visible = !(
            (maximizedRunId !== undefined && run.id !== maximizedRunId) ||
            (maximizedRunId === undefined && layout === "tabs" && run.id !== activeRunId)
          );
          return (
            <div className="terminal-pane-slot" key={run.id} hidden={!visible}>
              <TerminalPane
                client={client}
                run={run}
                alias={memberAlias(run)}
                memberId={run.memberId}
                kind={memberKind(run)}
                role={memberRole(run)}
                connectionRevision={connectionRevision}
                suspended={suspended}
                visible={visible}
                theme={theme}
                completionNotificationsEnabled={completionNotificationMemberIdSet.has(run.memberId)}
                pinned={pinnedSet.has(run.id)}
                maximized={maximizedRunId === run.id}
                onToggleCompletionNotifications={() => toggleCompletionNotifications(run.memberId)}
                onTogglePinned={() => togglePinned(run.id)}
                onToggleMaximized={() => toggleMaximized(run.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
