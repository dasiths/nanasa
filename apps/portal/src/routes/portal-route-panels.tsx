import type {
  BrowserRestartFrame,
  ConfigStatus,
  ControlMetadata,
  Group,
  GroupMembership,
  NanasaConfig,
  PortalSnapshot,
  ProviderStateBinding,
  RemoteDescriptor,
  ServiceDescriptor,
  TerminalCheckpoint,
} from "@nanasa/contracts";
import { Bell, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { PortalClient } from "../api.js";
import {
  ATTENTION_CATEGORY_LABELS,
  attentionCategoryCount,
  attentionItemsForScope,
  attentionReviewCount,
  deriveAttentionItems,
  type ActionAttentionItem,
  type AttentionItem,
  type AttentionReviewCategory,
  type CompletionAttentionItem,
  type WaitAttentionItem,
} from "../attention-items.js";
import { CheckoutWorkspace } from "../components/checkout-workspace.js";
import { ExtensionsWorkspace } from "../components/extensions-workspace.js";
import { generatedOfflineHelp } from "../help/generated-offline-help.js";
import type { PortalPreferences } from "../hooks/use-portal-preferences.js";
import { memberStatusView } from "../member-status.js";
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
  attentionItems?: readonly AttentionItem[];
  attentionWorkspaceLoading?: ReadonlySet<string>;
  attentionWorkspaceErrors?: ReadonlyMap<string, string>;
  onNavigate(path: string): void;
  onRefresh(): Promise<void>;
  onReloadAttentionWorkspace?(groupId: string): Promise<void>;
  onPatchPreferences(next: Partial<PortalPreferences>): void;
}

const cancellableStates = new Set(["created", "deferred"]);

function WaitReply({
  item,
  client,
  onChanged,
}: {
  item: WaitAttentionItem;
  client: PortalClient;
  onChanged(): Promise<void>;
}) {
  const { wait } = item;
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (reply: Parameters<PortalClient["replyOpenWait"]>[1]["reply"]) => {
    setBusy(true);
    setError(undefined);
    try {
      await client.replyOpenWait(wait.id, {
        expectedRunId: wait.runId,
        expectedGeneration: wait.generation,
        expectedReporterEpoch: wait.reporterEpoch,
        expectedStatusRevision: wait.openedStatusRevision,
        reply,
      });
      setSubmitted(true);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send the exact wait reply");
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || submitted || wait.state === "replying";
  return (
    <div className="attention-control-stack">
      {wait.kind === "permission" ? (
        <div className="workflow-actions">
          <button type="button" disabled={disabled} onClick={() => void submit({ kind: "deny" })}>
            Deny
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void submit({ kind: "allow-once" })}
          >
            Allow once
          </button>
        </div>
      ) : wait.kind === "plan_approval" ? (
        <div className="workflow-actions">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void submit({ kind: "reject-plan" })}
          >
            Reject
          </button>
          <button
            type="button"
            disabled={disabled}
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
            disabled={disabled}
            required
          />
          <button type="submit" disabled={disabled || answer.trim().length === 0}>
            Reply
          </button>
        </form>
      )}
      {(submitted || wait.state === "replying") && (
        <small role="status">Reply submitted. Waiting for the reporter to close this wait.</small>
      )}
      {error !== undefined && <small role="alert">{error}</small>}
    </div>
  );
}

function CompletionControls({
  item,
  client,
  onNavigate,
  onRefresh,
  onAcknowledged,
}: {
  item: CompletionAttentionItem;
  client: PortalClient;
  onNavigate(path: string): void;
  onRefresh(): Promise<void>;
  onAcknowledged(item: CompletionAttentionItem): void;
}) {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const acknowledge = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.acknowledgeCompletion(item.groupId, item.memberId);
      setSubmitted(true);
      onAcknowledged(item);
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to acknowledge completion");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="attention-control-stack">
      <div className="workflow-actions">
        <button type="button" disabled={busy || submitted} onClick={() => void acknowledge()}>
          {submitted ? "Acknowledged" : "Acknowledge"}
        </button>
        <button type="button" onClick={() => onNavigate(item.targetPath)}>
          Open agent
        </button>
      </div>
      {error !== undefined && <small role="alert">{error}</small>}
    </div>
  );
}

function ActionControls({
  item,
  client,
  onChanged,
}: {
  item: ActionAttentionItem;
  client: PortalClient;
  onChanged(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.cancelAgentAction(item.action.id);
      setSubmitted(true);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to cancel this action");
    } finally {
      setBusy(false);
    }
  };
  if (!cancellableStates.has(item.action.state)) return null;
  return (
    <div className="attention-control-stack">
      <button type="button" disabled={busy || submitted} onClick={() => void cancel()}>
        {submitted ? "Cancellation requested" : "Cancel"}
      </button>
      {error !== undefined && <small role="alert">{error}</small>}
    </div>
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
      title="Overview"
      eyebrow={group.name}
      description="Models, recovery state, and retention policy for this group."
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
  route,
  snapshot,
  group,
  client,
  attentionItems,
  attentionWorkspaceLoading,
  attentionWorkspaceErrors,
  onNavigate,
  onRefresh,
  onReloadAttentionWorkspace,
}: Pick<
  PortalRoutePanelProps,
  | "route"
  | "snapshot"
  | "group"
  | "client"
  | "attentionItems"
  | "attentionWorkspaceLoading"
  | "attentionWorkspaceErrors"
  | "onNavigate"
  | "onRefresh"
  | "onReloadAttentionWorkspace"
>) {
  const [filter, setFilter] = useState<"all" | AttentionReviewCategory>("all");
  const [suppressedCompletionIds, setSuppressedCompletionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [completionAnnouncement, setCompletionAnnouncement] = useState<{
    itemId: string;
    message: string;
  }>();
  const allItems = attentionItems ?? deriveAttentionItems(snapshot);
  const scope =
    route.kind === "group"
      ? ({ kind: "group", groupId: route.groupId } as const)
      : ({ kind: "repository" } as const);
  const scopedItems = attentionItemsForScope(allItems, scope).filter(
    (item) => item.kind !== "completion" || !suppressedCompletionIds.has(item.id),
  );
  const reviewItems = scopedItems.filter(
    (item) => item.counted && (filter === "all" || item.category === filter),
  );
  const progressItems = scopedItems.filter(
    (item): item is ActionAttentionItem => item.kind === "action",
  );
  const activeProgressCount = progressItems.filter((item) => item.active).length;
  const relevantGroupIds =
    scope.kind === "group" ? [scope.groupId] : snapshot.groups.map((item) => item.id);
  const loading = relevantGroupIds.filter((groupId) => attentionWorkspaceLoading?.has(groupId));
  const failures = relevantGroupIds.flatMap((groupId) => {
    const error = attentionWorkspaceErrors?.get(groupId);
    return error === undefined ? [] : [{ groupId, error }];
  });
  const filters: Array<{ id: "all" | AttentionReviewCategory; label: string; count: number }> = [
    { id: "all", label: "All", count: attentionReviewCount(scopedItems) },
    ...(["response", "health", "completion", "delivery"] as const).map((category) => ({
      id: category,
      label: ATTENTION_CATEGORY_LABELS[category],
      count: attentionCategoryCount(scopedItems, category),
    })),
  ];

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    if (!fragment.startsWith("wait-") && !fragment.startsWith("action-")) return;
    const target = scopedItems.find((item) => item.targetPath.split("#")[1] === fragment);
    if (target === undefined) return;
    if (target.kind !== "wait" && target.kind !== "action") return;
    if (target.kind === "wait" && filter !== target.category) {
      setFilter(target.category);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(fragment);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView?.({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [filter, scopedItems]);

  const reload = (groupId: string) => onReloadAttentionWorkspace?.(groupId) ?? Promise.resolve();
  return (
    <RouteSurface
      title="Attention"
      eyebrow={group?.name ?? "Global operations"}
      description="Review responses, agent health, completed work, and failed deliveries. Durable action progress remains visible without inflating the review count."
    >
      <p
        key={completionAnnouncement?.itemId}
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {completionAnnouncement?.message ?? ""}
      </p>
      <div className="attention-filters" role="group" aria-label="Attention category filters">
        {filters.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label} <span>{item.count}</span>
          </button>
        ))}
      </div>
      {loading.length > 0 && (
        <p className="attention-loading" role="status">
          Loading exact waits and action progress for {loading.length}{" "}
          {loading.length === 1 ? "group" : "groups"}...
        </p>
      )}
      {failures.length > 0 && (
        <section className="attention-partial-error" aria-label="Unavailable Attention details">
          <strong>Some exact waits and progress could not be loaded.</strong>
          {failures.map(({ groupId, error }) => (
            <div key={groupId}>
              <span>
                {snapshot.groups.find((candidate) => candidate.id === groupId)?.name ?? groupId}:{" "}
                {error}
              </span>
              <button type="button" onClick={() => void reload(groupId)}>
                Retry
              </button>
            </div>
          ))}
        </section>
      )}
      <section className="attention-review-section" aria-labelledby="attention-review-heading">
        <h3 id="attention-review-heading">Review items</h3>
        {reviewItems.length === 0 ? (
          <Empty text="No review items match this category." />
        ) : (
          <ul className="workflow-list attention-list">
            {reviewItems.map((item) => {
              const fragment = item.targetPath.split("#")[1];
              return (
                <li
                  className={`workflow-row attention-item attention-${item.category}`}
                  id={fragment}
                  key={item.id}
                  tabIndex={fragment === undefined ? undefined : -1}
                >
                  <div className="attention-item-main">
                    <strong>{item.title}</strong>
                    <small>
                      {item.group.name} · {ATTENTION_CATEGORY_LABELS[item.category]}
                    </small>
                    <p>{item.summary}</p>
                  </div>
                  {item.kind === "wait" ? (
                    <WaitReply item={item} client={client} onChanged={() => reload(item.groupId)} />
                  ) : item.kind === "completion" ? (
                    <CompletionControls
                      item={item}
                      client={client}
                      onNavigate={onNavigate}
                      onRefresh={onRefresh}
                      onAcknowledged={(completion) => {
                        setSuppressedCompletionIds(
                          (current) => new Set([...current, completion.id]),
                        );
                        setCompletionAnnouncement({
                          itemId: completion.id,
                          message: `Completion acknowledged for ${completion.label}.`,
                        });
                      }}
                    />
                  ) : (
                    <button type="button" onClick={() => onNavigate(item.targetPath)}>
                      {item.kind === "delivery" ? "Open Messages" : "Open terminal"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section
        className="workflow-card attention-progress"
        aria-labelledby="attention-progress-heading"
      >
        <div className="attention-section-heading">
          <h3 id="attention-progress-heading">Progress</h3>
          {activeProgressCount > 0 && (
            <span className="progress-count">
              {activeProgressCount} active {activeProgressCount === 1 ? "action" : "actions"}
            </span>
          )}
        </div>
        {progressItems.length === 0 ? (
          <p>No durable actions have been created in this scope.</p>
        ) : (
          <ul className="workflow-list">
            {progressItems.map((item) => {
              const fragment = item.targetPath.split("#")[1];
              return (
                <li className="workflow-row progress-row" id={fragment} key={item.id} tabIndex={-1}>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.group.name} · {item.attempts.length} attempts ·{" "}
                      {item.acknowledgements.length} acknowledgements · {item.action.id}
                    </small>
                  </div>
                  <ActionControls
                    item={item}
                    client={client}
                    onChanged={() => reload(item.groupId)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </RouteSurface>
  );
}

function AgentDirectory({
  snapshot,
  onNavigate,
}: Pick<PortalRoutePanelProps, "snapshot" | "onNavigate">) {
  return (
    <RouteSurface
      title="All agents"
      eyebrow="Global directory"
      description="All configured agents, provider models, and projected status across groups."
    >
      <ul className="workflow-list">
        {snapshot.memberships
          .filter((member) => member.state === "active")
          .map((member) => {
            const status = memberStatusView(snapshot.agentStatuses, snapshot.runs, member);
            const { run } = status;
            return (
              <li className="workflow-row" key={member.id}>
                <div>
                  <strong>{member.alias}</strong>
                  <small>
                    {status.label} · {run?.effectiveModel ?? "provider model pending"}
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
    if (preferences.notifications.desktop) {
      setNotification("desktop", false);
      return;
    }
    if (!("Notification" in window)) return;
    const permission = await Notification.requestPermission();
    setNotification("desktop", permission === "granted");
  };
  return (
    <RouteSurface
      title="Preferences"
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
              ? "Disable desktop notifications"
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

function ServicePanel({ client }: Pick<PortalRoutePanelProps, "client">) {
  const [service, setService] = useState<ServiceDescriptor>();
  const [restart, setRestart] = useState<BrowserRestartFrame>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void client
      .loadServiceStatus()
      .then(setService, (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Unable to load service status"),
      );
  }, [client]);
  return (
    <RouteSurface
      title="Service"
      eyebrow="Project-local systemd user service"
      description="The daemon restarts independently while tmux-owned agent processes continue running."
    >
      {error !== undefined && (
        <p className="route-error" role="alert">
          {error}
        </p>
      )}
      <section className="workflow-card">
        <h3>{service?.state ?? "loading"}</h3>
        <p>{service?.detail ?? "Reading service health."}</p>
        <dl>
          <div>
            <dt>Unit</dt>
            <dd>{service?.unitName ?? "loading"}</dd>
          </div>
          <div>
            <dt>Process policy</dt>
            <dd>KillMode={service?.killMode ?? "process"}</dd>
          </div>
          <div>
            <dt>Continuity</dt>
            <dd>tmux processes survive; terminal WebSockets reconnect</dd>
          </div>
          <div>
            <dt>Last activation</dt>
            <dd>
              {service?.lastActivation === undefined
                ? "No recorded upgrade or rollback"
                : `${service.lastActivation.state}: ${service.lastActivation.from.packageVersion} to ${service.lastActivation.to.packageVersion}`}
            </dd>
          </div>
        </dl>
        <button
          type="button"
          onClick={() => void client.planServiceRestart("operator-restart").then(setRestart)}
        >
          Preview planned restart
        </button>
        {restart !== undefined && (
          <p role="status">
            Reconnect in {restart.retryAfterMs} ms, resnapshot required, PTY handoff disabled.
          </p>
        )}
      </section>
    </RouteSurface>
  );
}

function RemotePanel({ client }: Pick<PortalRoutePanelProps, "client">) {
  const [remote, setRemote] = useState<RemoteDescriptor>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void client
      .loadRemoteStatus()
      .then(setRemote, (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Unable to load remote status"),
      );
  }, [client]);
  return (
    <RouteSurface
      title="Remote access"
      eyebrow="OpenSSH loopback forwarding"
      description="Remote operation keeps every daemon and terminal listener on loopback."
    >
      {error !== undefined && (
        <p className="route-error" role="alert">
          {error}
        </p>
      )}
      <section className="workflow-card">
        <h3>{remote?.service.state ?? "loading"}</h3>
        <p>No browser-managed tunnel is active. Start a verified tunnel from the operator CLI.</p>
        <dl>
          <div>
            <dt>Repository</dt>
            <dd>{remote?.repositoryId ?? "loading"}</dd>
          </div>
          <div>
            <dt>Build</dt>
            <dd>{remote?.build.packageVersion ?? "loading"}</dd>
          </div>
          <div>
            <dt>Service</dt>
            <dd>{remote?.service.unitName ?? "loading"}</dd>
          </div>
          <div>
            <dt>Authentication</dt>
            <dd>OpenSSH configuration and agent</dd>
          </div>
          <div>
            <dt>Forwarding</dt>
            <dd>Local loopback to remote loopback only</dd>
          </div>
          <div>
            <dt>Reconnect</dt>
            <dd>Restore the tunnel, then reload and resnapshot</dd>
          </div>
        </dl>
        <p>Direct portal exposure, multi-user tenancy, and distributed runners are unsupported.</p>
      </section>
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
    if (route.section === "activity") return <AttentionPanel {...props} group={group} />;
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
      return <AttentionPanel {...props} />;
    case "agents":
      return <AgentDirectory snapshot={props.snapshot} onNavigate={props.onNavigate} />;
    case "checkouts":
      return (
        <RouteSurface
          title="Checkouts"
          eyebrow="Git workspaces"
          description="Create, open, assign, inspect, and provenance-check managed worktrees."
        >
          <CheckoutWorkspace
            client={props.client}
            snapshot={props.snapshot}
            config={props.config}
            onChanged={props.onRefresh}
          />
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
          title="About Nanasa"
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
    case "service":
      return <ServicePanel client={props.client} />;
    case "remote":
      return <RemotePanel client={props.client} />;
  }
}
