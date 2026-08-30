import type {
  AgentActionWorkspace,
  ConfigStatus,
  ControlMetadata,
  Group,
  GroupMembership,
  NanasaConfig,
  OpenWait,
  PortalSnapshot,
  ProviderStateBinding,
  TerminalCheckpoint,
} from "@nanasa/contracts";
import { Bell, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { PortalClient } from "../api.js";
import { ExtensionsWorkspace } from "../components/extensions-workspace.js";
import { generatedOfflineHelp } from "../help/generated-offline-help.js";
import type { PortalPreferences } from "../hooks/use-portal-preferences.js";
import type { PortalRoute } from "../router/portal-router.js";
import type { PortalCommand } from "../shell/command-palette.js";

interface PortalRoutePanelProps {
  route: PortalRoute;
  snapshot: PortalSnapshot;
  config: NanasaConfig;
  group?: Group;
  members: GroupMembership[];
  client: PortalClient;
  preferences: PortalPreferences;
  commands: PortalCommand[];
  onNavigate(path: string): void;
  onOpenCheckouts(): void;
  onRefresh(): Promise<void>;
  onPatchPreferences(next: Partial<PortalPreferences>): void;
}

const cancellableStates = new Set(["created", "deferred"]);

function WaitReply({
  wait,
  client,
  onChanged,
}: {
  wait: OpenWait;
  client: PortalClient;
  onChanged(): void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (reply: Parameters<PortalClient["replyOpenWait"]>[1]["reply"]) => {
    setBusy(true);
    try {
      await client.replyOpenWait(wait.id, {
        expectedRunId: wait.runId,
        expectedGeneration: wait.generation,
        expectedReporterEpoch: wait.reporterEpoch,
        expectedStatusRevision: wait.openedStatusRevision,
        reply,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="workflow-row">
      <div>
        <strong>{wait.summary}</strong>
        <small>
          {wait.kind.replaceAll("_", " ")} · {wait.memberId}
        </small>
      </div>
      {wait.kind === "permission" ? (
        <div className="workflow-actions">
          <button type="button" disabled={busy} onClick={() => void submit({ kind: "deny" })}>
            Deny
          </button>
          <button type="button" disabled={busy} onClick={() => void submit({ kind: "allow-once" })}>
            Allow once
          </button>
        </div>
      ) : wait.kind === "plan_approval" ? (
        <div className="workflow-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit({ kind: "reject-plan" })}
          >
            Reject
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit({ kind: "approve-plan" })}
          >
            Approve
          </button>
        </div>
      ) : (
        <form
          className="workflow-actions"
          onSubmit={(event) => {
            event.preventDefault();
            void submit({ kind: "answer", text: answer });
          }}
        >
          <input
            aria-label={`Answer ${wait.summary}`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            required
          />
          <button type="submit" disabled={busy || answer.trim().length === 0}>
            Reply
          </button>
        </form>
      )}
    </li>
  );
}

function ActivityPanel({
  group,
  client,
  revision,
}: {
  group: Group;
  client: PortalClient;
  revision: number;
}) {
  const [workspace, setWorkspace] = useState<AgentActionWorkspace>();
  const [error, setError] = useState<string>();
  const refresh = () =>
    void client
      .loadActionWorkspace(group.id)
      .then(setWorkspace, (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Unable to load activity"),
      );
  useEffect(refresh, [client, group.id, revision]);
  return (
    <RouteSurface
      title="Activity"
      eyebrow={group.name}
      description="Durable work control is shown separately from message delivery and browser unread state."
    >
      {error !== undefined && (
        <p className="route-error" role="alert">
          {error}
        </p>
      )}
      <section className="workflow-card">
        <h3>Open exact waits</h3>
        {(workspace?.openWaits.filter((wait) => ["open", "replying"].includes(wait.state)).length ??
          0) === 0 ? (
          <p>No provider waits require input.</p>
        ) : (
          <ul className="workflow-list">
            {workspace?.openWaits
              .filter((wait) => ["open", "replying"].includes(wait.state))
              .map((wait) => (
                <WaitReply key={wait.id} wait={wait} client={client} onChanged={refresh} />
              ))}
          </ul>
        )}
      </section>
      <section className="workflow-card">
        <h3>Action progress</h3>
        {(workspace?.actions.length ?? 0) === 0 ? (
          <p>No exact actions have been created.</p>
        ) : (
          <ul className="workflow-list">
            {workspace?.actions
              .slice()
              .reverse()
              .map((action) => {
                const attempts =
                  workspace?.attempts.filter((attempt) => attempt.actionId === action.id) ?? [];
                const acknowledgements =
                  workspace?.acknowledgements.filter((item) => item.actionId === action.id) ?? [];
                return (
                  <li key={action.id} className="workflow-row">
                    <div>
                      <strong>
                        {action.target.memberId} · {action.state}
                      </strong>
                      <small>
                        {attempts.length} attempts · {acknowledgements.length} acknowledgements ·{" "}
                        {action.id}
                      </small>
                    </div>
                    {cancellableStates.has(action.state) && (
                      <button
                        type="button"
                        onClick={() => void client.cancelAgentAction(action.id).then(refresh)}
                      >
                        Cancel
                      </button>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </section>
    </RouteSurface>
  );
}

function GroupSettingsPanel({
  group,
  members,
  snapshot,
  config,
}: Pick<PortalRoutePanelProps, "group" | "members" | "snapshot" | "config"> & { group: Group }) {
  const configured = config.groups[group.id];
  return (
    <RouteSurface
      title="Group settings"
      eyebrow={group.name}
      description="Repository-owned execution policy and browser-owned presentation remain separate."
    >
      <div className="workflow-grid">
        <section className="workflow-card">
          <h3>Models and provider state</h3>
          <ul className="definition-list">
            {members.map((member) => {
              const agent = Object.values(configured?.agents ?? {}).find(
                (candidate) => candidate.memberId === member.memberId,
              );
              const integration =
                agent === undefined ? undefined : config.integrations[agent.integrationId];
              const run = snapshot.runs
                .filter((item) => item.memberId === member.memberId)
                .sort((a, b) => b.generation - a.generation)[0];
              return (
                <li key={member.id}>
                  <strong>{member.alias}</strong>
                  <span>
                    {run?.effectiveModel ??
                      agent?.desiredModel ??
                      integration?.model.model ??
                      "provider default"}
                  </span>
                  <small>
                    {integration?.providerState.scope ?? "unknown"} state ·{" "}
                    {run?.requestedModelSource ?? "not started"}
                  </small>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="workflow-card">
          <h3>Recovery</h3>
          <ul className="definition-list">
            {snapshot.runs
              .filter((run) => run.groupId === group.id)
              .map((run) => (
                <li key={run.id}>
                  <strong>{run.memberId}</strong>
                  <span>{run.recoveryPhase}</span>
                  <small>
                    {run.recoveryOutcome ?? run.recoveryReason ?? "No recovery outcome"} · attempt{" "}
                    {run.recoveryAttempts}
                  </small>
                </li>
              ))}
          </ul>
        </section>
        <section className="workflow-card">
          <h3>Retention</h3>
          <dl>
            <div>
              <dt>Messages per group</dt>
              <dd>{config.messages.retentionPerGroup}</dd>
            </div>
            <div>
              <dt>Terminal checkpoints</dt>
              <dd>
                {config.terminal.checkpoints.enabled
                  ? `${config.terminal.checkpoints.retentionSeconds}s`
                  : "disabled"}
              </dd>
            </div>
            <div>
              <dt>Checkpoint bounds</dt>
              <dd>
                {config.terminal.checkpoints.maxLines} lines /{" "}
                {config.terminal.checkpoints.maxBytes} bytes
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </RouteSurface>
  );
}

function AttentionPanel({
  snapshot,
  client,
  onNavigate,
  onRefresh,
}: Pick<PortalRoutePanelProps, "snapshot" | "client" | "onNavigate" | "onRefresh">) {
  const items = (snapshot.agentStatuses ?? []).filter(
    (status) => status.attention !== "none" || status.completionPending,
  );
  return (
    <RouteSurface
      title="Attention"
      eyebrow="Global operations"
      description="Input requests, blockers, failures, and unacknowledged completion revisions."
    >
      {items.length === 0 ? (
        <Empty text="No agents currently need attention." />
      ) : (
        <ul className="workflow-list">
          {items.map((status) => (
            <li className="workflow-row" key={`${status.groupId}:${status.memberId}`}>
              <div>
                <strong>
                  {status.alias} · {status.attention.replaceAll("_", " ")}
                </strong>
                <small>
                  {status.state} · {status.phase} · completion revision {status.completionRevision}
                </small>
              </div>
              <div className="workflow-actions">
                <button
                  type="button"
                  onClick={() =>
                    onNavigate(`/groups/${encodeURIComponent(status.groupId)}/activity`)
                  }
                >
                  Open
                </button>
                {status.completionPending && (
                  <button
                    type="button"
                    onClick={() =>
                      void client
                        .acknowledgeCompletion(status.groupId, status.memberId)
                        .then(onRefresh)
                    }
                  >
                    Acknowledge completion
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </RouteSurface>
  );
}

function AgentDirectory({
  snapshot,
  onNavigate,
}: Pick<PortalRoutePanelProps, "snapshot" | "onNavigate">) {
  const statuses = new Map(
    (snapshot.agentStatuses ?? []).map((status) => [
      `${status.groupId}:${status.memberId}`,
      status,
    ]),
  );
  return (
    <RouteSurface
      title="Agents"
      eyebrow="Global directory"
      description="All configured agents, provider models, recovery state, and attention across groups."
    >
      <ul className="workflow-list">
        {snapshot.memberships
          .filter((member) => member.state === "active")
          .map((member) => {
            const status = statuses.get(`${member.groupId}:${member.memberId}`);
            const run = snapshot.runs
              .filter((item) => item.memberId === member.memberId)
              .sort((a, b) => b.generation - a.generation)[0];
            return (
              <li className="workflow-row" key={member.id}>
                <div>
                  <strong>{member.alias}</strong>
                  <small>
                    {status?.state ?? run?.status ?? "not started"} ·{" "}
                    {run?.effectiveModel ?? "provider model pending"} ·{" "}
                    {run?.recoveryPhase ?? "no run"}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onNavigate(
                      `/groups/${encodeURIComponent(member.groupId)}/terminals${run === undefined ? "" : `/${encodeURIComponent(run.id)}`}`,
                    )
                  }
                >
                  Open agent
                </button>
              </li>
            );
          })}
      </ul>
    </RouteSurface>
  );
}

function DiagnosticsPanel({
  client,
  snapshot,
  onRefresh,
}: Pick<PortalRoutePanelProps, "client" | "snapshot" | "onRefresh">) {
  const [metadata, setMetadata] = useState<ControlMetadata>();
  const [status, setStatus] = useState<ConfigStatus>();
  const [states, setStates] = useState<ProviderStateBinding[]>([]);
  const [checkpoints, setCheckpoints] = useState<TerminalCheckpoint[]>([]);
  const [error, setError] = useState<string>();
  const load = () =>
    void Promise.all([
      client.loadMetadata(),
      client.loadConfigStatus(),
      client.listProviderStates(),
      client.listTerminalCheckpoints(),
    ]).then(
      ([nextMetadata, nextStatus, nextStates, nextCheckpoints]) => {
        setMetadata(nextMetadata);
        setStatus(nextStatus);
        setStates(nextStates);
        setCheckpoints(nextCheckpoints);
        setError(undefined);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Unable to load diagnostics"),
    );
  useEffect(load, [client, snapshot.sequence]);
  const lifecycle = async (bindingId: string, action: "retain" | "delete") => {
    await (action === "retain"
      ? client.retainProviderState(bindingId)
      : client.deleteProviderState(bindingId));
    load();
    await onRefresh();
  };
  return (
    <RouteSurface
      title="Diagnostics"
      eyebrow="Control plane"
      description="Structured configuration, provider-state, terminal retention, and daemon metadata."
    >
      {error !== undefined && (
        <p className="route-error" role="alert">
          {error}
        </p>
      )}
      <div className="workflow-grid">
        <section className="workflow-card">
          <h3>Daemon</h3>
          <dl>
            <div>
              <dt>Lifecycle</dt>
              <dd>{metadata?.lifecycle ?? "loading"}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{metadata?.productVersion ?? "loading"}</dd>
            </div>
            <div>
              <dt>Epoch</dt>
              <dd>{metadata?.daemonEpoch ?? snapshot.daemonEpoch}</dd>
            </div>
            <div>
              <dt>Events</dt>
              <dd>sequence {snapshot.sequence}</dd>
            </div>
          </dl>
        </section>
        <section className="workflow-card">
          <h3>Configuration</h3>
          <p>
            {status?.state ?? "loading"} · {status?.configPath}
          </p>
          {(status?.diagnostics.length ?? 0) === 0 ? (
            <p>No configuration diagnostics.</p>
          ) : (
            <ul>
              {status?.diagnostics.map((item, index) => (
                <li key={`${item.code}:${index}`}>
                  <strong>{item.code}</strong> {item.message}
                  {item.line === undefined
                    ? ""
                    : ` (line ${item.line}, column ${item.column ?? 1})`}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="workflow-card">
        <h3>Provider-state lifecycle</h3>
        {states.length === 0 ? (
          <p>No provider-state bindings.</p>
        ) : (
          <ul className="workflow-list">
            {states.map((binding) => (
              <li className="workflow-row" key={binding.id}>
                <div>
                  <strong>
                    {binding.integrationId} · {binding.lifecycle}
                  </strong>
                  <small>
                    {binding.scope} · {binding.memberId ?? "shared"} · {binding.id}
                  </small>
                </div>
                <div className="workflow-actions">
                  <button
                    type="button"
                    disabled={binding.lifecycle === "retained"}
                    onClick={() => void lifecycle(binding.id, "retain")}
                  >
                    Retain
                  </button>
                  <button
                    type="button"
                    disabled={binding.lifecycle === "deleted"}
                    onClick={() => void lifecycle(binding.id, "delete")}
                  >
                    Delete marker
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="workflow-card">
        <h3>Terminal checkpoints</h3>
        {checkpoints.length === 0 ? (
          <p>No retained terminal checkpoints.</p>
        ) : (
          <ul className="workflow-list">
            {checkpoints.map((checkpoint) => (
              <li className="workflow-row" key={checkpoint.id}>
                <div>
                  <strong>{checkpoint.runId}</strong>
                  <small>
                    {checkpoint.lineCount} lines · {checkpoint.byteCount} bytes · expires{" "}
                    {checkpoint.expiresAt}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => void client.deleteTerminalCheckpoint(checkpoint.id).then(load)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </RouteSurface>
  );
}

function SettingsPanel({
  preferences,
  onPatchPreferences,
}: Pick<PortalRoutePanelProps, "preferences" | "onPatchPreferences">) {
  const setNotification = (key: keyof PortalPreferences["notifications"], value: boolean) =>
    onPatchPreferences({ notifications: { ...preferences.notifications, [key]: value } });
  const requestNotifications = async () => {
    if (!("Notification" in window)) return;
    const permission = await Notification.requestPermission();
    setNotification("desktop", permission === "granted");
  };
  return (
    <RouteSurface
      title="Settings"
      eyebrow="Browser-owned presentation"
      description="Validated preferences v2 synchronize across same-origin tabs and never alter daemon runtime truth."
    >
      <div className="settings-grid">
        <fieldset>
          <legend>Appearance</legend>
          <label>
            Theme
            <select
              value={preferences.theme}
              onChange={(event) =>
                onPatchPreferences({ theme: event.target.value as PortalPreferences["theme"] })
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Density
            <select
              value={preferences.density}
              onChange={(event) =>
                onPatchPreferences({ density: event.target.value as PortalPreferences["density"] })
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend>Accessibility</legend>
          <label>
            Motion
            <select
              value={preferences.motion}
              onChange={(event) =>
                onPatchPreferences({ motion: event.target.value as PortalPreferences["motion"] })
              }
            >
              <option value="system">Follow system</option>
              <option value="reduce">Reduce motion</option>
              <option value="full">Allow motion</option>
            </select>
          </label>
          <label>
            Contrast
            <select
              value={preferences.contrast}
              onChange={(event) =>
                onPatchPreferences({
                  contrast: event.target.value as PortalPreferences["contrast"],
                })
              }
            >
              <option value="system">Follow system</option>
              <option value="forced">Forced colors</option>
              <option value="standard">Standard colors</option>
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend>Notifications</legend>
          <label>
            <input
              type="checkbox"
              checked={preferences.notifications.inApp}
              onChange={(event) => setNotification("inApp", event.target.checked)}
            />{" "}
            In-app attention notices
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.notifications.sound}
              onChange={(event) => setNotification("sound", event.target.checked)}
            />{" "}
            Attention sound
          </label>
          <button type="button" onClick={() => void requestNotifications()}>
            {preferences.notifications.desktop
              ? "Desktop notifications enabled"
              : "Request desktop notifications"}
          </button>
        </fieldset>
      </div>
    </RouteSurface>
  );
}

function HelpPanel({ commands }: Pick<PortalRoutePanelProps, "commands">) {
  return (
    <RouteSurface
      title="Help"
      eyebrow="Offline operator guide"
      description="This content is generated from the shipped command registry and terminal policy."
    >
      {generatedOfflineHelp(commands).map((section) => (
        <section className="workflow-card" key={section.title}>
          <h3>{section.title}</h3>
          <dl>
            {section.items.map((item) => (
              <div key={`${section.title}:${item.term}`}>
                <dt>{item.term}</dt>
                <dd>{item.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </RouteSurface>
  );
}

function RouteSurface({
  title,
  eyebrow,
  description,
  children,
}: {
  title: string;
  eyebrow: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <article className="route-surface">
      <header className="route-heading">
        <span className="eyebrow">{eyebrow}</span>
        <h2 data-route-heading tabIndex={-1}>
          {title}
        </h2>
        <p>{description}</p>
      </header>
      {children}
    </article>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty-state route-empty">
      <Bell aria-hidden="true" size={28} />
      <p>{text}</p>
    </div>
  );
}

export function PortalRoutePanel(props: PortalRoutePanelProps) {
  const { route, group } = props;
  if (route.kind === "group" && group !== undefined) {
    if (route.section === "activity")
      return (
        <ActivityPanel group={group} client={props.client} revision={props.snapshot.sequence} />
      );
    if (route.section === "settings")
      return (
        <GroupSettingsPanel
          group={group}
          members={props.members}
          snapshot={props.snapshot}
          config={props.config}
        />
      );
  }
  if (route.kind !== "global") return null;
  switch (route.destination) {
    case "attention":
      return (
        <AttentionPanel
          snapshot={props.snapshot}
          client={props.client}
          onNavigate={props.onNavigate}
          onRefresh={props.onRefresh}
        />
      );
    case "agents":
      return <AgentDirectory snapshot={props.snapshot} onNavigate={props.onNavigate} />;
    case "checkouts":
      return (
        <RouteSurface
          title="Checkouts"
          eyebrow="Git workspaces"
          description="Create, open, assign, inspect, and provenance-check managed worktrees."
        >
          <button type="button" className="primary-button" onClick={props.onOpenCheckouts}>
            <GitBranch aria-hidden="true" size={16} /> Manage checkouts and worktrees
          </button>
          <ul className="workflow-list">
            {props.snapshot.checkouts.map((checkout) => (
              <li className="workflow-row" key={checkout.id}>
                <div>
                  <strong>{checkout.branch ?? "detached checkout"}</strong>
                  <small>
                    {checkout.path} · {checkout.dirty ? "dirty" : "clean"}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </RouteSurface>
      );
    case "extensions":
      return (
        <RouteSurface
          title="Extensions"
          eyebrow="Provider capabilities"
          description="Install and inspect strict data-only provider packages with exact trust, permissions, health, drift, and ownership evidence."
        >
          <ExtensionsWorkspace
            client={props.client}
            revision={props.snapshot.sequence}
            onChanged={props.onRefresh}
          />
        </RouteSurface>
      );
    case "settings":
      return (
        <SettingsPanel
          preferences={props.preferences}
          onPatchPreferences={props.onPatchPreferences}
        />
      );
    case "diagnostics":
      return (
        <DiagnosticsPanel
          client={props.client}
          snapshot={props.snapshot}
          onRefresh={props.onRefresh}
        />
      );
    case "help":
      return <HelpPanel commands={props.commands} />;
    case "release":
      return (
        <RouteSurface
          title="Release"
          eyebrow="Installed product"
          description="Local release identity and compatibility metadata."
        >
          <section className="workflow-card">
            <h3>Nanasa {props.snapshot.configStatus?.revision?.slice(0, 8) ?? "development"}</h3>
            <p>
              The daemon metadata and schema compatibility evidence are available in Diagnostics.
            </p>
            <button type="button" onClick={() => props.onNavigate("/diagnostics")}>
              <RefreshCw aria-hidden="true" size={15} /> Open diagnostics
            </button>
          </section>
        </RouteSurface>
      );
  }
}
