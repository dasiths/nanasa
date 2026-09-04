import type {
  BrowserRestartFrame,
  ConfigStatus,
  ControlMetadata,
  CustomLaunchConsentRequest,
  Group,
  GroupMembership,
  NanasaConfig,
  PortalSnapshot,
  ProviderStateBinding,
  RemoteDescriptor,
  ServiceDescriptor,
  TerminalCheckpoint,
} from "@nanasa/contracts";
import { Bell, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PortalClient } from "../api.js";
import {
  type ActionAttentionItem,
  ATTENTION_CATEGORY_LABELS,
  type AttentionItem,
  attentionItemsForScope,
  deriveAttentionItems,
} from "../attention-items.js";
import { CheckoutWorkspace } from "../components/checkout-workspace.js";
import { ExtensionsWorkspace } from "../components/extensions-workspace.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
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
  attentionWorkspaceErrors?: ReadonlyMap<string, PortalError>;
  onNavigate(path: string): void;
  onRefresh(): Promise<void>;
  onReloadAttentionWorkspace?(groupId: string): Promise<void>;
  onApproveLaunchConsent?(request: CustomLaunchConsentRequest): Promise<void>;
  onDismissAttentionItems(itemIds: readonly string[]): Promise<boolean>;
  onOpenRoleSettings(): void;
  onPatchPreferences(next: Partial<PortalPreferences>): void;
}

function actionStateLabel(state: string): string {
  const label = state.replaceAll("-", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function actionDisplayState(item: ActionAttentionItem): string {
  if (item.action.error?.code === "agent_prompt_stalled") return "Delivery unconfirmed";
  return actionStateLabel(item.action.state);
}

function actionErrorMessage(item: ActionAttentionItem): string | undefined {
  const error = item.action.error;
  if (error?.code === "agent_prompt_stalled") {
    return `Nanasa sent this prompt to ${item.label}, but could not confirm that the agent received it. The prompt may still have run.`;
  }
  return error?.message;
}

function actionKindLabel(kind: string): string {
  const label = kind.replaceAll("-", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

type AttentionInboxView = "needs" | "active" | "history" | "all";

function attentionInboxView(item: AttentionItem): Exclude<AttentionInboxView, "all"> {
  if (item.counted) return "needs";
  if (item.kind === "action" && item.active) return "active";
  return "history";
}

function attentionDestination(item: AttentionItem): { label: string; path: string } {
  if (item.kind === "delivery" || item.kind === "unread") {
    return { label: "Open messages", path: item.targetPath };
  }
  if (item.kind === "launch-consent") {
    return { label: "Review consent", path: item.targetPath };
  }
  if (item.kind === "provider-update") {
    return { label: "Open setup", path: item.targetPath };
  }
  if ((item.kind === "wait" || item.kind === "action") && item.runId !== undefined) {
    return {
      label: "Open terminal",
      path: `/groups/${encodeURIComponent(item.groupId)}/terminals/${encodeURIComponent(item.runId)}`,
    };
  }
  return { label: "Open terminal", path: item.targetPath };
}

function attentionStateLabel(item: AttentionItem): string {
  switch (item.kind) {
    case "launch-consent":
      return item.consentState === "pending" ? "Approval required" : "Denied";
    case "wait":
      return "Response required";
    case "response":
      return item.responseType === "approval" ? "Approval required" : "Input required";
    case "health":
      return item.healthType === "stuck"
        ? "Stuck"
        : item.healthType === "failed"
          ? "Failed"
          : "Needs help";
    case "completion":
      return "Ready";
    case "delivery":
      return "Delivery failed";
    case "action":
      return actionDisplayState(item);
    case "provider-update":
      return "Restarted";
    case "unread":
      return "Unread";
  }
}

function attentionItemTimestamp(item: AttentionItem): string | undefined {
  switch (item.kind) {
    case "launch-consent":
      return item.request.requestedAt;
    case "wait":
      return item.wait.updatedAt;
    case "response":
    case "health":
    case "completion":
      return item.status?.observedAt;
    case "action":
      return item.action.updatedAt;
    case "provider-update":
      return item.run.providerUpdate?.updatedAt;
    case "delivery":
    case "unread":
      return undefined;
  }
}

function formatAttentionTime(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function AttentionPanel({
  route,
  snapshot,
  group,
  attentionItems,
  attentionWorkspaceLoading,
  attentionWorkspaceErrors,
  onNavigate,
  onReloadAttentionWorkspace,
  onDismissAttentionItems,
  preferences,
  onPatchPreferences,
}: Pick<
  PortalRoutePanelProps,
  | "route"
  | "snapshot"
  | "group"
  | "attentionItems"
  | "attentionWorkspaceLoading"
  | "attentionWorkspaceErrors"
  | "onNavigate"
  | "onReloadAttentionWorkspace"
  | "onDismissAttentionItems"
  | "preferences"
  | "onPatchPreferences"
>) {
  const [view, setView] = useState<AttentionInboxView>("needs");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | AttentionItem["category"]>("all");
  const routeTeamFilter = route.kind === "group" ? route.groupId : "all";
  const [teamFilter, setTeamFilter] = useState(routeTeamFilter);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const allItems = attentionItems ?? deriveAttentionItems(snapshot);
  const scope =
    route.kind === "group"
      ? ({ kind: "group", groupId: route.groupId } as const)
      : ({ kind: "repository" } as const);
  const scopedItems = attentionItemsForScope(allItems, scope);
  const relevantGroupIds =
    scope.kind === "group" ? [scope.groupId] : snapshot.groups.map((item) => item.id);
  const loading = relevantGroupIds.filter((groupId) => attentionWorkspaceLoading?.has(groupId));
  const failures = relevantGroupIds.flatMap((groupId) => {
    const error = attentionWorkspaceErrors?.get(groupId);
    return error === undefined ? [] : [{ groupId, error }];
  });
  const views: Array<{ id: AttentionInboxView; label: string; count: number }> = [
    {
      id: "needs",
      label: "Needs action",
      count: scopedItems.filter((item) => item.counted).length,
    },
    {
      id: "active",
      label: "Active",
      count: scopedItems.filter((item) => item.kind === "action" && item.active).length,
    },
    {
      id: "history",
      label: "History",
      count: scopedItems.filter((item) => attentionInboxView(item) === "history").length,
    },
    { id: "all", label: "All", count: scopedItems.length },
  ];
  const categories = [...new Set(scopedItems.map((item) => item.category))];
  const teams =
    scope.kind === "group"
      ? snapshot.groups.filter((item) => item.id === scope.groupId)
      : [...new Map(scopedItems.map((item) => [item.groupId, item.group])).values()];
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleItems = scopedItems.filter((item) => {
    if (view !== "all" && attentionInboxView(item) !== view) return false;
    if (typeFilter !== "all" && item.category !== typeFilter) return false;
    if (teamFilter !== "all" && item.groupId !== teamFilter) return false;
    if (normalizedSearch.length === 0) return true;
    return [
      item.title,
      item.summary,
      item.label,
      item.group.name,
      ATTENTION_CATEGORY_LABELS[item.category],
      attentionStateLabel(item),
    ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch));
  });
  const selectedItems = scopedItems.filter((item) => selectedIds.has(item.id));

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    if (!fragment.startsWith("wait-") && !fragment.startsWith("action-")) return;
    const target = scopedItems.find((item) => item.targetPath.split("#")[1] === fragment);
    if (target === undefined) return;
    if (target.kind !== "wait" && target.kind !== "action") return;
    const targetView = attentionInboxView(target);
    if (
      view !== targetView ||
      search !== "" ||
      typeFilter !== "all" ||
      teamFilter !== routeTeamFilter
    ) {
      setView(targetView);
      setSearch("");
      setTypeFilter("all");
      setTeamFilter(routeTeamFilter);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(fragment);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView?.({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [routeTeamFilter, scopedItems, search, teamFilter, typeFilter, view]);

  useEffect(() => {
    setTeamFilter(routeTeamFilter);
  }, [routeTeamFilter]);

  useEffect(() => {
    const currentIds = new Set(scopedItems.map((item) => item.id));
    setSelectedIds((current) => {
      const retained = new Set([...current].filter((id) => currentIds.has(id)));
      return retained.size === current.size ? current : retained;
    });
  }, [scopedItems]);

  const reload = (groupId: string) => onReloadAttentionWorkspace?.(groupId) ?? Promise.resolve();
  const dismissAttentionItems = async (items: readonly AttentionItem[]) => {
    const persisted = await onDismissAttentionItems(items.map(({ id }) => id));
    if (!persisted) return false;
    const providerUpdateIds = items.flatMap((item) => {
      if (item.kind !== "provider-update") return [];
      const updateId = item.run.providerUpdate?.id;
      return updateId === undefined ? [] : [updateId];
    });
    if (providerUpdateIds.length > 0) {
      onPatchPreferences({
        dismissedProviderUpdateIds: [
          ...new Set([...(preferences.dismissedProviderUpdateIds ?? []), ...providerUpdateIds]),
        ].slice(-100),
      });
    }
    return true;
  };
  const dismissSelected = async () => {
    if (await dismissAttentionItems(selectedItems)) setSelectedIds(new Set());
  };
  return (
    <RouteSurface
      title="Attention"
      eyebrow={group?.name ?? "Global operations"}
      description="Your subscribed inbox for agent requests, progress, completions, delivery issues, and updates."
    >
      <div className="attention-filters" role="group" aria-label="Attention inbox views">
        {views.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={view === item.id}
            onClick={() => setView(item.id)}
          >
            {item.label} <span>{item.count}</span>
          </button>
        ))}
      </div>
      <div className="attention-inbox-toolbar">
        <label className="attention-search">
          <span>Search</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Attention"
          />
        </label>
        <label>
          <span>Type</span>
          <select
            aria-label="Filter by type"
            value={typeFilter}
            onChange={(event) =>
              setTypeFilter(event.target.value as "all" | AttentionItem["category"])
            }
          >
            <option value="all">All types</option>
            {categories.map((category) => (
              <option value={category} key={category}>
                {ATTENTION_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Team</span>
          <select
            aria-label="Filter by team"
            value={teamFilter}
            disabled={scope.kind === "group"}
            onChange={(event) => setTeamFilter(event.target.value)}
          >
            {scope.kind === "repository" && <option value="all">All teams</option>}
            {teams.map((team) => (
              <option value={team.id} key={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selectedItems.length > 0 && (
        <div className="attention-selection" role="group" aria-label="Selected Attention items">
          <strong>{selectedItems.length} selected</strong>
          <div>
            <button type="button" onClick={() => void dismissSelected()}>
              <X aria-hidden="true" size={14} />
              Dismiss selected
            </button>
            <button type="button" onClick={() => setSelectedIds(new Set())}>
              Clear selection
            </button>
          </div>
        </div>
      )}
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
                {snapshot.groups.find((candidate) => candidate.id === groupId)?.name ?? groupId}
              </span>
              <ErrorNotice error={error} className="attention-workspace-error" />
              <button type="button" onClick={() => void reload(groupId)}>
                Retry
              </button>
            </div>
          ))}
        </section>
      )}
      {visibleItems.length === 0 ? (
        <Empty text="No Attention items match this view." />
      ) : (
        <ul className="attention-inbox-list">
          {visibleItems.map((item) => {
            const fragment = item.targetPath.split("#")[1];
            const destination = attentionDestination(item);
            const timestamp = attentionItemTimestamp(item);
            const diagnostic = item.kind === "action" ? actionErrorMessage(item) : undefined;
            return (
              <li
                className={`attention-inbox-row attention-${attentionInboxView(item)}`}
                id={fragment}
                key={item.id}
                tabIndex={fragment === undefined ? undefined : -1}
              >
                <label className="attention-row-select">
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.title}`}
                    checked={selectedIds.has(item.id)}
                    onChange={(event) => {
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      });
                    }}
                  />
                </label>
                <span className="attention-state-indicator" aria-hidden="true" />
                <div className="attention-inbox-main">
                  <div className="attention-inbox-title">
                    <strong>{item.title}</strong>
                    <span className="attention-state-badge">{attentionStateLabel(item)}</span>
                  </div>
                  <small className="attention-inbox-meta">
                    <span>{item.group.name}</span>
                    <span>{ATTENTION_CATEGORY_LABELS[item.category]}</span>
                    {item.kind === "action" && <span>{actionKindLabel(item.action.kind)}</span>}
                    {timestamp !== undefined && (
                      <time dateTime={timestamp}>{formatAttentionTime(timestamp)}</time>
                    )}
                  </small>
                  <p>{item.summary}</p>
                  {item.kind === "action" && diagnostic !== undefined && (
                    <p
                      className="attention-diagnostic"
                      title={
                        item.action.error === undefined
                          ? undefined
                          : `Diagnostic code: ${item.action.error.code}`
                      }
                    >
                      {diagnostic}
                      {item.action.error !== undefined && <code>{item.action.error.code}</code>}
                    </p>
                  )}
                </div>
                <div className="attention-item-actions">
                  <button type="button" onClick={() => onNavigate(destination.path)}>
                    {destination.label}
                  </button>
                  <button
                    type="button"
                    aria-label={`Dismiss ${item.title}`}
                    onClick={() => void dismissAttentionItems([item])}
                  >
                    <X aria-hidden="true" size={14} />
                    Dismiss
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
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
  const [error, setError] = useState<PortalError>();
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
      (cause: unknown) => setError(toPortalError(cause, "Unable to load diagnostics")),
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
      {error !== undefined && <ErrorNotice error={error} className="route-error" />}
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
  onOpenRoleSettings,
  onPatchPreferences,
}: Pick<PortalRoutePanelProps, "preferences" | "onOpenRoleSettings" | "onPatchPreferences">) {
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | "unsupported"
  >(() => (!("Notification" in window) ? "unsupported" : Notification.permission));
  const setNotification = (key: keyof PortalPreferences["notifications"], value: boolean) =>
    onPatchPreferences({ notifications: { ...preferences.notifications, [key]: value } });
  const requestNotifications = async () => {
    if (preferences.notifications.desktop) {
      setNotification("desktop", false);
      return;
    }
    if (!("Notification" in window) || Notification.permission === "denied") return;
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    setNotification("desktop", permission === "granted");
  };
  const notificationStatus =
    notificationPermission === "unsupported"
      ? "Unsupported"
      : notificationPermission === "denied"
        ? "Blocked"
        : preferences.notifications.desktop && notificationPermission === "granted"
          ? "On"
          : notificationPermission === "default"
            ? "Permission required"
            : "Off";
  const testNotification = () => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    new Notification("Nanasa browser notifications", {
      body: "Subscribed Attention items can appear here while the portal is open.",
      silent: true,
    });
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
          <button type="button" onClick={onOpenRoleSettings}>
            Edit role presentation
          </button>
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
          <p>Subscribed Attention items always show a temporary in-app toast.</p>
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
          <p role="status">Browser notifications: {notificationStatus}</p>
          <button
            type="button"
            disabled={!preferences.notifications.desktop || notificationPermission !== "granted"}
            onClick={testNotification}
          >
            Send test notification
          </button>
          <small>Keep a Nanasa portal tab open to receive browser notifications.</small>
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
  const [error, setError] = useState<PortalError>();
  useEffect(() => {
    void client
      .loadServiceStatus()
      .then(setService, (cause: unknown) =>
        setError(toPortalError(cause, "Unable to load service status")),
      );
  }, [client]);
  return (
    <RouteSurface
      title="Service"
      eyebrow="Project-local systemd user service"
      description="The daemon restarts independently while tmux-owned agent processes continue running."
    >
      {error !== undefined && <ErrorNotice error={error} className="route-error" />}
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
  const [error, setError] = useState<PortalError>();
  useEffect(() => {
    void client
      .loadRemoteStatus()
      .then(setRemote, (cause: unknown) =>
        setError(toPortalError(cause, "Unable to load remote status")),
      );
  }, [client]);
  return (
    <RouteSurface
      title="Remote access"
      eyebrow="OpenSSH loopback forwarding"
      description="Remote operation keeps every daemon and terminal listener on loopback."
    >
      {error !== undefined && <ErrorNotice error={error} className="route-error" />}
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
          title="Providers"
          eyebrow="Provider capabilities"
          description="Set up agent providers and resolve the issues preventing them from running."
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
          onOpenRoleSettings={props.onOpenRoleSettings}
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
