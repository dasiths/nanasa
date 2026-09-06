import type { NanasaConfig, PortalSnapshot } from "@nanasa/contracts";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  FileCode2,
  FolderGit2,
  GitBranch,
  Layers,
  ListFilter,
  LockKeyhole,
  type LucideIcon,
  Pencil,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Users,
  X,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { groupRoute } from "../router/portal-router.js";
import { type AgentDirectoryEntry, agentDirectoryEntries } from "./agent-directory-model.js";
import { RoleGlyph, roleColorClass } from "./role-identity.js";
import "./agent-directory.css";
import { copyToClipboard } from "../copy-to-clipboard.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
import {
  AgentAttentionSettings,
  AgentSessionActions,
  EntityCreateDialog,
  EntityEditor,
  useEntityManagement,
} from "./entity-management.js";

type Grouping = "team" | "provider" | "none";

function Label({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="ad-icon-label">
      <Icon size={14} aria-hidden="true" />
      {children}
    </span>
  );
}

function Help({ text }: { text: string }) {
  const id = useId();
  return (
    <button type="button" className="ad-help" aria-label="Details" aria-describedby={id}>
      <CircleHelp size={13} aria-hidden="true" />
      <span id={id} role="tooltip">
        {text}
      </span>
    </button>
  );
}

function Field({ label, value, source }: { label: string; value: ReactNode; source?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {source !== undefined && <small>{source}</small>}
      </dd>
    </div>
  );
}

function setting(value: string | undefined, fallback = "Provider default"): string {
  if (value === undefined) return fallback;
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " ");
}

function AgentLink({
  path,
  onNavigate,
  children,
}: {
  path: string;
  onNavigate(path: string): void;
  children: ReactNode;
}) {
  return (
    <a
      className="ad-link"
      href={path}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        onNavigate(path);
      }}
    >
      {children}
    </a>
  );
}

function PromptLayers({ entry }: { entry: AgentDirectoryEntry }) {
  const selections = [
    { name: "Integration", selection: entry.integration?.providerFiles?.mcp },
    { name: "Agent", selection: entry.agent?.providerFiles?.mcp },
  ];
  return (
    <>
      <section className="ad-section" aria-label="Prompt composition">
        <h4>
          <Label icon={Layers}>Prompt composition</Label>
          <small>{entry.sourceCount} sources</small>
        </h4>
        {entry.agent === undefined ? (
          <p>Agent configuration unavailable</p>
        ) : (
          <ol className="ad-prompt-stack">
            {entry.layers.map((layer, index) => (
              <li key={layer.name}>
                <span className="ad-layer-number">{index + 1}</span>
                {layer.files.length > 0 ? (
                  <details open={layer.name === "Team"}>
                    <summary>
                      <ChevronRight size={13} aria-hidden="true" />
                      <strong>{layer.name}</strong>
                      <span>{layer.source}</span>
                      <b>{layer.files.length}</b>
                    </summary>
                    <ul>
                      {layer.files.map((file) => (
                        <li key={file}>
                          <FileCode2 size={12} aria-hidden="true" />
                          <code>{file}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <div className="ad-empty-layer">
                    <strong>{layer.name}</strong>
                    <span>No additional instructions</span>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="ad-section" aria-label="Provider MCP files">
        <h4>
          <Label icon={FileCode2}>Provider MCP files</Label>
          <Help text="Provider JSON files are separate from prompt layers. Agent selection may append, replace, or disable integration files." />
        </h4>
        <dl className="ad-fields">
          {selections.map(({ name, selection }) => (
            <Field
              key={name}
              label={name}
              value={
                <>
                  {setting(selection?.mode, name === "Agent" ? "Inherit" : "None configured")}
                  {selection?.paths.map((path) => (
                    <code className="ad-path" key={path}>
                      {path}
                    </code>
                  ))}
                </>
              }
            />
          ))}
        </dl>
      </section>
    </>
  );
}

function AgentInspector({
  entry,
  onNavigate,
  onClose,
  headingRef,
}: {
  entry: AgentDirectoryEntry;
  onNavigate(path: string): void;
  onClose(): void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const [tab, setTab] = useState("configuration");
  const management = useEntityManagement();
  const [editing, setEditing] = useState(false);
  const [copyState, setCopyState] = useState("");
  const { member, integration, role, checkout, state, profile } = entry;
  const hasTerminal = state.run?.status === "running" && state.run.terminal !== undefined;
  const recovery = integration?.nativeRecovery.mode;
  return (
    <aside className="ad-inspector" aria-label="Agent configuration">
      <button type="button" className="entity-detail-back" onClick={onClose}>
        <ArrowLeft size={15} aria-hidden="true" />
        Back to list
      </button>
      <header className="ad-inspector-heading">
        <span
          className={`ad-avatar ${roleColorClass(role)}`}
          title={role?.name ?? "Unassigned role"}
        >
          <RoleGlyph role={role} size={22} />
        </span>
        <div>
          <span className="eyebrow">{entry.group?.name ?? member.groupId}</span>
          <h3 ref={headingRef} tabIndex={-1}>
            {entry.agent?.name ?? member.alias}
          </h3>
          <small className="ad-member-id">
            Member ID: <code>{member.memberId}</code>
            <button
              type="button"
              className="icon-button"
              aria-label={`Copy member ID ${member.memberId}`}
              title="Copy member ID"
              onClick={() =>
                void copyToClipboard(member.memberId).then(
                  () => setCopyState("Member ID copied"),
                  () => setCopyState("Unable to copy member ID"),
                )
              }
            >
              <Copy size={12} />
            </button>
          </small>
          {copyState && <small role="status">{copyState}</small>}
          <small>
            {integration?.name ?? "Integration unavailable"} / {role?.name ?? "Unassigned role"}
          </small>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Close inspector"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="ad-navigation">
        {hasTerminal ? (
          <AgentLink
            path={groupRoute(member.groupId, "terminals", state.run!.id)}
            onNavigate={onNavigate}
          >
            <SquareTerminal size={15} aria-hidden="true" />
            Open terminal
          </AgentLink>
        ) : (
          <span
            tabIndex={0}
            className="ad-disabled-action"
            title="No live terminal. Open the team to start this agent."
          >
            <button type="button" className="ad-link" disabled>
              <SquareTerminal size={15} aria-hidden="true" />
              Open terminal
            </button>
          </span>
        )}
        <AgentLink path={groupRoute(member.groupId)} onNavigate={onNavigate}>
          <Users size={15} aria-hidden="true" />
          Open team
        </AgentLink>
      </div>
      <details className="ad-runtime-details">
        <summary>Runtime details</summary>
        <dl className="ad-fields">
          {Object.entries({
            "Process state": state.status?.processState,
            State: state.status?.state,
            Attention: state.status?.attention,
            "Progress stage": state.status?.progressStage,
            Confidence: state.status?.confidence,
            Authority: state.status?.authorityKind,
            "Authority ID": state.status?.authorityId,
            "Stale authority": state.status
              ? state.status.staleAuthority
                ? "Yes"
                : "No"
              : undefined,
            "Progress summary": state.status?.lastProgressSummary,
            Blocker: state.status?.blocker,
            "Next step": state.status?.nextStep,
            "Last activity": state.status?.lastActivityKind,
            "Last activity at": state.status?.lastActivityAt,
            "Terminal status": state.run?.status,
            "Recovery phase": state.run?.recoveryPhase,
            "Recovery reason": state.run?.recoveryReason,
          })
            .filter(([, value]) => value !== undefined)
            .map(([label, value]) => (
              <Field key={label} label={label} value={String(value)} />
            ))}
        </dl>
      </details>
      <nav className="ad-tabs" aria-label="Agent detail views">
        <button
          type="button"
          aria-pressed={tab === "configuration"}
          onClick={() => setTab("configuration")}
        >
          <Settings2 size={14} aria-hidden="true" />
          Configuration
        </button>
        <button type="button" aria-pressed={tab === "prompts"} onClick={() => setTab("prompts")}>
          <Layers size={14} aria-hidden="true" />
          Prompt layers
        </button>
        {management && (
          <>
            <button
              type="button"
              aria-pressed={tab === "session"}
              onClick={() => setTab("session")}
            >
              Session
            </button>
            <button
              type="button"
              aria-pressed={tab === "attention"}
              onClick={() => setTab("attention")}
            >
              Attention
            </button>
          </>
        )}
      </nav>
      {tab === "session" && management ? (
        <AgentSessionActions entry={entry} />
      ) : tab === "attention" && management ? (
        <AgentAttentionSettings entry={entry} />
      ) : tab === "prompts" ? (
        <PromptLayers entry={entry} />
      ) : (
        <>
          {management && entry.agent && (
            <section className="ad-section" aria-label="Agent configuration editor">
              <h4>
                Configuration
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit agent settings ${entry.member.alias}`}
                  title="Edit agent configuration"
                  onClick={() => setEditing(!editing)}
                >
                  <Pencil size={14} />
                </button>
              </h4>
              {editing ? (
                <EntityEditor kind="agent" entry={entry} onClose={() => setEditing(false)} />
              ) : (
                <dl className="ad-fields">
                  <Field label="Name" value={entry.agent.name} />
                  <Field label="Integration" value={entry.integration?.name ?? "Unavailable"} />
                  <Field label="Role" value={entry.role?.name ?? "Unassigned"} />
                </dl>
              )}
            </section>
          )}
          <section className="ad-section" aria-label="Workspace configuration">
            <h4>
              <Label icon={FolderGit2}>Workspace</Label>
              <small>
                {entry.group?.checkoutId === undefined ? "Primary fallback" : "Team binding"}
              </small>
            </h4>
            <div className="ad-branch">
              <GitBranch size={15} aria-hidden="true" />
              <strong>
                {checkout?.branch ??
                  (checkout === undefined ? "Unavailable checkout" : "Detached HEAD")}
              </strong>
              <small>{checkout?.kind}</small>
            </div>
            {checkout && <code className="ad-path">{checkout.path}</code>}
            <dl className="ad-fields">
              <Field
                label="Mapped CWD"
                value={
                  entry.startingDirectory === undefined ? (
                    "Unavailable"
                  ) : (
                    <code>{entry.startingDirectory}</code>
                  )
                }
                source="Configured path in the team checkout"
              />
              <Field
                label="Integration CWD"
                value={
                  integration === undefined ? "Unavailable" : (integration.cwd ?? "Checkout root")
                }
              />
            </dl>
          </section>
          <section className="ad-section" aria-label="Provider state and credentials">
            <h4>
              <Label icon={LockKeyhole}>Provider state & credentials</Label>
            </h4>
            <dl className="ad-fields">
              <Field label="Integration" value={integration?.id ?? "Unavailable"} />
              <Field
                label="State scope"
                value={setting(integration?.providerState.scope, "Unavailable")}
                source={
                  integration?.providerState.scope === "membership"
                    ? "One provider home per agent"
                    : integration?.providerState.scope === "integration"
                      ? "Shared by agents using this integration"
                      : "Configured custom path"
                }
              />
              <Field
                label="Credentials"
                value={
                  integration?.credentials.kind === "broker-profile"
                    ? `Broker profile: ${integration.credentials.profileId}`
                    : integration === undefined
                      ? "Unavailable"
                      : "Provider-managed"
                }
              />
              <Field
                label="Home reference"
                value={
                  entry.providerHome === undefined ? (
                    "Unavailable"
                  ) : (
                    <code>{entry.providerHome}</code>
                  )
                }
                source="Relative to the daemon config root; configured location"
              />
            </dl>
          </section>
          <section className="ad-section" aria-label="Execution configuration">
            <h4>
              <Label icon={Zap}>Execution policy</Label>
              <small>Configured</small>
            </h4>
            <dl className="ad-fields">
              <Field label="Profile" value={integration?.executionProfile ?? "None configured"} />
              <Field label="Continuation" value={setting(profile?.continuation)} />
              <Field label="Questions" value={setting(profile?.questions)} />
              <Field label="Approval policy" value={setting(profile?.approvals)} />
              <Field
                label="Role permissions"
                value={
                  role?.permissionPolicy === "read-only" ? (
                    <span className="ad-gold">Read-only</span>
                  ) : (
                    "Inherit provider permissions"
                  )
                }
              />
            </dl>
            {role?.permissionPolicy === "read-only" && (
              <div className="ad-policy-note">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>Read-only role restrictions take precedence over autonomous grants.</span>
              </div>
            )}
            {integration?.executionProfile !== undefined && profile === undefined && (
              <p className="ad-policy-note">Execution profile unavailable</p>
            )}
            {profile !== undefined && (
              <small className="ad-policy-source">
                Requires daemon authorization and provider support.
              </small>
            )}
          </section>
          <section className="ad-section" aria-label="Model and recovery configuration">
            <h4>
              <Label icon={Braces}>Model & recovery</Label>
            </h4>
            <dl className="ad-fields">
              <Field
                label="Desired model"
                value={entry.desiredModel ?? "Provider default"}
                source={entry.modelSource}
              />
              <Field
                label="Recovery"
                value={recovery === "resume-or-restart" ? "Resume or restart" : setting(recovery)}
              />
              <Field label="Model on resume" value={setting(integration?.model.resumePolicy)} />
              <Field label="MCP messaging" value="Team-scoped" />
            </dl>
          </section>
          <section className="ad-section" aria-label="Latest runtime observation">
            <h4>
              <Label icon={Activity}>Latest runtime</Label>
              <small>Observed</small>
            </h4>
            <dl className="ad-fields">
              <Field label="Status" value={state.label} />
              <Field label="Effective model" value={state.run?.effectiveModel ?? "Not reported"} />
              <Field
                label="Run CWD"
                value={state.run?.resolvedWorkingDirectory ?? "Not recorded"}
              />
            </dl>
          </section>
        </>
      )}
      <footer className="ad-inspector-footer">
        <small>Agent ID</small>
        <code>{member.id}</code>
      </footer>
    </aside>
  );
}

export function AgentDirectory({
  snapshot,
  config,
  onNavigate,
  groupId,
}: {
  snapshot: PortalSnapshot;
  config: NanasaConfig;
  onNavigate(path: string): void;
  groupId?: string;
}) {
  const entries = agentDirectoryEntries(snapshot, config).filter(
    (entry) => !groupId || entry.member.groupId === groupId,
  );
  const management = useEntityManagement();
  const [creating, setCreating] = useState(false);
  const [organize, setOrganize] = useState(false);
  const [orderError, setOrderError] = useState<PortalError>();
  const [groupBy, setGroupBy] = useState<Grouping>("team");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | undefined>();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const focusInspector = useRef(false);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const filtered = entries.filter((entry) =>
    [
      entry.member.alias,
      entry.member.id,
      entry.member.memberId,
      entry.group?.name,
      entry.integration?.name,
      entry.integration?.kind,
      entry.checkout?.branch,
      entry.role?.name,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const selected = filtered.find((entry) => entry.member.id === selection);
  const groups = new Map<string, AgentDirectoryEntry[]>();
  for (const entry of filtered) {
    const key =
      groupBy === "team"
        ? entry.member.groupId
        : groupBy === "provider"
          ? (entry.integration?.kind ?? "unavailable")
          : "all";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const revealInspector = () => {
    const heading = inspectorHeading.current;
    heading?.focus({ preventScroll: true });
    if ((heading?.closest<HTMLElement>(".agent-directory")?.clientWidth ?? 0) < 940) {
      heading?.closest(".ad-inspector")?.scrollIntoView?.({ block: "start" });
    }
  };
  useEffect(() => {
    if (focusInspector.current && selected !== undefined) {
      focusInspector.current = false;
      revealInspector();
    }
  }, [selected]);

  return (
    <article
      className={`route-surface agent-directory${selected ? " entity-detail-open" : ""}${groupId ? " ad-team-members" : ""}`}
    >
      <header className="route-heading ad-page-heading">
        <div>
          <span className="eyebrow">Repository configuration</span>
          <h2 data-route-heading tabIndex={-1}>
            {groupId ? "Members" : "All agents"}
          </h2>
          <div className="ad-config-source">
            <FileCode2 size={13} aria-hidden="true" />
            <code>{snapshot.configStatus?.configPath ?? ".nanasa/config.yaml"}</code>
          </div>
        </div>
        <div className="ad-totals">
          <span>
            <b>{entries.length}</b> {entries.length === 1 ? "agent" : "agents"}
          </span>
          <span>
            <b>{new Set(entries.map((entry) => entry.member.groupId)).size}</b>{" "}
            {new Set(entries.map((entry) => entry.member.groupId)).size === 1 ? "team" : "teams"}
          </span>
          <span>
            <b>
              {
                new Set(
                  entries.flatMap((entry) =>
                    entry.integration === undefined ? [] : [entry.integration.kind],
                  ),
                ).size
              }
            </b>{" "}
            {new Set(
              entries.flatMap((entry) =>
                entry.integration === undefined ? [] : [entry.integration.kind],
              ),
            ).size === 1
              ? "provider"
              : "providers"}
          </span>
        </div>
      </header>
      <div className="ad-toolbar">
        <label className="ad-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search agents"
            placeholder="Search agents, providers, branches..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="ad-group-control">
          <Users size={14} aria-hidden="true" />
          <span>Group by</span>
          <select
            aria-label="Group by"
            value={groupBy}
            onChange={(event) => {
              setGroupBy(event.target.value as Grouping);
              setCollapsed([]);
            }}
          >
            <option value="team">Team</option>
            <option value="provider">Provider</option>
            <option value="none">None</option>
          </select>
        </label>
        <span className="ad-result-count">
          {filtered.length} of {entries.length} agents
        </span>
        {management && (
          <>
            <button
              className="icon-button"
              type="button"
              aria-label="Organize agents"
              title="Organize agents"
              aria-pressed={organize}
              onClick={() => setOrganize(!organize)}
            >
              <ListFilter size={15} />
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={!snapshot.groups.length}
              onClick={() => setCreating(true)}
            >
              <Plus size={14} />
              Add agent
            </button>
          </>
        )}
      </div>
      {orderError && <ErrorNotice error={orderError} />}
      <div className={`ad-layout ${selected === undefined ? "" : "ad-has-inspector"}`}>
        <section className="ad-directory" aria-label="Configured agents">
          <div className="ad-column-head">
            <span>Agent / provider</span>
            <span>Runtime</span>
            <span>Model</span>
            <span>Role</span>
          </div>
          {[...groups].map(([key, members]) => {
            const entry = members[0]!;
            const team = groupBy === "team" ? entry.group : undefined;
            const checkout = groupBy === "team" ? entry.checkout : undefined;
            const closed = collapsed.includes(key);
            const title =
              groupBy === "team"
                ? (team?.name ?? key)
                : groupBy === "provider"
                  ? setting(entry.integration?.kind, "Unavailable provider")
                  : "All configured agents";
            return (
              <section key={key} className="ad-group" aria-label={title}>
                <button
                  type="button"
                  className="ad-group-heading"
                  aria-expanded={!closed}
                  onClick={() =>
                    setCollapsed(
                      closed ? collapsed.filter((item) => item !== key) : [...collapsed, key],
                    )
                  }
                >
                  <ChevronDown
                    className={closed ? "ad-rotated" : ""}
                    size={16}
                    aria-hidden="true"
                  />
                  <Users size={16} aria-hidden="true" />
                  <strong>{title}</strong>
                  <span className="ad-count">{members.length}</span>
                  {checkout && (
                    <>
                      <span
                        className={`ad-workspace-type ${checkout.kind === "linked" ? "ad-linked" : ""}`}
                      >
                        <FolderGit2 size={12} aria-hidden="true" />
                        {setting(checkout.kind)} workspace
                      </span>
                      <span className="ad-group-branch">
                        <GitBranch size={13} aria-hidden="true" />
                        {checkout.branch ?? "Detached HEAD"}
                      </span>
                    </>
                  )}
                </button>
                {!closed && (
                  <>
                    {groupBy === "team" && (
                      <div className="ad-team-path">
                        <code>{checkout?.path ?? "Workspace unavailable"}</code>
                        <span>
                          {checkout?.kind === "linked"
                            ? "Exclusive to this team"
                            : checkout?.kind === "primary"
                              ? "Shareable checkout"
                              : ""}
                        </span>
                      </div>
                    )}
                    <ul className="ad-agent-list">
                      {members.map((agent) => (
                        <li key={agent.member.id}>
                          <button
                            type="button"
                            className={`ad-agent-row ${agent.member.id === selection ? "ad-selected" : ""}`}
                            ref={(button) => {
                              if (button) rowButtons.current.set(agent.member.id, button);
                              else rowButtons.current.delete(agent.member.id);
                            }}
                            aria-label={`Inspect ${agent.member.alias}`}
                            aria-description={`Member ID: ${agent.member.memberId}`}
                            aria-pressed={agent.member.id === selection}
                            onClick={() => {
                              if (selection === agent.member.id) revealInspector();
                              else {
                                focusInspector.current = true;
                                setSelection(agent.member.id);
                              }
                            }}
                          >
                            <div className="ad-identity">
                              <span
                                className={`ad-avatar ${roleColorClass(agent.role)}`}
                                title={agent.role?.name ?? "Unassigned role"}
                              >
                                <RoleGlyph role={agent.role} size={17} />
                              </span>
                              <div>
                                <strong>{agent.agent?.name ?? agent.member.alias}</strong>
                                <small className="ad-member-id">
                                  <code>{agent.member.memberId}</code>
                                </small>
                                <small>
                                  {agent.integration?.name ?? "Integration unavailable"}
                                </small>
                              </div>
                            </div>
                            <div className="ad-scope-cell">
                              <span
                                className="entity-state-label"
                                data-tone={
                                  agent.state.attentionWorthy
                                    ? "warning"
                                    : agent.state.key === "working"
                                      ? "ready"
                                      : "muted"
                                }
                              >
                                {agent.state.label}
                              </span>
                              <small>
                                {agent.state.run
                                  ? `Generation ${agent.state.run.generation}`
                                  : "No run"}
                              </small>
                            </div>
                            <div className="ad-execution-cell">
                              <span>{agent.state.run?.effectiveModel ?? "Not reported"}</span>
                              <small>
                                {agent.desiredModel
                                  ? `Configured: ${agent.desiredModel}`
                                  : "Provider default"}
                              </small>
                            </div>
                            <div className="ad-prompt-cell">
                              <span>{agent.role?.name ?? "Unassigned"}</span>
                              <small>
                                {agent.sourceCount} prompt sources
                                <ChevronRight size={12} aria-hidden="true" />
                              </small>
                            </div>
                          </button>
                          {organize && management && (
                            <div className="entity-organize-actions">
                              {[-1, 1].map((direction) => {
                                const ordered = Object.entries(
                                  config.groups[agent.member.groupId]?.agents ?? {},
                                ).sort(
                                  (left, right) => (left[1].order ?? 0) - (right[1].order ?? 0),
                                );
                                const index = ordered.findIndex(
                                  ([, item]) => item.memberId === agent.member.memberId,
                                );
                                return (
                                  <button
                                    key={direction}
                                    type="button"
                                    className="icon-button"
                                    aria-label={`Move ${agent.member.alias} ${direction < 0 ? "up" : "down"}`}
                                    disabled={
                                      index + direction < 0 || index + direction >= ordered.length
                                    }
                                    onClick={async () => {
                                      const ids = ordered.map(([id]) => id);
                                      [ids[index], ids[index + direction]] = [
                                        ids[index + direction]!,
                                        ids[index]!,
                                      ];
                                      try {
                                        await management.client.reorderAgents(
                                          agent.member.groupId,
                                          {
                                            agentIds: ids,
                                            expectedOrderRevision: snapshot.orderRevision,
                                          },
                                        );
                                        await management.refresh();
                                      } catch (cause) {
                                        setOrderError(
                                          toPortalError(cause, "Unable to reorder agents"),
                                        );
                                      }
                                    }}
                                  >
                                    {direction < 0 ? (
                                      <ArrowUp size={14} />
                                    ) : (
                                      <ArrowDown size={14} />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            );
          })}
          {filtered.length === 0 && (
            <div className="ad-empty">
              <Search size={24} aria-hidden="true" />
              <strong>
                {entries.length === 0 ? "No agents configured" : "No matching agents"}
              </strong>
              {query && (
                <button type="button" className="compact-button" onClick={() => setQuery("")}>
                  Clear search
                </button>
              )}
            </div>
          )}
          <footer className="ad-directory-footer">
            <Label icon={FileCode2}>Versioned config</Label>
            <span>Integration + role + agent</span>
            <Label icon={FolderGit2}>Local state</Label>
            <span>Team workspace binding</span>
          </footer>
        </section>
        {selected && (
          <AgentInspector
            key={`${selected.member.groupId}:${selected.member.id}`}
            entry={selected}
            headingRef={inspectorHeading}
            onNavigate={onNavigate}
            onClose={() => {
              setSelection(undefined);
              rowButtons.current.get(selected.member.id)?.focus();
            }}
          />
        )}
      </div>
      {creating && management && (
        <EntityCreateDialog
          kind="agent"
          {...(groupId && snapshot.groups.find((group) => group.id === groupId)
            ? { group: snapshot.groups.find((group) => group.id === groupId)! }
            : {})}
          onClose={() => setCreating(false)}
        />
      )}
    </article>
  );
}
