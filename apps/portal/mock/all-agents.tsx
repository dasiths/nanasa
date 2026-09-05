import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileCode2,
  FolderGit2,
  GitBranch,
  KeyRound,
  Layers,
  LockKeyhole,
  Moon,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import "@fontsource/ibm-plex-sans-condensed/400.css";
import "@fontsource/ibm-plex-sans-condensed/500.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "./all-agents.css";

type TeamId = "backend" | "frontend";
type Agent = {
  id: string;
  name: string;
  team: TeamId;
  provider: string;
  integration: string;
  role: string;
  readOnly: boolean;
};
const teams = {
  backend: {
    name: "Backend Team",
    branch: "feat/team-workspaces",
    path: "/workspaces/nanasa",
    kind: "Primary",
    instruction: "agent-team.md",
  },
  frontend: {
    name: "Frontend Team",
    branch: "feature/frontend",
    path: "/workspaces/.nanasa-worktrees/nanasa/feature-frontend",
    kind: "Linked",
    instruction: "frontend-team.md",
  },
};
const agents: Agent[] = [
  {
    id: "agent_318f514e-2347-4d87-8c64-aef0752e7bfb",
    name: "Project Manager",
    team: "backend",
    provider: "GitHub Copilot",
    integration: "copilot",
    role: "Project Manager",
    readOnly: false,
  },
  {
    id: "agent_0ae65cd2-985d-498c-9399-0978bae77827",
    name: "Engineer 1",
    team: "backend",
    provider: "Pi",
    integration: "pi",
    role: "Implementor",
    readOnly: false,
  },
  {
    id: "agent_e0f1b592-5fb2-4fe2-93e4-ac9da40dedf1",
    name: "Engineer 2",
    team: "backend",
    provider: "Claude Code",
    integration: "claude-copilot",
    role: "Implementor",
    readOnly: false,
  },
  {
    id: "agent_9e2cdefb-cc96-4b4e-865f-b4ac17f6c4f9",
    name: "Reviewer",
    team: "backend",
    provider: "OpenCode",
    integration: "opencode",
    role: "Reviewer",
    readOnly: true,
  },
  {
    id: "frontend-builder",
    name: "Frontend Engineer",
    team: "frontend",
    provider: "Pi",
    integration: "pi",
    role: "Implementor",
    readOnly: false,
  },
  {
    id: "frontend-reviewer",
    name: "Frontend Reviewer",
    team: "frontend",
    provider: "OpenCode",
    integration: "opencode",
    role: "Reviewer",
    readOnly: true,
  },
];
const sampleSuffix = "examples/multi-coding-agents";

function IconLabel({
  icon: Icon,
  children,
  className = "",
}: {
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`icon-label ${className}`}>
      <Icon size={14} aria-hidden="true" />
      {children}
    </span>
  );
}

function Help({ text }: { text: string }) {
  return (
    <span className="help" tabIndex={0} aria-label={text}>
      <CircleHelp size={12} aria-hidden="true" />
      <span role="tooltip">{text}</span>
    </span>
  );
}

function Field({ label, value, source }: { label: string; value: ReactNode; source?: string }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>
        {value}
        {source && <small>{source}</small>}
      </dd>
    </div>
  );
}

function PromptLayers({ agent }: { agent: Agent }) {
  const roleFile =
    agent.role === "Project Manager"
      ? "project-manager"
      : agent.readOnly
        ? "reviewer"
        : "implementor";
  const layers = [
    {
      name: "Built-in",
      source: "Nanasa",
      files: ["builtin:nanasa-coordination-v1", "builtin:nanasa-assignment-v1"],
    },
    {
      name: "Global",
      source: "All agents",
      files: [".nanasa/instructions/nanasa-mcp.md", ".nanasa/instructions/team.md"],
    },
    {
      name: "Team",
      source: teams[agent.team].name,
      files: [`.nanasa/instructions/groups/${teams[agent.team].instruction}`],
    },
    { name: "Role", source: agent.role, files: [`.nanasa/instructions/${roleFile}.md`] },
    { name: "Agent", source: "No additional instructions", files: [] },
  ];
  return (
    <section className="inspector-section">
      <div className="section-title">
        <IconLabel icon={Layers}>Prompt composition</IconLabel>
        <span className="subtle">6 sources</span>
      </div>
      <ol className="prompt-stack">
        {layers.map((layer, index) => (
          <li key={layer.name}>
            <span className="layer-number">{index + 1}</span>
            {layer.files.length ? (
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
              <div className="empty-layer">
                <strong>{layer.name}</strong>
                <span>{layer.source}</span>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Inspector({ agent, onClose }: { agent: Agent; onClose(): void }) {
  const [tab, setTab] = useState("configuration");
  const team = teams[agent.team];
  return (
    <aside className="inspector" aria-label="Agent configuration">
      <header className="inspector-heading">
        <div className={`agent-avatar ${agent.readOnly ? "review" : "build"}`}>
          <Bot size={23} aria-hidden="true" />
        </div>
        <div>
          <span className="eyebrow">{team.name}</span>
          <h2>{agent.name}</h2>
          <span className="subtle">
            {agent.provider} / {agent.role}
          </span>
        </div>
        <button
          className="icon-button close-inspector"
          title="Close inspector"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <nav className="inspector-tabs" aria-label="Agent detail views">
        {["configuration", "prompts"].map((name) => (
          <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>
            {name === "configuration" ? (
              <Settings2 size={14} aria-hidden="true" />
            ) : (
              <Layers size={14} aria-hidden="true" />
            )}
            {name === "configuration" ? "Configuration" : "Prompt layers"}
          </button>
        ))}
      </nav>
      {tab === "configuration" ? (
        <>
          <section className="inspector-section">
            <div className="section-title">
              <IconLabel icon={FolderGit2}>Workspace</IconLabel>
              <span className="source-tag">Team binding</span>
            </div>
            <div className="branch-title">
              <GitBranch size={16} aria-hidden="true" />
              <strong>{team.branch}</strong>
              <span className="type-label">{team.kind}</span>
            </div>
            <code className="path-block">{team.path}</code>
            <dl>
              <Field
                label="Starting folder"
                value={`./${sampleSuffix}`}
                source="Integration cwd: . mapped into team checkout"
              />
            </dl>
          </section>
          <section className="inspector-section">
            <div className="section-title">
              <IconLabel icon={LockKeyhole}>Provider state & credentials</IconLabel>
            </div>
            <dl>
              <Field label="State scope" value="Membership" source="One provider home per agent" />
              <Field
                label="Credentials"
                value="Provider-managed"
                source="No broker profile configured"
              />
              <Field
                label="Provider home"
                value={
                  <code>{`.nanasa/integrations/state/members/${agent.id}/${agent.integration}`}</code>
                }
                source="Relative to the primary sample config root"
              />
            </dl>
          </section>
          <section className="inspector-section">
            <div className="section-title">
              <IconLabel icon={Zap}>Execution policy</IconLabel>
              <span className="source-tag">Integration + role</span>
            </div>
            <dl>
              <Field label="Profile" value={<span className="accent">autonomous</span>} />
              <Field label="Continuation" value="Autonomous" />
              <Field label="Questions" value="Disabled" />
              <Field label="Approval policy" value="Unrestricted" />
              <Field
                label="Role permissions"
                value={
                  agent.readOnly ? (
                    <span className="gold">Read-only</span>
                  ) : (
                    "Inherit provider permissions"
                  )
                }
              />
            </dl>
            {agent.readOnly && (
              <div className="policy-note">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>Read-only role restrictions take precedence over autonomous grants.</span>
              </div>
            )}
          </section>
          <section className="inspector-section">
            <div className="section-title">
              <IconLabel icon={Braces}>Model & recovery</IconLabel>
            </div>
            <dl>
              <Field
                label="Model"
                value="Provider default"
                source="No agent or integration model override"
              />
              <Field label="Session recovery" value="Resume or restart" />
              <Field label="Model on resume" value="Preserve session" />
              <Field label="MCP messaging" value="Team-scoped" />
            </dl>
          </section>
        </>
      ) : (
        <>
          <PromptLayers agent={agent} />
          <section className="inspector-section">
            <div className="section-title">
              <IconLabel icon={FileCode2}>Provider configuration</IconLabel>
            </div>
            <dl>
              <Field
                label="MCP source"
                value={
                  <code>{`.nanasa/providers/${agent.integration === "claude-copilot" ? "claude-code" : agent.integration}/mcp.json`}</code>
                }
                source="Integration-owned provider file; separate from prompt layers"
              />
            </dl>
          </section>
        </>
      )}
      <footer className="inspector-footer">
        <code>{agent.id}</code>
        <span>Read-only preview</span>
      </footer>
    </aside>
  );
}

function App() {
  const [groupBy, setGroupBy] = useState("team");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | undefined>("frontend-reviewer");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [theme, setTheme] = useState("dark");
  const selected = agents.find((agent) => agent.id === selection);
  const inspect = (agentId: string) => {
    setSelection(agentId);
    if (window.matchMedia("(max-width: 960px)").matches) {
      requestAnimationFrame(() => {
        document
          .querySelector(".inspector")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };
  const filtered = agents.filter((agent) =>
    `${agent.name} ${agent.provider} ${agent.role} ${teams[agent.team].name} ${teams[agent.team].branch}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const groups = Map.groupBy(filtered, (agent) =>
    groupBy === "team" ? agent.team : groupBy === "provider" ? agent.provider : "all",
  );
  return (
    <div className="mock-app" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Layers size={20} aria-hidden="true" />
          </span>
          nanasa
          <span className="divider" />
          <span className="breadcrumb">All agents</span>
        </div>
        <div className="preview-controls">
          <span className="preview-label">Design preview / sample data</span>
          <button
            className="icon-button"
            aria-label="Toggle theme"
            title="Toggle theme"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </header>
      <main>
        <header className="page-heading">
          <div>
            <div className="eyebrow">Repository configuration</div>
            <h1>All agents</h1>
            <div className="config-source">
              <FileCode2 size={13} aria-hidden="true" />
              <code>examples/multi-coding-agents/.nanasa/config.yaml</code>
            </div>
          </div>
          <div className="totals">
            <span>
              <b>6</b> agents
            </span>
            <span>
              <b>2</b> teams
            </span>
            <span>
              <b>4</b> providers
            </span>
          </div>
        </header>
        <div className="toolbar">
          <label className="search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search agents"
              placeholder="Search agents, providers, branches..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="group-control">
            <Users size={14} aria-hidden="true" />
            <span>Group by</span>
            <select
              aria-label="Group by"
              value={groupBy}
              onChange={(event) => {
                setGroupBy(event.target.value);
                setCollapsed([]);
              }}
            >
              <option value="team">Team</option>
              <option value="provider">Provider</option>
              <option value="none">None</option>
            </select>
          </label>
          <span className="result-count">{filtered.length} of 6 agents</span>
        </div>
        <div className={`directory-layout ${selected ? "has-inspector" : ""}`}>
          <section className="directory" aria-label="Configured agents">
            <div className="column-head">
              <span>Agent / provider</span>
              <span>
                State scope{" "}
                <Help text="Membership keeps each agent's provider files separate. Integration shares a provider home." />
              </span>
              <span>
                Execution{" "}
                <Help text="Configured profile and role restrictions, not live activity or authentication status." />
              </span>
              <span>
                Prompts{" "}
                <Help text="Sources compose in order: built-in, global, team, role, agent." />
              </span>
            </div>
            {[...groups].map(([key, members]) => {
              const team = groupBy === "team" ? teams[key as TeamId] : undefined;
              const closed = collapsed.includes(key);
              return (
                <section
                  key={key}
                  className="team-section"
                  aria-label={team?.name ?? (key === "all" ? "All configured agents" : key)}
                >
                  <button
                    className="group-heading"
                    aria-expanded={!closed}
                    onClick={() =>
                      setCollapsed(
                        closed ? collapsed.filter((item) => item !== key) : [...collapsed, key],
                      )
                    }
                  >
                    <ChevronDown className={closed ? "rotated" : ""} size={16} aria-hidden="true" />
                    <Users size={16} aria-hidden="true" />
                    <strong>{team?.name ?? (key === "all" ? "All configured agents" : key)}</strong>
                    <span className="group-count">{members.length}</span>
                    {team && (
                      <>
                        <span className={`workspace-type ${key}`}>
                          <FolderGit2 size={12} aria-hidden="true" />
                          {team.kind} workspace
                        </span>
                        <span className="group-branch">
                          <GitBranch size={13} aria-hidden="true" />
                          {team.branch}
                        </span>
                      </>
                    )}
                  </button>
                  {!closed && (
                    <>
                      {team && (
                        <div className="team-path">
                          <code>{team.path}</code>
                          <span>
                            {key === "frontend" ? "Exclusive to this team" : "Shareable checkout"}
                          </span>
                        </div>
                      )}
                      {members.map((agent) => (
                        <button
                          key={agent.id}
                          className={`agent-row ${agent.id === selection ? "selected" : ""}`}
                          aria-label={`Inspect ${agent.name}`}
                          aria-pressed={agent.id === selection}
                          onClick={() => inspect(agent.id)}
                        >
                          <div className="agent-identity">
                            <span
                              className={`agent-avatar ${agent.readOnly ? "review" : agent.role === "Project Manager" ? "manage" : "build"}`}
                            >
                              {agent.readOnly ? (
                                <ShieldCheck size={17} />
                              ) : agent.role === "Project Manager" ? (
                                <Users size={17} />
                              ) : (
                                <Bot size={17} />
                              )}
                            </span>
                            <div>
                              <strong>{agent.name}</strong>
                              <small>
                                {agent.provider}
                                <span className="dot">/</span>
                                {agent.role}
                              </small>
                            </div>
                          </div>
                          <div className="scope-cell">
                            <IconLabel icon={LockKeyhole}>Membership</IconLabel>
                            <small>Provider-managed auth</small>
                          </div>
                          <div className="execution-cell">
                            <IconLabel icon={Zap} className="accent">
                              Autonomous
                            </IconLabel>
                            <small className={agent.readOnly ? "gold" : ""}>
                              {agent.readOnly ? "Read-only role" : "Permissions inherited"}
                            </small>
                          </div>
                          <div className="prompt-cell">
                            <IconLabel icon={Layers}>4 layers</IconLabel>
                            <small>
                              6 sources
                              <ChevronRight size={12} aria-hidden="true" />
                            </small>
                          </div>
                        </button>
                      ))}
                    </>
                  )}
                </section>
              );
            })}
            {filtered.length === 0 && (
              <div className="no-results">
                <Search size={23} aria-hidden="true" />
                <strong>No matching agents</strong>
                <button onClick={() => setQuery("")}>Clear search</button>
              </div>
            )}
            <footer className="directory-footer">
              <KeyRound size={13} aria-hidden="true" />
              <span>Credential mode: provider-managed</span>
              <span className="footer-separator" /> <Activity size={13} aria-hidden="true" />
              <span>Configured values, not live status</span>
            </footer>
            <div className="source-legend">
              <IconLabel icon={FileCode2}>Versioned config</IconLabel>
              <ArrowRight size={13} aria-hidden="true" />
              <span>Integration + role + agent</span>
              <span className="legend-separator" />
              <IconLabel icon={FolderGit2}>Local state</IconLabel>
              <ArrowRight size={13} aria-hidden="true" />
              <span>Team workspace binding</span>
            </div>
          </section>
          {selected && (
            <Inspector key={selected.id} agent={selected} onClose={() => setSelection(undefined)} />
          )}
        </div>
        <footer className="preview-footer">
          Static design mock. Workspace bindings are illustrative. No daemon connection or
          configuration writes.
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
