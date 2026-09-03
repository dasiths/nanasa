import type {
  AgentKind,
  AgentRun,
  AgentStatusSummary,
  CustomLaunchConsentRequest,
  GroupMembership,
  NanasaConfig,
  RoleDefinition,
  TerminalEndpointState,
} from "@nanasa/contracts";
import {
  BellOff,
  BellRing,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Monitor,
  Pin,
  RefreshCw,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { PortalClient } from "../api.js";
import { copyToClipboard } from "../copy-to-clipboard.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
import {
  type TerminalColumnsPreference,
  usePortalPreferences,
} from "../hooks/use-portal-preferences.js";
import { useTerminalEndpoint } from "../hooks/use-terminal-endpoint.js";
import { memberStatusView } from "../member-status.js";
import { TerminalConsole } from "../terminal/terminal-console.js";
import { LaunchConsentPane } from "./launch-consent-pane.js";
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
  restartNoticeDismissed,
  onRecover,
  onDismissRestartNotice,
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
  restartNoticeDismissed: boolean;
  onRecover?(forceIndeterminate: boolean): Promise<void>;
  onDismissRestartNotice(): void;
  onToggleCompletionNotifications(): void;
  onTogglePinned(): void;
  onToggleFocus(): void;
}) {
  const runRevision = `${run.generation}:${run.status}:${run.terminal?.paneId ?? "pending"}:${connectionRevision}`;
  const { status, loading, error, retry } = useTerminalEndpoint(client, run.id, runRevision);
  const endpointState = status?.state;
  const providerUpdate = run.providerUpdate;
  const updateInProgress =
    providerUpdate?.state === "pending" || providerUpdate?.state === "in-progress";
  const updateNeedsHelp =
    providerUpdate?.state === "completed" &&
    (providerUpdate.outcome === "failed" || providerUpdate.outcome === "ownership-uncertain");
  const updateSucceeded =
    providerUpdate?.state === "completed" &&
    providerUpdate.outcome === "restarted" &&
    providerUpdate.replacementRunId === run.id;
  const [showUpdateDetails, setShowUpdateDetails] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState<"check" | "force">();
  const [recoveryError, setRecoveryError] = useState<PortalError>();
  const detail = status?.error?.message;
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
        aria-label={`${completionNotificationsEnabled ? "Disable" : "Enable"} completion alerts for ${alias}`}
        title={`${completionNotificationsEnabled ? "Disable" : "Enable"} completion alerts for ${alias}`}
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

  const recover = async (forceIndeterminate: boolean) => {
    if (onRecover === undefined) return;
    setRecoveryBusy(forceIndeterminate ? "force" : "check");
    setRecoveryError(undefined);
    try {
      await onRecover(forceIndeterminate);
      setConfirmForce(false);
    } catch (cause) {
      setRecoveryError(toPortalError(cause, "Unable to check the agent setup"));
    } finally {
      setRecoveryBusy(undefined);
    }
  };

  if (updateInProgress) {
    return (
      <section className={`terminal-pane ${roleColorClass(role)}`} aria-label={`Updating ${alias}`}>
        <div className="terminal-statusbar">{identity}</div>
        <div className="terminal-state provider-update-state" role="status">
          <LoaderCircle className="spin" aria-hidden="true" size={22} />
          <strong>Updating {alias}</strong>
          <span>Agent tools changed. Nanasa is restarting {alias} with the latest setup.</span>
        </div>
      </section>
    );
  }

  if (updateNeedsHelp && providerUpdate !== undefined) {
    const uncertain = providerUpdate.outcome === "ownership-uncertain";
    return (
      <section
        className={`terminal-pane provider-update-help-pane ${roleColorClass(role)}`}
        aria-label={`${alias} needs help`}
      >
        <div className="terminal-statusbar">{identity}</div>
        <div className="terminal-state provider-update-state" role="alert">
          <CircleAlert aria-hidden="true" size={22} />
          <strong>{alias} needs help</strong>
          <span>
            {uncertain
              ? "Nanasa cannot safely confirm which process belongs to this agent. It will not stop anything automatically."
              : (providerUpdate.safeError?.message ??
                "Nanasa could not restart this agent with the latest setup.")}
          </span>
          <div className="provider-update-actions">
            <button type="button" onClick={() => setShowUpdateDetails((visible) => !visible)}>
              {showUpdateDetails ? "Hide details" : "View details"}
            </button>
            <button
              type="button"
              disabled={recoveryBusy !== undefined || onRecover === undefined}
              onClick={() => void recover(false)}
            >
              <RefreshCw
                className={recoveryBusy === "check" ? "spin" : undefined}
                aria-hidden="true"
                size={15}
              />
              Check again
            </button>
          </div>
          {showUpdateDetails && (
            <div className="provider-update-details">
              <dl>
                <div>
                  <dt>Previous setup ID</dt>
                  <dd>{providerUpdate.previousSnapshotDigest}</dd>
                </div>
                <div>
                  <dt>Current setup ID</dt>
                  <dd>{providerUpdate.currentSnapshotDigest}</dd>
                </div>
                <div>
                  <dt>Run</dt>
                  <dd>{providerUpdate.runId}</dd>
                </div>
                <div>
                  <dt>Generation</dt>
                  <dd>{providerUpdate.generation}</dd>
                </div>
              </dl>
              {uncertain && !confirmForce && (
                <button
                  type="button"
                  className="danger-action"
                  disabled={recoveryBusy !== undefined || onRecover === undefined}
                  onClick={() => setConfirmForce(true)}
                >
                  Stop the old process and restart
                </button>
              )}
              {uncertain && confirmForce && (
                <div
                  className="provider-update-confirmation"
                  role="dialog"
                  aria-label="Restart without verification?"
                  aria-modal="true"
                >
                  <strong>Restart without verification?</strong>
                  <p>
                    Nanasa could not verify the old process. Continuing may stop the wrong process.
                  </p>
                  <div>
                    <button type="button" onClick={() => setConfirmForce(false)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="danger-action"
                      disabled={recoveryBusy !== undefined}
                      onClick={() => void recover(true)}
                    >
                      {recoveryBusy === "force" ? "Restarting..." : "Stop and restart"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {recoveryError !== undefined && (
            <ErrorNotice error={recoveryError} className="terminal-endpoint-error" />
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      className={`terminal-pane ${status?.state === "ready" ? "terminal-pane-ready" : ""} ${roleColorClass(role)}`}
      aria-label={`${alias} (${memberId}) terminal`}
    >
      {status?.state === "ready" ? (
        <>
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
          {updateSucceeded && !restartNoticeDismissed && (
            <aside className="provider-update-success" aria-label={`${alias} restarted`}>
              <CheckCircle2 aria-hidden="true" size={17} />
              <div>
                <strong>{alias} restarted</strong>
                <span>
                  The agent is using the latest setup. Its previous terminal remains in history.
                </span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`Dismiss ${alias} restart notice`}
                onClick={onDismissRestartNotice}
              >
                <X aria-hidden="true" size={14} />
              </button>
            </aside>
          )}
        </>
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
            {...(error === undefined
              ? { role: endpointState === "unavailable" ? "alert" : "status" }
              : {})}
          >
            {loading || endpointState === "starting" ? (
              <LoaderCircle className="spin" aria-hidden="true" size={22} />
            ) : (
              <CircleAlert aria-hidden="true" size={22} />
            )}
            <strong>{stateLabel}</strong>
            {error !== undefined ? (
              <ErrorNotice error={error} className="terminal-endpoint-error" />
            ) : (
              detail !== undefined && <span>{detail}</span>
            )}
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
  launchConsents?: CustomLaunchConsentRequest[];
  launchConsentsLoading?: boolean;
  launchConsentsError?: ReactNode;
  onApproveLaunchConsent?(request: CustomLaunchConsentRequest): Promise<void>;
  onCancelLaunchConsent?(request: CustomLaunchConsentRequest): Promise<void>;
  onRecoverAgent?(groupId: string, agentId: string, forceIndeterminate: boolean): Promise<void>;
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
  launchConsents = [],
  launchConsentsLoading = false,
  launchConsentsError,
  onApproveLaunchConsent = async () => undefined,
  onCancelLaunchConsent = async () => undefined,
  onRecoverAgent,
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
  const activeRunMemberIds = new Set(
    availableRuns
      .filter((run) => ["starting", "running", "stopping"].includes(run.status))
      .map((run) => run.memberId),
  );
  const consentViews = launchConsents.flatMap((request) => {
    if (request.state === "approved" || activeRunMemberIds.has(request.memberId)) return [];
    const member = members.find(
      (candidate) =>
        candidate.groupId === request.groupId && candidate.memberId === request.memberId,
    );
    const update = memberViews.find(({ member: candidate }) => candidate.id === member?.id)?.status
      .run?.providerUpdate;
    return member === undefined
      ? []
      : [
          {
            request,
            member,
            providerUpdate: update?.state === "completed" && update.outcome === "approval-required",
          },
        ];
  });
  const consentMemberIds = new Set(consentViews.map(({ member }) => member.memberId));
  const displayedRuns = availableRuns.filter((run) => !consentMemberIds.has(run.memberId));
  const statusByRunId = new Map(
    memberViews.flatMap(({ status }) =>
      status.run === undefined ? [] : [[status.run.id, status]],
    ),
  );
  const groupId = displayedRuns[0]?.groupId ?? members[0]?.groupId;
  const { preferences, updatePreferences } = usePortalPreferences();
  const pinnedRunIds =
    groupId === undefined ? [] : (preferences.pinnedRunIdsByGroup[groupId] ?? []);
  const pinnedSet = new Set(pinnedRunIds);
  const pinnedOrder = new Map(pinnedRunIds.map((runId, index) => [runId, index]));
  const orderedRuns = displayedRuns
    .map((run, index) => ({ run, index }))
    .sort(
      (left, right) =>
        Number(pinnedSet.has(right.run.id)) - Number(pinnedSet.has(left.run.id)) ||
        (pinnedOrder.get(left.run.id) ?? Number.MAX_SAFE_INTEGER) -
          (pinnedOrder.get(right.run.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ run }) => run);
  const focusedRunId = displayedRuns.some((run) => run.id === requestedFocusedRunId)
    ? requestedFocusedRunId
    : undefined;
  const completionNotificationMemberIds =
    groupId === undefined
      ? []
      : (preferences.completionNotificationMemberIdsByGroup[groupId] ?? []);
  const completionNotificationMemberIdSet = new Set(completionNotificationMemberIds);
  const dismissedProviderUpdateIdSet = new Set(preferences.dismissedProviderUpdateIds);
  const activeRunId = displayedRuns.some((run) => run.id === requestedActiveRunId)
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
  const agentIdForRun = (run: AgentRun) => {
    const member = memberForRun(run);
    return (
      Object.entries(config?.groups[run.groupId]?.agents ?? {}).find(
        ([agentId, agent]) => agentId === member?.agentProfileId || agent.memberId === run.memberId,
      )?.[0] ?? member?.id
    );
  };

  if (displayedRuns.length === 0 && consentViews.length === 0) {
    return (
      <div className="empty-state terminal-empty">
        {launchConsentsLoading ? (
          <LoaderCircle className="spin" aria-hidden="true" size={28} />
        ) : (
          <Monitor aria-hidden="true" size={28} />
        )}
        <h2>{launchConsentsLoading ? "Loading launch requests" : "No active terminals"}</h2>
        {launchConsentsError ?? <p>Start an agent from the tree to open its tmux terminal.</p>}
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
                restartNoticeDismissed={
                  run.providerUpdate === undefined ||
                  dismissedProviderUpdateIdSet.has(run.providerUpdate.id)
                }
                onRecover={async (forceIndeterminate) => {
                  const agentId = agentIdForRun(run);
                  if (agentId === undefined || onRecoverAgent === undefined) return;
                  await onRecoverAgent(run.groupId, agentId, forceIndeterminate);
                }}
                onToggleCompletionNotifications={() => toggleCompletionNotifications(run.memberId)}
                onDismissRestartNotice={() => {
                  const updateId = run.providerUpdate?.id;
                  if (updateId === undefined) return;
                  updatePreferences((current) => ({
                    ...current,
                    dismissedProviderUpdateIds: [
                      ...new Set([...current.dismissedProviderUpdateIds, updateId]),
                    ].slice(-100),
                  }));
                }}
                onTogglePinned={() => togglePinned(run.id)}
                onToggleFocus={() =>
                  onSetFocusedRun?.(focusedRunId === run.id ? undefined : run.id)
                }
              />
            </div>
          );
        })}
        {consentViews.map(({ request, member, providerUpdate }) => {
          const role = member.roleId === undefined ? undefined : roles[member.roleId];
          return (
            <div className="terminal-pane-slot" key={request.id}>
              <LaunchConsentPane
                request={request}
                member={member}
                role={role}
                providerUpdate={providerUpdate}
                onApprove={onApproveLaunchConsent}
                onCancel={onCancelLaunchConsent}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
