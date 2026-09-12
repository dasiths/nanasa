import {
  type ForemanChannelMessage,
  type ForemanConfig,
  ForemanConfigSchema,
  type ForemanConversationRequest,
  type ForemanRun,
  type ForemanWorkspace as ForemanState,
  type Group,
  type NanasaConfig,
  type SendForemanMessageCommand,
} from "@nanasa/contracts";
import {
  Bot,
  Check,
  ListChecks,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  Settings,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
import { type ThemePreference, useAppliedTheme } from "../hooks/use-portal-preferences.js";
import { useTerminalEndpoint } from "../hooks/use-terminal-endpoint.js";
import { TerminalConsole } from "../terminal/terminal-console.js";
import { CommunicationWorkspace } from "./communication-workspace.js";
import { ForemanGoals } from "./foreman-goals.js";
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
        <legend>Goal Limits</legend>
        <label>
          Concurrent goals
          <input
            type="number"
            min={1}
            max={16}
            required
            value={draft.autonomy.maxActiveGoals}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: { ...draft.autonomy, maxActiveGoals: Number(event.target.value) },
              })
            }
          />
        </label>
        <label>
          Teams per goal
          <input
            type="number"
            min={1}
            max={16}
            required
            value={draft.autonomy.maxTeamsPerGoal}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: { ...draft.autonomy, maxTeamsPerGoal: Number(event.target.value) },
              })
            }
          />
        </label>
        <label>
          Intervention mode
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
          Goal hours
          <input
            type="number"
            min={1}
            max={168}
            required
            value={draft.autonomy.maxGoalHours}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: { ...draft.autonomy, maxGoalHours: Number(event.target.value) },
              })
            }
          />
        </label>
        <label>
          Concurrent actions per goal
          <input
            type="number"
            min={1}
            max={32}
            required
            value={draft.autonomy.maxConcurrentActions}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: { ...draft.autonomy, maxConcurrentActions: Number(event.target.value) },
              })
            }
          />
        </label>
        <label>
          Foreman review budget
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
        <label className="foreman-checkbox">
          <input
            type="checkbox"
            disabled={draft.autonomy.mode !== "bounded"}
            checked={draft.autonomy.intervention.idlePrompt}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: {
                  ...draft.autonomy,
                  intervention: {
                    ...draft.autonomy.intervention,
                    idlePrompt: event.target.checked,
                  },
                },
              })
            }
          />
          Allow idle lead check-ins
        </label>
        <label className="foreman-checkbox">
          <input
            type="checkbox"
            disabled={draft.autonomy.mode !== "bounded"}
            checked={draft.autonomy.recovery.restartDelegatedAgents}
            onChange={(event) =>
              setDraft({
                ...draft,
                autonomy: {
                  ...draft.autonomy,
                  recovery: {
                    ...draft.autonomy.recovery,
                    restartDelegatedAgents: event.target.checked,
                  },
                },
              })
            }
          />
          Recover failed delegated agents
        </label>
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
  const [conversations, setConversations] = useState<ForemanConversationRequest[]>([]);
  const [tab, setTab] = useState<"channel" | "terminal" | "goals" | "settings">("channel");
  const [teamId, setTeamId] = useState(initialTeamId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError>();
  const [refresh, setRefresh] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const cursor = useRef(0);
  const theme = useAppliedTheme(themePreference);
  const contextMissing = teamId !== "" && !groups.some((group) => group.id === teamId);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [next, page, requests] = await Promise.all([
          client.loadForeman(),
          client.loadForemanChannel(cursor.current),
          client.loadForemanConversations(),
        ]);
        if (cancelled) return;
        setState(next);
        setConversations(requests);
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
  const send = async (command: SendForemanMessageCommand) => {
    const message = await client.sendForemanMessage(command);
    setMessages((current) =>
      [...new Map([...current, message].map((entry) => [entry.id, entry])).values()]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-500),
    );
    setRefresh((value) => value + 1);
    return message;
  };
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
            ["goals", "Goals", ListChecks],
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
              const tabs = ["channel", "terminal", "goals", "settings"] as const;
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
      {state?.inbox
        ?.filter(
          (item) =>
            item.state === "ambiguous" ||
            (item.state === "submitted" && Date.now() - Date.parse(item.updatedAt) > 60000),
        )
        .map((item) => {
          const request = conversations.find((entry) => entry.id === item.conversationRequestId);
          const member =
            request === undefined
              ? undefined
              : Object.values(config.groups[request.groupId]?.agents ?? {}).find(
                  (agent) => agent.memberId === request.memberId,
                );
          const source =
            item.kind === "human-message"
              ? "Your channel message"
              : item.kind === "conversation-result"
                ? `Member result${request === undefined ? " notification" : `: ${member?.name ?? request.memberId}`}`
                : "Coordination notification";
          const previousRun =
            item.submittedRunId !== undefined && item.submittedRunId !== state.run?.id;
          const preview =
            messages.find((message) => message.id === item.messageId)?.text.slice(0, 500) ??
            item.preview;
          return (
            <div key={item.id} className="foreman-inbox-notice" role="alert">
              <h3>Foreman updates are paused</h3>
              <p>
                <strong>{source}</strong>:{" "}
                {item.state === "ambiguous"
                  ? "delivery could not be confirmed."
                  : "sent, but not acknowledged by Foreman."}
              </p>
              <p className="foreman-inbox-meta">
                {item.submittedGeneration !== undefined && (
                  <span>
                    Foreman run {item.submittedGeneration}
                    {previousRun ? " (previous run)" : ""}
                  </span>
                )}
                <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString()}</time>
              </p>
              <p>
                New reply notifications are queued behind this item. Neither action below resends
                input or undoes work.
              </p>
              <details>
                <summary>View blocked input</summary>
                <p className="foreman-inbox-preview">{preview}</p>
                <code>{item.conversationRequestId ?? item.messageId ?? item.id}</code>
              </details>
              <div className="foreman-toolbar">
                <button
                  className="compact-button"
                  disabled={state.run === undefined}
                  onClick={() => setTab("terminal")}
                >
                  <Terminal size={14} aria-hidden="true" />
                  Review terminal
                </button>
                <button
                  className="compact-button"
                  disabled={busy}
                  title="Confirm you checked Foreman's response and this item is handled"
                  onClick={() =>
                    void operate(() =>
                      client.resolveForemanInput({
                        inboxId: item.id,
                        expectedState: item.state === "ambiguous" ? "ambiguous" : "submitted",
                        resolution: "handled",
                      }),
                    )
                  }
                >
                  <Check size={14} aria-hidden="true" />
                  Mark handled
                </button>
                <button
                  className="compact-button"
                  disabled={busy}
                  title="Stop waiting for this item without marking it handled or sending it again"
                  onClick={() =>
                    void operate(() =>
                      client.resolveForemanInput({
                        inboxId: item.id,
                        expectedState: item.state === "ambiguous" ? "ambiguous" : "submitted",
                        resolution: "cancel",
                      }),
                    )
                  }
                >
                  <X size={14} aria-hidden="true" />
                  Dismiss without resend
                </button>
              </div>
            </div>
          );
        })}
      {contextMissing && <p role="alert">The selected team is unavailable.</p>}
      {
        <div
          id="foreman-channel"
          hidden={tab !== "channel"}
          role="tabpanel"
          aria-labelledby="foreman-tab-channel"
          className="foreman-channel"
        >
          <CommunicationWorkspace
            client={client}
            config={config}
            groups={groups}
            messages={messages}
            requests={conversations}
            inbox={state?.inbox ?? []}
            teamId={teamId}
            onTeamChange={setTeamId}
            hasMore={hasMore}
            onLoadMore={() => setRefresh((value) => value + 1)}
            onSendForeman={send}
            onCancelRequest={(id) => operate(() => client.cancelForemanConversation(id))}
            onNavigate={onNavigate}
          />
        </div>
      }
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
      {tab === "goals" && (
        <div id="foreman-goals" role="tabpanel" aria-labelledby="foreman-tab-goals">
          <ForemanGoals client={client} configuration={state?.configuration} />
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
