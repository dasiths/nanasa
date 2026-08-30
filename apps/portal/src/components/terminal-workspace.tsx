import type {
  AgentKind,
  AgentRun,
  AgentStatusSummary,
  GroupMembership,
  NanasaConfig,
  RoleDefinition,
  TerminalEndpointState,
} from "@nanasa/contracts";
import { CircleAlert, Copy, Grid2X2, LoaderCircle, Monitor, RefreshCw, Rows3 } from "lucide-react";
import { useState } from "react";

import type { PortalClient } from "../api.js";
import { copyToClipboard } from "../copy-to-clipboard.js";
import { usePortalPreferences } from "../hooks/use-portal-preferences.js";
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
  theme,
}: {
  client: PortalClient;
  run: AgentRun;
  alias: string;
  memberId: string;
  kind: AgentKind | undefined;
  role: RoleDefinition | undefined;
  connectionRevision: number;
  suspended: boolean;
  theme: "light" | "dark";
}) {
  const runRevision = `${run.generation}:${run.status}:${run.terminal?.paneId ?? "pending"}:${connectionRevision}`;
  const { status, loading, error, retry } = useTerminalEndpoint(client, run.id, runRevision);
  const endpointState = status?.state;
  const detail = status?.error?.message ?? error;
  const stateLabel =
    endpointState === undefined || endpointState === "ready"
      ? "Loading terminal"
      : endpointLabels[endpointState];

  return (
    <section
      className={`terminal-pane ${roleColorClass(role)}`}
      aria-label={`${alias} (${memberId}) terminal`}
    >
      <div className="terminal-statusbar">
        <span
          className={`connection-dot connection-${endpointState ?? "starting"}`}
          aria-hidden="true"
        />
        <strong>{alias}</strong>
        {kind !== undefined && (
          <span
            className="terminal-agent-kind"
            aria-label={`Agent kind ${kind}`}
            title="Agent kind"
          >
            {kind}
          </span>
        )}
        <RoleIdentity role={role} compact />
        <span className="status-separator" aria-hidden="true" />
        <span>{endpointState ?? (loading ? "loading" : "unavailable")}</span>
        <div className="terminal-title-tools">
          <code
            className="terminal-member-id"
            aria-label={`Member ID ${memberId}`}
            title={memberId}
          >
            {memberId}
          </code>
          <button
            type="button"
            className="icon-button terminal-title-copy"
            aria-label={`Copy member ID ${memberId}`}
            title={`Copy ${memberId}`}
            onClick={() => void copyToClipboard(memberId).catch(() => undefined)}
          >
            <Copy aria-hidden="true" size={12} />
          </button>
        </div>
      </div>
      {status?.state === "ready" ? (
        <TerminalConsole
          client={client}
          endpoint={status}
          runGeneration={run.generation}
          theme={theme}
          label={`${alias} (${memberId}) terminal console`}
          suspended={suspended}
        />
      ) : (
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
  const availableRuns = members
    .map(
      (member) =>
        runs
          .filter((run) => run.memberId === member.memberId)
          .sort((left, right) => right.generation - left.generation)[0],
    )
    .filter((run): run is AgentRun => run !== undefined);
  const {
    preferences: { terminalLayout: layout },
    setTerminalLayout,
  } = usePortalPreferences();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const selectedCandidate = requestedActiveRunId ?? selectedRunId;
  const activeRunId = availableRuns.some((run) => run.id === selectedCandidate)
    ? selectedCandidate
    : availableRuns[0]?.id;
  const selectRun = (runId: string) => {
    setSelectedRunId(runId);
    onSelectRun?.(runId);
  };
  const memberAlias = (run: AgentRun) =>
    members.find((member) => member.memberId === run.memberId)?.alias ?? run.memberId;
  const memberRole = (run: AgentRun) => {
    const roleId = members.find((member) => member.memberId === run.memberId)?.roleId;
    return roleId === undefined ? undefined : roles[roleId];
  };
  const memberKind = (run: AgentRun) => {
    const member = members.find((candidate) => candidate.memberId === run.memberId);
    const integrationId =
      member === undefined
        ? undefined
        : config?.groups[run.groupId]?.agents[member.id]?.integrationId;
    return integrationId === undefined ? undefined : config?.integrations[integrationId]?.kind;
  };
  const displayStatus = (run: AgentRun) =>
    agentStatuses.find(
      (status) => status.groupId === run.groupId && status.memberId === run.memberId,
    )?.state ?? run.status;

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
          {availableRuns.map((run) => (
            <div className="terminal-tab-item" role="presentation" key={run.id}>
              <button
                type="button"
                className={`terminal-tab-select ${roleColorClass(memberRole(run))}`}
                role="tab"
                aria-selected={run.id === activeRunId}
                onClick={() => selectRun(run.id)}
              >
                <span
                  className={`status-dot status-${displayStatus(run)}`}
                  title={displayStatus(run).replaceAll("_", " ")}
                  aria-label={`${displayStatus(run).replaceAll("_", " ")} agent status`}
                />
                <span>{memberAlias(run)}</span>
                <RoleIdentity role={memberRole(run)} compact />
              </button>
            </div>
          ))}
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
      </div>
      <div className={`terminal-layout terminal-layout-${layout}`}>
        {availableRuns.map((run) => (
          <div
            className="terminal-pane-slot"
            key={run.id}
            hidden={layout === "tabs" && run.id !== activeRunId}
          >
            <TerminalPane
              client={client}
              run={run}
              alias={memberAlias(run)}
              memberId={run.memberId}
              kind={memberKind(run)}
              role={memberRole(run)}
              connectionRevision={connectionRevision}
              suspended={suspended}
              theme={theme}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
