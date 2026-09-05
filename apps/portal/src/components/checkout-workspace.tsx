import type {
  GitStatusProjection,
  GroupCheckoutSwitchPolicy,
  PortalSnapshot,
} from "@nanasa/contracts";
import {
  Activity,
  CircleCheck,
  FileWarning,
  FolderGit2,
  GitBranch,
  LockKeyhole,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
import { currentMemberRun } from "../member-status.js";

interface PendingSwitch {
  groupId: string;
  checkoutId: string;
}

type AddWorkspaceMode = "create" | "attach";

function WorkspaceFact({
  icon: Icon,
  label,
  tooltip,
}: {
  icon: LucideIcon;
  label: string;
  tooltip: string;
}) {
  const tooltipId = useId();
  return (
    <span className="workspace-fact" tabIndex={0} aria-describedby={tooltipId}>
      <Icon aria-hidden="true" size={13} />
      <span>{label}</span>
      <span id={tooltipId} className="workspace-fact-tooltip" role="tooltip">
        {tooltip}
      </span>
    </span>
  );
}

function runIsActive(run: PortalSnapshot["runs"][number]): boolean {
  return run.desiredState === "running" || ["starting", "running", "stopping"].includes(run.status);
}

function currentRuns(snapshot: PortalSnapshot) {
  return snapshot.memberships
    .filter((membership) => membership.state === "active")
    .flatMap((membership) => {
      const run = currentMemberRun(snapshot.runs, membership);
      return run === undefined ? [] : [run];
    });
}

export function CheckoutWorkspace({
  client,
  snapshot,
  onChanged,
}: {
  client: PortalClient;
  snapshot: PortalSnapshot;
  onChanged(): Promise<void>;
}) {
  const repository = snapshot.repositories[0];
  const sourceCheckout = snapshot.checkouts.find(
    (checkout) => checkout.id === repository?.primaryCheckoutId,
  );
  const selectableCheckouts = snapshot.checkouts.filter((checkout) => checkout.kind !== "bare");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [openPath, setOpenPath] = useState("");
  const [createGroupId, setCreateGroupId] = useState("");
  const [openGroupId, setOpenGroupId] = useState("");
  const [activateCreated, setActivateCreated] = useState(false);
  const [activateOpened, setActivateOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError>();
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspaceMode, setAddWorkspaceMode] = useState<AddWorkspaceMode>("create");
  const [forceWorktreeId, setForceWorktreeId] = useState<string>();
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch>();
  const [statuses, setStatuses] = useState<Record<string, GitStatusProjection>>({});
  const currentTeamRuns = currentRuns(snapshot);

  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await onChanged();
    } catch (cause) {
      setError(toPortalError(cause, "Workspace operation failed"));
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const activation = (groupId: string) => {
    const group = snapshot.groups.find((candidate) => candidate.id === groupId);
    return group === undefined
      ? {}
      : {
          groupId: group.id,
          expectedCheckoutRevision: group.checkoutRevision,
          switchPolicy: "require-stopped" as const,
        };
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (sourceCheckout === undefined) return;
    await execute(() =>
      client.createWorktree({
        sourceCheckoutId: sourceCheckout.id,
        branch,
        base,
        ...(activateCreated ? activation(createGroupId) : {}),
      }),
    );
    setBranch("");
    setAddWorkspaceOpen(false);
  };

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (sourceCheckout === undefined) return;
    await execute(() =>
      client.openCheckout({
        sourceCheckoutId: sourceCheckout.id,
        path: openPath,
        ...(activateOpened ? activation(openGroupId) : {}),
      }),
    );
    setOpenPath("");
    setAddWorkspaceOpen(false);
  };

  const changeWorkspace = async (policy: GroupCheckoutSwitchPolicy) => {
    if (pendingSwitch === undefined) return;
    const group = snapshot.groups.find((candidate) => candidate.id === pendingSwitch.groupId);
    if (group === undefined) return;
    await execute(() =>
      client.assignCheckout(group.id, {
        checkoutId: pendingSwitch.checkoutId,
        expectedCheckoutRevision: group.checkoutRevision,
        switchPolicy: policy,
      }),
    );
    setPendingSwitch(undefined);
  };

  const refresh = async (checkoutId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const status = await client.refreshCheckout(checkoutId);
      setStatuses((current) => ({ ...current, [checkoutId]: status }));
      await onChanged();
    } catch (cause) {
      setError(toPortalError(cause, "Checkout refresh failed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (worktreeId: string, force: boolean) => {
    const worktree = snapshot.worktrees.find((candidate) => candidate.id === worktreeId);
    if (worktree === undefined) return;
    try {
      await execute(() =>
        client.removeWorktree(worktree.id, {
          force,
          expectedOperationGeneration: worktree.operationGeneration,
        }),
      );
      setForceWorktreeId(undefined);
    } catch (cause) {
      if (!force && cause instanceof Error && /dirty|force/i.test(cause.message)) {
        setForceWorktreeId(worktree.id);
      }
    }
  };

  const pendingGroup = snapshot.groups.find((group) => group.id === pendingSwitch?.groupId);
  const pendingCheckout = selectableCheckouts.find(
    (checkout) => checkout.id === pendingSwitch?.checkoutId,
  );
  const pendingCurrent = selectableCheckouts.find(
    (checkout) => checkout.id === (pendingGroup?.checkoutId ?? sourceCheckout?.id),
  );
  const pendingRunningCount = currentTeamRuns.filter(
    (run) => run.groupId === pendingGroup?.id && runIsActive(run),
  ).length;

  return (
    <div className="checkout-workspace">
      <section className="workflow-card" aria-labelledby="team-workspaces-title">
        <header className="workspace-section-heading">
          <div>
            <h3 id="team-workspaces-title">Team workspaces</h3>
            <p>One workspace shared by every agent on a team.</p>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={busy || sourceCheckout === undefined}
            title={sourceCheckout === undefined ? "A primary checkout is required" : undefined}
            onClick={() => setAddWorkspaceOpen(true)}
          >
            <Plus aria-hidden="true" size={15} />
            Add workspace
          </button>
        </header>
        {snapshot.groups.length === 0 ? (
          <p>No teams are configured.</p>
        ) : (
          <ul className="team-workspace-list">
            {snapshot.groups.map((group) => {
              const checkout = selectableCheckouts.find(
                (candidate) => candidate.id === (group.checkoutId ?? sourceCheckout?.id),
              );
              const agentCount = snapshot.memberships.filter(
                (membership) => membership.groupId === group.id && membership.state === "active",
              ).length;
              const runningCount = currentTeamRuns.filter(
                (run) => run.groupId === group.id && runIsActive(run),
              ).length;
              const owners =
                checkout === undefined
                  ? []
                  : snapshot.groups.filter(
                      (candidate) => (candidate.checkoutId ?? sourceCheckout?.id) === checkout.id,
                    );
              return (
                <li key={group.id}>
                  <div className="team-workspace-summary">
                    <strong>{group.name}</strong>
                    <span>{checkout?.branch ?? "Unavailable checkout"}</span>
                    <small>{checkout?.path ?? "Select another workspace"}</small>
                  </div>
                  <div className="workspace-facts">
                    <WorkspaceFact
                      icon={checkout?.kind === "primary" ? GitBranch : LockKeyhole}
                      label={checkout?.kind === "primary" ? "Primary" : "Exclusive"}
                      tooltip={
                        checkout?.kind === "primary"
                          ? "The repository's main working tree. Multiple teams may use it."
                          : "A linked working tree reserved for this team."
                      }
                    />
                    <WorkspaceFact
                      icon={checkout?.dirty ? FileWarning : CircleCheck}
                      label={checkout?.dirty ? "Dirty" : "Clean"}
                      tooltip={
                        checkout?.dirty
                          ? "This workspace has staged, modified, or untracked files."
                          : "This workspace has no local file changes."
                      }
                    />
                    <WorkspaceFact
                      icon={Share2}
                      label={owners.length > 1 ? `Shared by ${owners.length} teams` : "Not shared"}
                      tooltip={
                        owners.length > 1
                          ? `${owners.length} teams currently use this workspace.`
                          : "No other team currently uses this workspace."
                      }
                    />
                    <WorkspaceFact
                      icon={Users}
                      label={`${agentCount} ${agentCount === 1 ? "agent" : "agents"}`}
                      tooltip="Active agents configured in this team."
                    />
                    <WorkspaceFact
                      icon={Activity}
                      label={`${runningCount} active ${runningCount === 1 ? "agent" : "agents"}`}
                      tooltip="Agents that must be stopped before this team changes workspace."
                    />
                  </div>
                  <select
                    aria-label={`Workspace for ${group.name}`}
                    value={checkout?.id ?? ""}
                    disabled={busy || selectableCheckouts.length === 0}
                    onChange={(event) =>
                      setPendingSwitch({ groupId: group.id, checkoutId: event.target.value })
                    }
                  >
                    {selectableCheckouts.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.branch ?? "Detached HEAD"}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        className="workflow-card workspace-inventory"
        aria-labelledby="workspace-inventory-title"
      >
        <header className="workspace-section-heading">
          <div>
            <h3 id="workspace-inventory-title">Workspace inventory</h3>
            <p>{snapshot.checkouts.length} known workspaces</p>
          </div>
        </header>
        {snapshot.checkouts.length === 0 ? (
          <p>No workspaces are available.</p>
        ) : (
          <ul className="checkout-list">
            {snapshot.checkouts.map((checkout) => {
              const managed = snapshot.worktrees.find(
                (worktree) => worktree.checkoutId === checkout.id && worktree.state !== "removed",
              );
              const owners = snapshot.groups.filter(
                (group) => (group.checkoutId ?? sourceCheckout?.id) === checkout.id,
              );
              const activeRuns = currentTeamRuns.filter(
                (run) => run.checkoutId === checkout.id && runIsActive(run),
              );
              const removalBlocker =
                owners.length > 0
                  ? `Assigned to ${owners.map((group) => group.name).join(", ")}`
                  : activeRuns.length > 0
                    ? `${activeRuns.length} active runs`
                    : undefined;
              const status = statuses[checkout.id];
              const badge =
                checkout.kind === "primary"
                  ? "Primary"
                  : managed === undefined
                    ? "External"
                    : "Managed";
              return (
                <li key={checkout.id}>
                  <div>
                    <strong>{checkout.branch ?? "Detached HEAD"}</strong>
                    <small>{checkout.path}</small>
                    <span>
                      {badge} · {checkout.dirty ? "dirty" : "clean"}
                      {owners.length > 0
                        ? ` · ${owners.length} team${owners.length === 1 ? "" : "s"}`
                        : ""}
                    </span>
                    {status !== undefined && (
                      <span>
                        {status.staged} staged · {status.modified} modified · {status.untracked}{" "}
                        untracked · {status.ahead} ahead · {status.behind} behind
                      </span>
                    )}
                  </div>
                  <div className="checkout-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Refresh ${checkout.branch ?? checkout.id}`}
                      title="Refresh Git status"
                      disabled={busy || checkout.kind === "bare"}
                      onClick={() => void refresh(checkout.id)}
                    >
                      <RefreshCw aria-hidden="true" size={15} />
                    </button>
                    {managed !== undefined &&
                      managed.state === "ready" &&
                      (forceWorktreeId === managed.id ? (
                        <button
                          type="button"
                          className="compact-button danger-button"
                          disabled={busy || removalBlocker !== undefined}
                          title={removalBlocker}
                          onClick={() => void remove(managed.id, true)}
                        >
                          Confirm force remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="icon-button danger-button"
                          aria-label={`Remove worktree ${checkout.branch ?? checkout.id}`}
                          disabled={busy || removalBlocker !== undefined}
                          title={removalBlocker ?? "Remove managed worktree"}
                          onClick={() => void remove(managed.id, false)}
                        >
                          <Trash2 aria-hidden="true" size={15} />
                        </button>
                      ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {addWorkspaceOpen && repository !== undefined && sourceCheckout !== undefined && (
        <div className="workspace-dialog-backdrop" role="presentation">
          <section
            className="workspace-switch-dialog workspace-add-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-workspace-title"
          >
            <header>
              <div>
                <h3 id="add-workspace-title">Add workspace</h3>
                <p>
                  {repository.displayName} · {sourceCheckout.branch ?? "detached"}
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close add workspace"
                disabled={busy}
                onClick={() => setAddWorkspaceOpen(false)}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </header>
            <div className="segmented-control workspace-add-mode" aria-label="Workspace source">
              <button
                type="button"
                aria-pressed={addWorkspaceMode === "create"}
                onClick={() => setAddWorkspaceMode("create")}
              >
                <GitBranch aria-hidden="true" size={14} />
                Create new
              </button>
              <button
                type="button"
                aria-pressed={addWorkspaceMode === "attach"}
                onClick={() => setAddWorkspaceMode("attach")}
              >
                <FolderGit2 aria-hidden="true" size={14} />
                Attach existing
              </button>
            </div>
            {addWorkspaceMode === "create" ? (
              <form
                className="workspace-add-form"
                onSubmit={(event) => void create(event).catch(() => undefined)}
              >
                <label>
                  New branch
                  <input
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder="feature/my-task"
                    autoFocus
                    required
                  />
                </label>
                <label>
                  Start from
                  <input value={base} onChange={(event) => setBase(event.target.value)} required />
                </label>
                <label>
                  Assign to team
                  <select
                    value={createGroupId}
                    onChange={(event) => setCreateGroupId(event.target.value)}
                  >
                    <option value="">Do not assign yet</option>
                    {snapshot.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="workspace-activation">
                  <input
                    type="checkbox"
                    checked={activateCreated}
                    disabled={createGroupId === ""}
                    onChange={(event) => setActivateCreated(event.target.checked)}
                  />
                  Use for this team immediately
                </label>
                <footer>
                  <button
                    type="button"
                    className="compact-button"
                    disabled={busy}
                    onClick={() => setAddWorkspaceOpen(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="primary-button" disabled={busy}>
                    <GitBranch aria-hidden="true" size={15} />
                    Create workspace
                  </button>
                </footer>
              </form>
            ) : (
              <form
                className="workspace-add-form"
                onSubmit={(event) => void open(event).catch(() => undefined)}
              >
                <label>
                  Existing worktree path
                  <input
                    value={openPath}
                    onChange={(event) => setOpenPath(event.target.value)}
                    placeholder="/absolute/path/to/worktree"
                    autoFocus
                    required
                  />
                </label>
                <label>
                  Assign to team
                  <select
                    value={openGroupId}
                    onChange={(event) => setOpenGroupId(event.target.value)}
                  >
                    <option value="">Do not assign yet</option>
                    {snapshot.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="workspace-activation">
                  <input
                    type="checkbox"
                    checked={activateOpened}
                    disabled={openGroupId === ""}
                    onChange={(event) => setActivateOpened(event.target.checked)}
                  />
                  Use for this team immediately
                </label>
                <footer>
                  <button
                    type="button"
                    className="compact-button"
                    disabled={busy}
                    onClick={() => setAddWorkspaceOpen(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="primary-button" disabled={busy}>
                    <FolderGit2 aria-hidden="true" size={15} />
                    Attach workspace
                  </button>
                </footer>
              </form>
            )}
          </section>
        </div>
      )}

      {pendingSwitch !== undefined &&
        pendingGroup !== undefined &&
        pendingCheckout !== undefined && (
          <div className="workspace-dialog-backdrop" role="presentation">
            <section
              className="workspace-switch-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="workspace-switch-title"
            >
              <header>
                <div>
                  <h3 id="workspace-switch-title">Change {pendingGroup.name} workspace</h3>
                  <p>
                    {pendingRunningCount} active {pendingRunningCount === 1 ? "agent" : "agents"}
                  </p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cancel workspace change"
                  onClick={() => setPendingSwitch(undefined)}
                >
                  <X aria-hidden="true" size={16} />
                </button>
              </header>
              <dl>
                <div>
                  <dt>Current</dt>
                  <dd>
                    {pendingCurrent?.branch ?? "Unavailable"}
                    <small>{pendingCurrent?.path}</small>
                  </dd>
                </div>
                <div>
                  <dt>New</dt>
                  <dd>
                    {pendingCheckout.branch ?? "Detached HEAD"}
                    <small>{pendingCheckout.path}</small>
                  </dd>
                </div>
              </dl>
              <footer>
                <button
                  type="button"
                  className="compact-button"
                  onClick={() => setPendingSwitch(undefined)}
                >
                  Cancel
                </button>
                {pendingRunningCount === 0 ? (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void changeWorkspace("require-stopped").catch(() => undefined)}
                  >
                    Change workspace
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="compact-button"
                      disabled={busy}
                      onClick={() => void changeWorkspace("stop-and-switch").catch(() => undefined)}
                    >
                      Stop and switch
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() =>
                        void changeWorkspace("stop-switch-restart").catch(() => undefined)
                      }
                    >
                      Stop, switch, and restart
                    </button>
                  </>
                )}
              </footer>
            </section>
          </div>
        )}

      {busy && (
        <p role="status" className="checkout-operation-status">
          <RefreshCw className="spin" aria-hidden="true" size={14} /> Workspace operation in
          progress
        </p>
      )}
      {error !== undefined && <ErrorNotice error={error} className="form-error" />}
    </div>
  );
}
