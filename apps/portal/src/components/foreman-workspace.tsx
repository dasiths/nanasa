import {
  type ForemanChannelMessage,
  type ForemanConfig,
  ForemanConfigSchema,
  type ForemanRun,
  type ForemanWorkspace as ForemanState,
  type Group,
  type NanasaConfig,
  type SendForemanMessageCommand,
} from "@nanasa/contracts";
import {
  ArrowLeft,
  Bot,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  Send,
  Settings,
  Square,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
import { type ThemePreference, useAppliedTheme } from "../hooks/use-portal-preferences.js";
import { useTerminalEndpoint } from "../hooks/use-terminal-endpoint.js";
import { TerminalConsole } from "../terminal/terminal-console.js";
import "./foreman-workspace.css";

function ForemanTerminal({
  run,
  client,
  theme,
}: {
  run: ForemanRun;
  client: PortalClient;
  theme: "light" | "dark";
}) {
  const endpoint = useTerminalEndpoint(client, run.id, `${run.generation}:${run.status}`);
  if (endpoint.error !== undefined) return <ErrorNotice error={endpoint.error} />;
  if (endpoint.status?.state !== "ready")
    return (
      <p role="status">{run.status === "stopped" ? "Foreman is stopped" : "Terminal connecting"}</p>
    );
  return (
    <div className="foreman-terminal terminal-pane terminal-pane-ready">
      <TerminalConsole
        client={client}
        endpoint={endpoint.status}
        runGeneration={run.generation}
        theme={theme}
        label="Foreman terminal"
      />
    </div>
  );
}

function ForemanSettings({
  configuration,
  config,
  busy,
  onSave,
}: {
  configuration: ForemanConfig | undefined;
  config: NanasaConfig;
  busy: boolean;
  onSave(value: ForemanConfig): void;
}) {
  const [draft, setDraft] = useState(
    () =>
      configuration ??
      ForemanConfigSchema.parse({
        integrationId: Object.keys(config.integrations)[0] ?? "unconfigured",
      }),
  );
  const [instructions, setInstructions] = useState(draft.instructions.join("\n"));
  const [validation, setValidation] = useState<string>();
  return (
    <form
      className="foreman-settings"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = ForemanConfigSchema.safeParse({
          ...draft,
          instructions: instructions
            .split("\n")
            .map((path) => path.trim())
            .filter(Boolean),
        });
        if (!parsed.success) {
          setValidation(parsed.error.issues.map((issue) => issue.message).join("; "));
          return;
        }
        setValidation(undefined);
        onSave(parsed.data);
      }}
    >
      {validation !== undefined && <p role="alert">{validation}</p>}
      <fieldset disabled={busy}>
        <legend>Runtime</legend>
        <label>
          Name
          <input
            required
            maxLength={100}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label>
          Provider
          <select
            required
            value={draft.integrationId}
            onChange={(event) => setDraft({ ...draft, integrationId: event.target.value })}
          >
            {Object.entries(config.integrations).map(([id, integration]) => (
              <option key={id} value={id}>
                {integration.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <input
            maxLength={256}
            value={draft.desiredModel ?? ""}
            placeholder="Provider default"
            onChange={(event) =>
              setDraft({ ...draft, desiredModel: event.target.value || undefined })
            }
          />
        </label>
        <label className="foreman-checkbox">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          Enabled
        </label>
        <label className="foreman-wide">
          Instruction paths
          <textarea
            rows={3}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Mission Limits</legend>
        <label>
          Autonomy
          <select
            value={draft.autonomy.mode}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: {
                  ...draft.autonomy,
                  mode: event.target.value as "supervised" | "bounded",
                },
              })
            }
          >
            <option value="supervised">Supervised</option>
            <option value="bounded">Bounded</option>
          </select>
        </label>
        <label>
          Mission hours
          <input
            type="number"
            min={1}
            max={168}
            required
            value={draft.autonomy.maxMissionHours}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: { ...draft.autonomy, maxMissionHours: Number(event.target.value) },
              })
            }
          />
        </label>
        <label>
          Concurrent tasks
          <input
            type="number"
            min={1}
            max={32}
            required
            value={draft.autonomy.maxConcurrentTasks}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: { ...draft.autonomy, maxConcurrentTasks: Number(event.target.value) },
              })
            }
          />
        </label>
        <label>
          Foreman turns
          <input
            type="number"
            min={1}
            max={10000}
            required
            value={draft.autonomy.maxForemanTurns}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: { ...draft.autonomy, maxForemanTurns: Number(event.target.value) },
              })
            }
          />
        </label>
        <div className="foreman-wide">
          <span>Approved team templates</span>
          {Object.keys(config.teamTemplates ?? {}).length === 0 ? (
            <p>No team templates configured</p>
          ) : (
            Object.keys(config.teamTemplates ?? {}).map((id) => (
              <label key={id} className="foreman-checkbox">
                <input
                  type="checkbox"
                  checked={draft.autonomy.permittedTeamTemplates.includes(id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      autonomy: {
                        ...draft.autonomy,
                        permittedTeamTemplates: event.target.checked
                          ? [...draft.autonomy.permittedTeamTemplates, id]
                          : draft.autonomy.permittedTeamTemplates.filter((value) => value !== id),
                      },
                    })
                  }
                />
                {id}
              </label>
            ))
          )}
        </div>
      </fieldset>
      <button
        className="primary-button"
        type="submit"
        disabled={busy || Object.keys(config.integrations).length === 0}
      >
        <Save size={15} aria-hidden="true" /> Save settings
      </button>
    </form>
  );
}

export function ForemanWorkspace({
  client,
  config,
  groups,
  themePreference,
  initialTeamId = "",
  onNavigate,
}: {
  client: PortalClient;
  config: NanasaConfig;
  groups: Group[];
  themePreference: ThemePreference;
  initialTeamId?: string;
  onNavigate(path: string): void;
}) {
  const [state, setState] = useState<ForemanState>();
  const [messages, setMessages] = useState<ForemanChannelMessage[]>([]);
  const [tab, setTab] = useState<"channel" | "terminal" | "settings">("channel");
  const [text, setText] = useState("");
  const [teamId, setTeamId] = useState(initialTeamId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError>();
  const [refresh, setRefresh] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const cursor = useRef(0);
  const retry = useRef<SendForemanMessageCommand | undefined>(undefined);
  const theme = useAppliedTheme(themePreference);
  const contextMissing = teamId !== "" && !groups.some((group) => group.id === teamId);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [next, page] = await Promise.all([
          client.loadForeman(),
          client.loadForemanChannel(cursor.current),
        ]);
        if (cancelled) return;
        setState(next);
        setMessages((current) =>
          [
            ...new Map(
              [...current, ...page.messages].map((message) => [message.id, message]),
            ).values(),
          ]
            .sort((left, right) => left.sequence - right.sequence)
            .slice(-500),
        );
        cursor.current = page.nextAfter;
        setHasMore(page.hasMore);
      } catch (cause) {
        if (!cancelled) setError(toPortalError(cause, "Unable to refresh Foreman"));
      } finally {
        if (!cancelled) timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, refresh]);
  const operate = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(toPortalError(cause, "Foreman operation failed"));
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    operate(async () => {
      const prior = retry.current;
      const command =
        prior?.text === text && prior.teamId === (teamId || undefined)
          ? prior
          : { requestId: crypto.randomUUID(), text, ...(teamId === "" ? {} : { teamId }) };
      retry.current = command;
      await client.sendForemanMessage(command);
      retry.current = undefined;
      setText("");
    });
  const running =
    state?.run !== undefined && ["starting", "running", "stopping"].includes(state.run.status);
  return (
    <section className="foreman-workspace" aria-label="Repository Foreman">
      <header className="foreman-toolbar">
        <div>
          <span className="eyebrow">Repository coordination</span>
          <h2>
            <Bot size={22} aria-hidden="true" />
            {state?.configuration?.name ?? "Foreman"}
          </h2>
        </div>
        <span className="foreman-runtime-state" role="status">
          {state === undefined
            ? "Loading"
            : state.configuration === undefined
              ? "Not configured"
              : (state.run?.status ?? "Stopped")}
        </span>
        <div className="foreman-toolbar-actions">
          <button
            className="icon-button"
            title="Refresh Foreman"
            aria-label="Refresh Foreman"
            onClick={() => {
              setError(undefined);
              setRefresh((value) => value + 1);
            }}
          >
            <RefreshCw size={16} />
          </button>
          {running && state?.run !== undefined ? (
            <button
              className="compact-button"
              disabled={busy}
              onClick={() =>
                void operate(() =>
                  client.stopForeman({ runId: state.run!.id, generation: state.run!.generation }),
                )
              }
            >
              <Square size={15} aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button
              className="compact-button"
              disabled={
                busy || state?.configuration?.enabled !== true || state.configRevision === undefined
              }
              onClick={() =>
                void operate(() =>
                  client.startForeman({
                    expectedConfigRevision: state!.configRevision!,
                    cols: 120,
                    rows: 36,
                  }),
                )
              }
            >
              <Play size={15} aria-hidden="true" />
              Start
            </button>
          )}
        </div>
      </header>
      <div className="foreman-view-tabs" role="tablist" aria-label="Foreman views">
        {(
          [
            ["channel", "Channel", MessageSquare],
            ["terminal", "Terminal", Terminal],
            ["settings", "Settings", Settings],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            tabIndex={tab === id ? 0 : -1}
            aria-selected={tab === id}
            aria-controls={`foreman-${id}`}
            id={`foreman-tab-${id}`}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const tabs = ["channel", "terminal", "settings"] as const;
              const index = tabs.indexOf(id);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              setTab(tabs[next]!);
              const buttons =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              buttons?.[next]?.focus();
            }}
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      {error !== undefined && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {state?.problem !== undefined && <p role="alert">{state.problem}</p>}
      {contextMissing && <p role="alert">The selected team is unavailable.</p>}
      {tab === "channel" && (
        <div
          id="foreman-channel"
          role="tabpanel"
          aria-labelledby="foreman-tab-channel"
          className="foreman-channel"
        >
          <div className="foreman-context">
            <label>
              Context
              <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
                <option value="">Repository</option>
                {contextMissing && <option value={teamId}>Unavailable team</option>}
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            {teamId !== "" && !contextMissing && (
              <button
                className="compact-button"
                onClick={() => onNavigate(`/groups/${encodeURIComponent(teamId)}/messages`)}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                Back to team
              </button>
            )}
          </div>
          <div className="foreman-conversation" aria-label="Foreman channel messages">
            {messages.length === 0 && <p className="foreman-empty">No messages yet</p>}
            {messages.map((message) => (
              <article
                className={`foreman-message foreman-message-${message.sender.kind}`}
                key={message.id}
              >
                <header>
                  <strong>{message.sender.kind === "operator" ? "You" : "Foreman"}</strong>
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  {message.teamId && (
                    <span>
                      {groups.find((group) => group.id === message.teamId)?.name ??
                        "Unavailable team"}
                    </span>
                  )}
                </header>
                <p>{message.text}</p>
                <small>
                  {message.sender.kind === "foreman"
                    ? "Reply"
                    : messages.some(
                          (reply) =>
                            reply.replyTo === message.id && reply.sender.kind === "foreman",
                        )
                      ? "Replied"
                      : "Stored in channel"}
                </small>
              </article>
            ))}
          </div>
          {hasMore && (
            <button onClick={() => setRefresh((value) => value + 1)}>Load more messages</button>
          )}
          <form
            className="foreman-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor="foreman-message">
              Message Foreman
            </label>
            <textarea
              id="foreman-message"
              rows={3}
              value={text}
              maxLength={32768}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              placeholder="Message Foreman"
            />
            <button
              className="primary-button"
              type="submit"
              disabled={
                busy ||
                contextMissing ||
                text.trim().length === 0 ||
                new TextEncoder().encode(text).length > 32768
              }
            >
              <Send size={16} aria-hidden="true" />
              Send
            </button>
          </form>
        </div>
      )}
      {tab === "terminal" && (
        <div
          id="foreman-terminal"
          role="tabpanel"
          aria-labelledby="foreman-tab-terminal"
          className="foreman-terminal-view"
        >
          {running && state?.run !== undefined ? (
            <ForemanTerminal key={state.run.id} client={client} run={state.run} theme={theme} />
          ) : (
            <p className="foreman-empty">Foreman is not running</p>
          )}
        </div>
      )}
      {tab === "settings" && (
        <div id="foreman-settings" role="tabpanel" aria-labelledby="foreman-tab-settings">
          {state !== undefined && (
            <ForemanSettings
              key={state.configRevision}
              configuration={state.configuration}
              config={config}
              busy={busy || running}
              onSave={(configuration) =>
                void operate(() =>
                  client.configureForeman({
                    configuration,
                    expectedConfigRevision: state.configRevision!,
                  }),
                )
              }
            />
          )}
        </div>
      )}
    </section>
  );
}
