import {
  type AgentRun,
  type AttentionEventType,
  type AttentionSubscriptionsSnapshot,
  type Group,
  InstructionPathSchema,
  type NanasaConfig,
  type PortalSnapshot,
  type UpdateGroupAgentCommand,
} from "@nanasa/contracts";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  GitBranch,
  ListFilter,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Dialog } from "../a11y/primitives.js";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
import { memberStatusView } from "../member-status.js";
import { groupRoute } from "../router/portal-router.js";
import type { AgentDirectoryEntry } from "./agent-directory-model.js";
import { EntityInspector, EntitySection } from "./entity-inspector.js";

export type EntityManagement = {
  client: PortalClient;
  snapshot: PortalSnapshot;
  config: NanasaConfig;
  subscriptions?: AttentionSubscriptionsSnapshot;
  refresh(): Promise<void>;
  navigate(path: string): void;
  start(groupId: string, agentId: string): Promise<void>;
  stop(groupId: string, agentId: string): Promise<void>;
  recover(groupId: string, agentId: string, force: boolean): Promise<void>;
  setSubscription(
    groupId: string,
    memberId: string,
    event: AttentionEventType,
    enabled: boolean,
  ): Promise<void>;
  resetSubscriptions(groupId: string, memberId: string): Promise<void>;
  createTeam(name: string, instructions: string[]): Promise<void>;
  deleteTeam(groupId: string): Promise<void>;
  busy?: boolean;
};
export const EntityManagementContext = createContext<EntityManagement | undefined>(undefined);
export function useEntityManagement() {
  return useContext(EntityManagementContext);
}

type Fields = {
  name: string;
  integrationId: string;
  roleId: string;
  instructions: string;
  groupId: string;
};
export function EntityEditor({
  kind,
  group,
  entry,
  onClose,
}: {
  kind: "team" | "agent";
  group?: Group;
  entry?: AgentDirectoryEntry;
  onClose(): void;
}) {
  const management = useEntityManagement()!;
  const { client, config, snapshot, refresh } = management;
  const [values, setValues] = useState<Fields>({
    name: entry?.agent?.name ?? (kind === "team" ? group?.name : "") ?? "",
    integrationId: entry?.agent?.integrationId ?? Object.keys(config.integrations)[0] ?? "",
    roleId: entry?.member.roleId ?? "",
    instructions: (
      entry?.agent?.instructions ??
      (kind === "team" && group ? config.groups[group.id]?.instructions : []) ??
      []
    ).join("\n"),
    groupId: group?.id ?? entry?.member.groupId ?? snapshot.groups[0]?.id ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError>();
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [leaveTarget, setLeaveTarget] = useState<HTMLElement>();
  const [leaveDialog, setLeaveDialog] = useState(false);
  const discardApproved = useRef(false);
  useEffect(() => {
    const intercept = (event: MouseEvent) => {
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>("a,button") : null;
      if (
        !target ||
        formRef.current?.contains(target) ||
        target.closest(".entity-discard-dialog") ||
        discardApproved.current
      )
        return;
      if (!dirty && !busy) return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      setLeaveTarget(target);
      setLeaveDialog(true);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || leaveDialog) return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      if (dirty) {
        setLeaveTarget(undefined);
        setLeaveDialog(true);
      } else onClose();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || busy) event.preventDefault();
    };
    document.addEventListener("click", intercept, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      document.removeEventListener("click", intercept, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty, busy, leaveDialog, onClose]);
  const change = (key: keyof Fields, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };
  return (
    <>
      <form
        ref={formRef}
        className="entity-edit-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (inFlight.current) return;
          inFlight.current = true;
          setBusy(true);
          setError(undefined);
          try {
            const instructions = values.instructions
              .split("\n")
              .map((path) => path.trim())
              .filter(Boolean)
              .map((path) => InstructionPathSchema.parse(path));
            if (kind === "team") {
              if (group)
                await client.updateGroup(group.id, {
                  ...(values.name !== group.name ? { name: values.name } : {}),
                  ...(JSON.stringify(instructions) !==
                  JSON.stringify(config.groups[group.id]?.instructions ?? [])
                    ? { instructions }
                    : {}),
                });
              else await management.createTeam(values.name, instructions);
            } else if (entry) {
              const agentId = Object.entries(
                config.groups[entry.member.groupId]?.agents ?? {},
              ).find(([, agent]) => agent.memberId === entry.member.memberId)?.[0];
              if (!agentId) throw new Error("Agent configuration is no longer available");
              await client.updateAgent(entry.member.groupId, agentId, {
                ...(values.name !== entry.agent?.name ? { name: values.name } : {}),
                ...(values.integrationId !== entry.agent?.integrationId
                  ? { integrationId: values.integrationId }
                  : {}),
                ...(values.roleId !== (entry.agent?.roleId ?? "")
                  ? { roleId: values.roleId || null }
                  : {}),
                ...(JSON.stringify(instructions) !== JSON.stringify(entry.agent?.instructions ?? [])
                  ? { instructions }
                  : {}),
              } satisfies UpdateGroupAgentCommand);
            } else
              await client.createAgent(values.groupId, {
                name: values.name,
                integrationId: values.integrationId,
                ...(values.roleId ? { roleId: values.roleId } : {}),
                instructions,
              });
            await refresh();
            onClose();
          } catch (cause) {
            setError(toPortalError(cause, "Unable to save configuration"));
          } finally {
            inFlight.current = false;
            setBusy(false);
          }
        }}
      >
        {entry && (
          <section className="entity-inherited">
            <h4>Inherited instruction files</h4>
            <ul>
              {[
                ...config.instructions.map((path) => ({ source: "Global", path })),
                ...(config.groups[entry.member.groupId]?.instructions ?? []).map((path) => ({
                  source: "Group",
                  path,
                })),
                ...(config.roles[values.roleId]?.instructions ?? []).map((path) => ({
                  source: `Role · ${config.roles[values.roleId]?.name ?? values.roleId}`,
                  path,
                })),
              ].map(({ source, path }) => (
                <li key={`${source}:${path}`}>
                  <span>{source}</span>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </section>
        )}
        <label>
          {kind === "team" ? "Group name" : "Name"}
          <input
            autoFocus
            required
            maxLength={100}
            value={values.name}
            onChange={(event) => change("name", event.target.value)}
          />
        </label>
        {kind === "agent" && (
          <>
            <label>
              Team
              <select
                disabled={Boolean(entry || group)}
                value={values.groupId}
                required
                onChange={(event) => change("groupId", event.target.value)}
              >
                {snapshot.groups.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Integration
              <select
                value={values.integrationId}
                onChange={(event) => change("integrationId", event.target.value)}
              >
                {Object.entries(config.integrations).map(([id, integration]) => (
                  <option key={id} value={id}>
                    {integration.name} ({id})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Role
              <select
                value={values.roleId}
                onChange={(event) => change("roleId", event.target.value)}
              >
                <option value="">Unassigned</option>
                {Object.entries(config.roles).map(([id, role]) => (
                  <option key={id} value={id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          {kind === "team" ? "Group instruction files" : "Agent instruction files"}
          <textarea
            rows={3}
            value={values.instructions}
            onChange={(event) => change("instructions", event.target.value)}
          />
        </label>
        {entry && (
          <div className="entity-context-note">
            Inherited instructions remain unchanged. Configuration changes may require a run
            restart.
          </div>
        )}
        {kind === "agent" && !values.instructions.trim() && (
          <small className="entity-context-note">
            No agent-specific instruction files configured
          </small>
        )}
        {error && <ErrorNotice error={error} />}
        {discard && <p role="status">Discard the unsaved changes?</p>}
        <footer>
          <button
            type="button"
            className="compact-button"
            disabled={busy}
            onClick={() => {
              if (dirty && !discard) setDiscard(true);
              else onClose();
            }}
          >
            {discard ? "Discard changes" : "Cancel"}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || (kind === "agent" && !values.groupId)}
          >
            <Check size={14} aria-hidden="true" />
            {busy
              ? "Saving..."
              : entry
                ? "Save agent"
                : kind === "team"
                  ? group
                    ? "Save group"
                    : "Create group"
                  : "Add agent"}
          </button>
        </footer>
      </form>
      {leaveDialog && (
        <Dialog
          open
          labelledBy="discard-draft-title"
          className="entity-create-dialog entity-discard-dialog"
          onClose={() => setLeaveDialog(false)}
        >
          <div className="entity-dialog-content">
            <h2 id="discard-draft-title">Discard unsaved changes?</h2>
            <p>Your configuration has not been saved.</p>
          </div>
          <footer className="entity-dialog-actions">
            <button type="button" className="compact-button" onClick={() => setLeaveDialog(false)}>
              Keep editing
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() => {
                discardApproved.current = true;
                setDirty(false);
                setLeaveDialog(false);
                if (leaveTarget) leaveTarget.click();
                else onClose();
              }}
            >
              Discard changes
            </button>
          </footer>
        </Dialog>
      )}
    </>
  );
}

export function EntityCreateDialog({
  kind,
  group,
  onClose,
}: {
  kind: "team" | "agent";
  group?: Group;
  onClose(): void;
}) {
  return (
    <Dialog
      open
      labelledBy="entity-create-title"
      onClose={onClose}
      className="entity-create-dialog"
    >
      <header className="entity-dialog-heading">
        <span className="eyebrow">{group?.name ?? "Workspace configuration"}</span>
        <h2 id="entity-create-title">{kind === "team" ? "Create group" : "Add agent"}</h2>
      </header>
      <div className="entity-dialog-content">
        <EntityEditor kind={kind} {...(group ? { group } : {})} onClose={onClose} />
      </div>
    </Dialog>
  );
}

export function ImpactDialog({
  title,
  children,
  action,
  onApply,
  onClose,
  danger = false,
}: {
  title: string;
  children: ReactNode;
  action: string;
  onApply(): Promise<unknown>;
  onClose(): void;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError>();
  return (
    <Dialog
      open
      labelledBy="entity-impact-title"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="entity-create-dialog"
    >
      <header className="entity-dialog-heading">
        <span className="eyebrow">Review impact</span>
        <h2 id="entity-impact-title">{title}</h2>
      </header>
      <div className="entity-dialog-content">
        {children}
        {error && <ErrorNotice error={error} />}
      </div>
      <footer className="entity-dialog-actions">
        <button type="button" className="compact-button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={`compact-button ${danger ? "danger-button" : "primary-button"}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await onApply();
              onClose();
            } catch (cause) {
              setError(toPortalError(cause, "Operation failed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Applying..." : action}
        </button>
      </footer>
    </Dialog>
  );
}

export function entityRunAction(run: AgentRun | undefined): "start" | "stop" | "retry" | "none" {
  if (!run) return "start";
  if (run.desiredState === "stopped")
    return run.status === "stopped" || run.status === "failed" ? "start" : "stop";
  if (["running", "starting", "stopping"].includes(run.status)) return "stop";
  if (["reconciling", "resuming", "restarting"].includes(run.recoveryPhase)) return "stop";
  if (
    run.recoveryPhase === "failed" ||
    (run.desiredState === "running" && ["failed", "stopped"].includes(run.status))
  )
    return "retry";
  return "none";
}

export function AgentSessionActions({ entry }: { entry: AgentDirectoryEntry }) {
  const management = useEntityManagement()!;
  const { client, config, snapshot, refresh, start, stop, recover } = management;
  const [pending, setPending] = useState<"stop" | "remove" | "move" | "recover">();
  const [requestedTarget, setTarget] = useState("");
  const destinations = snapshot.groups.filter((group) => group.id !== entry.member.groupId);
  const target =
    destinations.find((group) => group.id === requestedTarget)?.id ?? destinations[0]?.id ?? "";
  const [error, setError] = useState<PortalError>();
  const [busy, setBusy] = useState(false);
  const agentId = Object.entries(config.groups[entry.member.groupId]?.agents ?? {}).find(
    ([, agent]) => agent.memberId === entry.member.memberId,
  )?.[0];
  const runAction = entityRunAction(entry.state.run);
  const active = runAction === "stop";
  const execute = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(toPortalError(cause, "Unable to update agent"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <EntitySection title="Run lifecycle">
        <dl>
          <div>
            <dt>State</dt>
            <dd>{entry.state.label}</dd>
          </div>
          <div>
            <dt>Run</dt>
            <dd>
              <code>{entry.state.run?.id ?? "Not started"}</code>
            </dd>
          </div>
          <div>
            <dt>Generation</dt>
            <dd>{entry.state.run?.generation ?? "None"}</dd>
          </div>
        </dl>
        {error && <ErrorNotice error={error} />}
        <div className="entity-command-stack">
          <button
            className="primary-button"
            type="button"
            disabled={
              busy || management.busy || !["start", "retry"].includes(runAction) || !agentId
            }
            onClick={() => void execute(() => start(entry.member.groupId, agentId!))}
          >
            <Play size={14} aria-hidden="true" />
            {runAction === "retry" ? "Retry start" : "Start agent"}
          </button>
          <button
            className="compact-button"
            type="button"
            disabled={!active || busy}
            onClick={() => setPending("stop")}
          >
            <Square size={14} aria-hidden="true" />
            Stop run
          </button>
          <button
            className="compact-button"
            type="button"
            disabled={!entry.state.run || busy}
            onClick={() => setPending("recover")}
          >
            <RefreshCw size={14} aria-hidden="true" />
            Review recovery
          </button>
        </div>
      </EntitySection>
      <EntitySection title="Membership">
        <div className="entity-command-stack">
          <button
            type="button"
            className="compact-button"
            disabled={Boolean(active) || !target}
            onClick={() => setPending("move")}
          >
            Move to another team
          </button>
          {active && (
            <small className="entity-context-note">Stop the run before moving this agent.</small>
          )}
          <button
            type="button"
            className="compact-button danger-button"
            onClick={() => setPending("remove")}
          >
            <Trash2 size={14} aria-hidden="true" />
            Remove agent
          </button>
        </div>
      </EntitySection>
      {pending && (
        <ImpactDialog
          title={
            pending === "remove"
              ? `Remove ${entry.member.alias}?`
              : pending === "move"
                ? `Move ${entry.member.alias}?`
                : pending === "stop"
                  ? `Stop ${entry.member.alias}?`
                  : `Recover ${entry.member.alias}?`
          }
          action={
            pending === "remove"
              ? "Remove agent"
              : pending === "move"
                ? "Move agent"
                : pending === "stop"
                  ? "Stop run"
                  : "Recover agent"
          }
          danger={pending === "remove" || pending === "stop"}
          onClose={() => setPending(undefined)}
          onApply={async () => {
            if (!agentId) throw new Error("Agent configuration unavailable");
            if (pending === "stop") await stop(entry.member.groupId, agentId);
            else if (pending === "remove") {
              await client.removeAgent(entry.member.groupId, agentId);
              await refresh();
            } else if (pending === "move") {
              if (!target || !destinations.some((group) => group.id === target) || active)
                throw new Error("A stopped agent and current destination team are required");
              await client.reparentAgent(entry.member.groupId, agentId, {
                targetGroupId: target,
                expectedOrderRevision: snapshot.orderRevision,
              });
              await refresh();
            } else await recover(entry.member.groupId, agentId, false);
          }}
        >
          <p>
            {pending === "remove"
              ? "The run will stop, queued deliveries will be revoked, and this agent will be removed from the team. Provider packages remain installed."
              : pending === "move"
                ? "The stopped agent keeps its stable ID and history. Its destination team's workspace and instructions will apply."
                : pending === "stop"
                  ? "The selected run will stop. Its configured membership remains."
                  : "Recovery checks provider setup and ownership. Uncertain ownership is not forced by this action."}
          </p>
          {pending === "move" && (
            <label className="entity-edit-form">
              Target group
              <select value={target} onChange={(event) => setTarget(event.target.value)}>
                {snapshot.groups
                  .filter((group) => group.id !== entry.member.groupId)
                  .map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </ImpactDialog>
      )}
    </>
  );
}

const eventNames: Record<AttentionEventType, string> = {
  "response-required": "Response requests",
  "agent-health": "Agent health",
  completion: "Completions",
  "delivery-failure": "Delivery failures",
  "action-state": "Work progress",
  "provider-update-failed": "Failed provider updates",
  "provider-update-succeeded": "Successful provider updates",
  "unread-message": "Unread messages",
  "url-open-request": "Browser requests",
};
export function AgentAttentionSettings({ entry }: { entry: AgentDirectoryEntry }) {
  const management = useEntityManagement()!;
  const subscription = management.subscriptions?.members.find(
    (item) => item.groupId === entry.member.groupId && item.memberId === entry.member.memberId,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError>();
  const apply = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(toPortalError(cause, "Unable to update subscriptions"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EntitySection title="Attention subscriptions">
      <div className="entity-inline-actions">
        <button
          className="compact-button"
          type="button"
          disabled={busy || !subscription}
          onClick={() =>
            void apply(async () => {
              for (const item of subscription!.subscriptions)
                await management.setSubscription(
                  entry.member.groupId,
                  entry.member.memberId,
                  item.eventType,
                  true,
                );
            })
          }
        >
          Subscribe all
        </button>
        <button
          className="compact-button"
          type="button"
          disabled={busy || !subscription}
          onClick={() =>
            void apply(async () => {
              for (const item of subscription!.subscriptions)
                await management.setSubscription(
                  entry.member.groupId,
                  entry.member.memberId,
                  item.eventType,
                  false,
                );
            })
          }
        >
          Unsubscribe all
        </button>
      </div>
      {subscription?.subscriptions.map((item) => (
        <label className="entity-setting-row" key={item.eventType}>
          <span>
            <strong>{eventNames[item.eventType]}</strong>
            <small>
              {item.source === "operator-override"
                ? "Your override"
                : "Inherited from configuration"}
            </small>
          </span>
          <input
            className="entity-switch"
            type="checkbox"
            role="switch"
            checked={item.enabled}
            disabled={busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              void apply(() =>
                management.setSubscription(
                  entry.member.groupId,
                  entry.member.memberId,
                  item.eventType,
                  enabled,
                ),
              );
            }}
          />
        </label>
      ))}
      <button
        className="compact-button"
        type="button"
        disabled={busy}
        onClick={() =>
          void apply(() =>
            management.resetSubscriptions(entry.member.groupId, entry.member.memberId),
          )
        }
      >
        Reset to inherited settings
      </button>
      {error && <ErrorNotice error={error} />}
    </EntitySection>
  );
}

export function TeamsWorkspace() {
  const management = useEntityManagement()!;
  const { snapshot, config, client, refresh, navigate } = management;
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string>();
  const [create, setCreate] = useState(false);
  const [editing, setEditing] = useState(false);
  const [remove, setRemove] = useState(false);
  const [organize, setOrganize] = useState(false);
  const [error, setError] = useState<PortalError>();
  const selected = snapshot.groups.find((group) => group.id === selection);
  const ordered = [...snapshot.groups].sort((left, right) => left.order - right.order);
  const move = async (group: Group, offset: number) => {
    const ids = ordered.map((item) => item.id);
    const index = ids.indexOf(group.id);
    if (index + offset < 0 || index + offset >= ids.length) return;
    [ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!];
    try {
      await client.reorderGroups({ groupIds: ids, expectedOrderRevision: snapshot.orderRevision });
      await refresh();
    } catch (cause) {
      setError(toPortalError(cause, "Unable to reorder teams"));
    }
  };
  return (
    <article className={`route-surface teams-workspace${selected ? " entity-detail-open" : ""}`}>
      <header className="route-heading">
        <span className="eyebrow">Team directory</span>
        <h2 data-route-heading tabIndex={-1}>
          Teams
        </h2>
        <p>
          {snapshot.groups.length} teams /{" "}
          {snapshot.memberships.filter((member) => member.state === "active").length} configured
          agents
        </p>
      </header>
      <div className="entity-toolbar">
        <label className="entity-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Search teams"
            placeholder="Search teams..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="entity-toolbar-end">
          <button
            className="icon-button"
            type="button"
            aria-label="Organize teams"
            title="Organize teams"
            aria-pressed={organize}
            onClick={() => setOrganize(!organize)}
          >
            <ListFilter size={16} />
          </button>
          <button className="primary-button" type="button" onClick={() => setCreate(true)}>
            <Plus size={15} />
            Create group
          </button>
        </div>
      </div>
      {error && <ErrorNotice error={error} />}
      <div className={`entity-layout${selected ? " has-inspector" : ""}`}>
        <div className="entity-collection">
          <div className="entity-columns team-entity-columns">
            <span>Team / workspace</span>
            <span>Members</span>
            <span>Activity</span>
          </div>
          <ul className="entity-record-list">
            {ordered
              .filter((group) => group.name.toLowerCase().includes(query.toLowerCase()))
              .map((group) => {
                const members = snapshot.memberships.filter(
                  (member) => member.groupId === group.id && member.state === "active",
                );
                const states = members.map((member) =>
                  memberStatusView(snapshot.agentStatuses, snapshot.runs, member),
                );
                const active = states.filter((state) => state.run?.status === "running").length;
                const attention = states.filter((state) => state.attentionWorthy).length;
                const checkout = snapshot.checkouts.find((item) => item.id === group.checkoutId);
                return (
                  <li key={group.id}>
                    <button
                      className="entity-row team-entity-columns"
                      type="button"
                      aria-label={`Inspect team ${group.name}`}
                      aria-pressed={group.id === selection}
                      onClick={() => {
                        setSelection(group.id);
                        setEditing(false);
                      }}
                    >
                      <span className="entity-identity">
                        <span className="entity-glyph">
                          <Users size={19} />
                        </span>
                        <span>
                          <strong>{group.name}</strong>
                          <small>
                            <GitBranch size={12} /> {checkout?.branch ?? "Primary checkout"}
                          </small>
                        </span>
                      </span>
                      <span>{members.length} agents</span>
                      <span
                        className="entity-state-label"
                        data-tone={attention ? "warning" : active ? "ready" : "muted"}
                      >
                        {attention
                          ? `${attention} need attention`
                          : active
                            ? `${active} running`
                            : "No active runs"}
                      </span>
                    </button>
                    {organize && (
                      <div className="entity-organize-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Move group ${group.name} up`}
                          disabled={ordered[0]?.id === group.id}
                          onClick={() => void move(group, -1)}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Move group ${group.name} down`}
                          disabled={ordered.at(-1)?.id === group.id}
                          onClick={() => void move(group, 1)}
                        >
                          <ArrowDown size={14} />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
          {!snapshot.groups.length && (
            <div className="empty-state">
              <h3>No teams yet</h3>
              <button type="button" className="primary-button" onClick={() => setCreate(true)}>
                Create the first group
              </button>
            </div>
          )}
        </div>
        {selected && (
          <EntityInspector
            key={selected.id}
            title={selected.name}
            context="Team configuration"
            icon={Users}
            onClose={() => setSelection(undefined)}
            actions={
              <button
                type="button"
                className="primary-button"
                onClick={() => navigate(groupRoute(selected.id, "members"))}
              >
                Open team <ArrowRight size={14} />
              </button>
            }
          >
            <EntitySection
              title="Configuration"
              actions={
                <button
                  className="icon-button"
                  aria-label={`Edit group settings ${selected.name}`}
                  title="Edit team configuration"
                  type="button"
                  onClick={() => setEditing(!editing)}
                >
                  <Pencil size={15} />
                </button>
              }
            >
              {editing ? (
                <EntityEditor kind="team" group={selected} onClose={() => setEditing(false)} />
              ) : (
                <dl>
                  <div>
                    <dt>Name</dt>
                    <dd>{selected.name}</dd>
                  </div>
                  <div>
                    <dt>Instructions</dt>
                    <dd>
                      <code>
                        {config.groups[selected.id]?.instructions.join("\n") || "None configured"}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>Workspace</dt>
                    <dd>
                      {snapshot.checkouts.find((checkout) => checkout.id === selected.checkoutId)
                        ?.branch ?? "Primary fallback"}
                    </dd>
                  </div>
                </dl>
              )}
            </EntitySection>
            <EntitySection title="Team actions">
              <div className="entity-command-stack">
                <button
                  className="compact-button"
                  type="button"
                  onClick={() => navigate(groupRoute(selected.id, "terminals"))}
                >
                  Open terminals
                </button>
                <button
                  className="compact-button"
                  type="button"
                  onClick={() => navigate("/checkouts")}
                >
                  Manage workspace
                </button>
                <button
                  type="button"
                  className="compact-button danger-button"
                  onClick={() => setRemove(true)}
                >
                  <Trash2 size={14} />
                  Delete group
                </button>
              </div>
            </EntitySection>
          </EntityInspector>
        )}
      </div>
      {create && <EntityCreateDialog kind="team" onClose={() => setCreate(false)} />}
      {selected && remove && (
        <ImpactDialog
          title={`Delete ${selected.name}?`}
          action="Delete group"
          danger
          onClose={() => setRemove(false)}
          onApply={async () => {
            await management.deleteTeam(selected.id);
            setSelection(undefined);
          }}
        >
          <p>
            {
              snapshot.runs.filter(
                (run) =>
                  run.groupId === selected.id && ["running", "starting"].includes(run.status),
              ).length
            }{" "}
            runs will stop before{" "}
            {
              snapshot.memberships.filter(
                (member) => member.groupId === selected.id && member.state === "active",
              ).length
            }{" "}
            agents
            {" and "}
            {snapshot.messageGroups?.find((item) => item.groupId === selected.id)
              ?.retainedMessageCount ?? 0}{" "}
            messages
            {" are deleted. Git checkouts and event history remain."}
          </p>
        </ImpactDialog>
      )}
    </article>
  );
}
