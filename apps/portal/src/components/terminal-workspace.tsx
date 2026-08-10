import type { AgentRun, GroupMembership, TerminalEndpointState } from "@nanasa/contracts";
import { CircleAlert, Grid2X2, LoaderCircle, Monitor, RefreshCw, Rows3 } from "lucide-react";
import { useState } from "react";

import type { PortalClient } from "../api.js";
import { usePortalPreferences } from "../hooks/use-portal-preferences.js";
import { useTerminalEndpoint } from "../hooks/use-terminal-endpoint.js";

const endpointLabels: Record<Exclude<TerminalEndpointState, "ready">, string> = {
  starting: "Terminal starting",
  backoff: "Terminal retrying",
  unavailable: "Terminal unavailable",
  stopped: "Terminal stopped",
};

function TerminalPane({
  client,
  run,
  alias,
  memberId,
  connectionRevision,
  suspended,
}: {
  client: PortalClient;
  run: AgentRun;
  alias: string;
  memberId: string;
  connectionRevision: number;
  suspended: boolean;
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
    <section className="terminal-pane" aria-label={`${alias} (${memberId}) terminal`}>
      <div className="terminal-statusbar">
        <span
          className={`connection-dot connection-${endpointState ?? "starting"}`}
          aria-hidden="true"
        />
        <strong>{alias}</strong>
        <code title={memberId}>{memberId}</code>
        <span className="status-separator" aria-hidden="true" />
        <span>{endpointState ?? (loading ? "loading" : "unavailable")}</span>
      </div>
      {suspended ? (
        <div className="terminal-state" role="status">
          <LoaderCircle className="spin" aria-hidden="true" size={22} />
          <strong>Routing message</strong>
        </div>
      ) : status?.state === "ready" ? (
        <iframe
          className="ttyd-frame"
          src={status.url}
          title={`${alias} (${memberId}) ttyd terminal`}
          referrerPolicy="same-origin"
        />
      ) : (
        <div
          className="terminal-state"
          role={endpointState === "unavailable" || error !== undefined ? "alert" : "status"}
        >
          {loading || endpointState === "starting" || endpointState === "backoff" ? (
            <LoaderCircle className="spin" aria-hidden="true" size={22} />
          ) : (
            <CircleAlert aria-hidden="true" size={22} />
          )}
          <strong>{stateLabel}</strong>
          {detail !== undefined && <span>{detail}</span>}
          {status?.retryAfterMs !== undefined && (
            <span>Retrying in {Math.ceil(status.retryAfterMs / 1_000)} seconds.</span>
          )}
          {(endpointState === "unavailable" || error !== undefined) && (
            <button type="button" onClick={retry}>
              <RefreshCw aria-hidden="true" size={15} />
              Retry
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface TerminalWorkspaceProps {
  client: PortalClient;
  members: GroupMembership[];
  runs: AgentRun[];
  connectionRevision?: number;
  suspended?: boolean;
}

export function TerminalWorkspace({
  client,
  members,
  runs,
  connectionRevision = 0,
  suspended = false,
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
  const activeRunId = availableRuns.some((run) => run.id === selectedRunId)
    ? selectedRunId
    : availableRuns[0]?.id;
  const memberAlias = (run: AgentRun) =>
    members.find((member) => member.memberId === run.memberId)?.alias ?? run.memberId;

  if (availableRuns.length === 0) {
    return (
      <div className="empty-state terminal-empty">
        <Monitor aria-hidden="true" size={28} />
        <h2>No active terminals</h2>
        <p>Start a group member from the tree to open its tmux terminal.</p>
      </div>
    );
  }

  return (
    <div className="terminal-workspace">
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="Agent terminals">
          {availableRuns.map((run) => (
            <button
              type="button"
              role="tab"
              aria-selected={run.id === activeRunId}
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
            >
              <span className={`status-dot status-${run.status}`} aria-hidden="true" />
              <span>{memberAlias(run)}</span>
              <small title={run.memberId}>{run.memberId}</small>
            </button>
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
        {availableRuns
          .filter((run) => layout === "grid" || run.id === activeRunId)
          .map((run) => (
            <TerminalPane
              key={run.id}
              client={client}
              run={run}
              alias={memberAlias(run)}
              memberId={run.memberId}
              connectionRevision={connectionRevision}
              suspended={suspended}
            />
          ))}
      </div>
      <div className="terminal-mode-note">
        <CircleAlert aria-hidden="true" size={14} />
        One live terminal client is allowed per run. If ttyd asks to reconnect, close the other open
        terminal view first.
      </div>
    </div>
  );
}
