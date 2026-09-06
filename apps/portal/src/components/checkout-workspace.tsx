import type {
  GitReference,
  GitStatusProjection,
  GroupCheckoutSwitchPolicy,
  PortalSnapshot,
} from "@nanasa/contracts";
import { FolderGit2, GitBranch, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
import { currentMemberRun } from "../member-status.js";
import { EntityInspector, EntitySection, EntityTabs } from "./entity-inspector.js";

interface PendingSwitch {
  groupId: string;
  checkoutId: string;
}

type AddWorkspaceMode = "create" | "attach";

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
  const [selectedCheckoutId, setSelectedCheckoutId] = useState<string>();
  const [query, setQuery] = useState("");
  const [detailTab, setDetailTab] = useState("Assignment");
  const [error, setError] = useState<PortalError>();
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspaceMode, setAddWorkspaceMode] = useState<AddWorkspaceMode>("create");
  const [forceWorktreeId, setForceWorktreeId] = useState<string>();
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch>();
  const [statuses, setStatuses] = useState<Record<string, GitStatusProjection>>({});
  const currentTeamRuns = currentRuns(snapshot);
  const [references, setReferences] = useState<GitReference[]>([]);
  const [referenceState, setReferenceState] = useState<"loading" | "ready" | "error">("ready");
  const [referenceRefresh, setReferenceRefresh] = useState(0);
  const referenceListId = useId();
  const sourceCheckoutId = sourceCheckout?.id;

  useEffect(() => {
    if (!addWorkspaceOpen || addWorkspaceMode !== "create" || sourceCheckoutId === undefined)
      return;
    let cancelled = false;
    setReferences([]);
    setReferenceState("loading");
    client.listCheckoutReferences(sourceCheckoutId).then(
      (result) => {
        if (cancelled) return;
        setReferences(result);
        setReferenceState("ready");
      },
      () => {
        if (!cancelled) setReferenceState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, sourceCheckoutId, addWorkspaceOpen, addWorkspaceMode, referenceRefresh]);

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

  const fetchUpdates = async () => {
    if (sourceCheckoutId === undefined) return;
    await execute(async () => {
      const updated = await client.fetchCheckout(sourceCheckoutId);
      setStatuses(Object.fromEntries(updated.map((status) => [status.checkoutId, status])));
      setReferenceRefresh((revision) => revision + 1);
    });
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
  const selectedCheckout = snapshot.checkouts.find(
    (checkout) => checkout.id === selectedCheckoutId,
  );

  return (
    <div className={`checkout-workspace${selectedCheckout ? " entity-detail-open" : ""}`}>
      <header className="workspace-section-heading">
        <div>
          <label className="entity-search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="Search workspaces"
              placeholder="Search branches or paths..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="workspace-heading-actions">
          <button
            type="button"
            className="compact-button"
            disabled={busy || sourceCheckout === undefined}
            title="Run git fetch --all --prune, then refresh workspace statuses. Working files are unchanged."
            onClick={() => void fetchUpdates().catch(() => undefined)}
          >
            <RefreshCw aria-hidden="true" size={15} />
            Fetch updates
          </button>
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
        </div>
      </header>
      <div className={`entity-layout${selectedCheckout ? " has-inspector" : ""}`}>
        <section
          className="entity-collection workspace-inventory"
          aria-labelledby="workspace-inventory-title"
        >
          <div className="entity-columns workspace-entity-columns">
            <span id="workspace-inventory-title">Workspace / branch</span>
            <span>Team binding</span>
            <span>Working tree</span>
          </div>
          <ul className="entity-record-list">
            {snapshot.checkouts
              .filter((checkout) =>
                `${checkout.branch} ${checkout.path}`.toLowerCase().includes(query.toLowerCase()),
              )
              .map((checkout) => {
                const owners = snapshot.groups.filter(
                  (group) => (group.checkoutId ?? sourceCheckout?.id) === checkout.id,
                );
                const managed = snapshot.worktrees.find(
                  (item) => item.checkoutId === checkout.id && item.state !== "removed",
                );
                return (
                  <li key={checkout.id}>
                    <button
                      className="entity-row workspace-entity-columns"
                      type="button"
                      aria-label={`Inspect workspace ${checkout.branch ?? checkout.id}`}
                      aria-pressed={checkout.id === selectedCheckoutId}
                      onClick={() => setSelectedCheckoutId(checkout.id)}
                    >
                      <span className="entity-identity">
                        <span className="entity-glyph">
                          <GitBranch size={18} />
                        </span>
                        <span>
                          <strong>{checkout.branch ?? "Detached HEAD"}</strong>
                          <small>
                            <code>{checkout.path}</code>
                          </small>
                          <small>
                            {checkout.kind === "primary"
                              ? "Primary"
                              : managed
                                ? "Managed worktree"
                                : "External checkout"}
                          </small>
                        </span>
                      </span>
                      <span>{owners.map((group) => group.name).join(", ") || "Unassigned"}</span>
                      <span
                        className="entity-state-label"
                        data-tone={checkout.dirty ? "warning" : "ready"}
                      >
                        {checkout.dirty ? "Dirty" : "Clean"}
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
          {snapshot.checkouts.length === 0 && (
            <p className="entity-context-note">No workspaces are available.</p>
          )}
        </section>
        {selectedCheckout && (
          <EntityInspector
            title={selectedCheckout.branch ?? "Detached checkout"}
            context={selectedCheckout.kind === "primary" ? "Primary checkout" : "Linked checkout"}
            icon={GitBranch}
            onClose={() => setSelectedCheckoutId(undefined)}
          >
            <EntityTabs
              label="Workspace details"
              tabs={["Assignment", "Git facts", "Maintenance"]}
              selected={detailTab}
              onSelect={setDetailTab}
            />
            {detailTab === "Assignment" && (
              <EntitySection title="Team assignment">
                <code className="entity-checkout-path">{selectedCheckout.path}</code>
                <p className="entity-context-note">
                  {selectedCheckout.kind === "primary"
                    ? "Shared primary workspace"
                    : "Exclusive linked workspace"}{" "}
                  / {selectedCheckout.dirty ? "Local changes" : "Clean working tree"}
                </p>
                {snapshot.groups.length === 0 ? (
                  <p>No teams are configured.</p>
                ) : (
                  <ul className="team-assignment-list">
                    {snapshot.groups
                      .filter(
                        (group) => (group.checkoutId ?? sourceCheckout?.id) === selectedCheckout.id,
                      )
                      .map((group) => {
                        const checkout = selectableCheckouts.find(
                          (candidate) => candidate.id === (group.checkoutId ?? sourceCheckout?.id),
                        );
                        const agentCount = snapshot.memberships.filter(
                          (membership) =>
                            membership.groupId === group.id && membership.state === "active",
                        ).length;
                        const runningCount = currentTeamRuns.filter(
                          (run) => run.groupId === group.id && runIsActive(run),
                        ).length;
                        return (
                          <li key={group.id}>
                            <div className="team-workspace-summary">
                              <strong>{group.name}</strong>
                              <small>
                                {agentCount} agents / {runningCount} active runs
                              </small>
                            </div>
                            <select
                              aria-label={`Workspace for ${group.name}`}
                              value={checkout?.id ?? ""}
                              disabled={busy || selectableCheckouts.length === 0}
                              onChange={(event) =>
                                setPendingSwitch({
                                  groupId: group.id,
                                  checkoutId: event.target.value,
                                })
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
                <label className="entity-edit-form">
                  Assign another team
                  <select
                    aria-label="Assign team to workspace"
                    value=""
                    disabled={busy}
                    onChange={(event) => {
                      if (event.target.value)
                        setPendingSwitch({
                          groupId: event.target.value,
                          checkoutId: selectedCheckout.id,
                        });
                    }}
                  >
                    <option value="">Choose a team</option>
                    {snapshot.groups
                      .filter(
                        (group) => (group.checkoutId ?? sourceCheckout?.id) !== selectedCheckout.id,
                      )
                      .map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                  </select>
                </label>
              </EntitySection>
            )}

            {(detailTab === "Git facts" || detailTab === "Maintenance") && (
              <EntitySection title={detailTab}>
                <ul className="checkout-detail-list">
                  {[selectedCheckout].map((checkout) => {
                    const managed = snapshot.worktrees.find(
                      (worktree) =>
                        worktree.checkoutId === checkout.id && worktree.state !== "removed",
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
                          <code className="entity-checkout-path">{checkout.path}</code>
                          <p className="entity-context-note">
                            {badge} · {checkout.dirty ? "dirty" : "clean"}
                            {owners.length > 0
                              ? ` · ${owners.length} team${owners.length === 1 ? "" : "s"}`
                              : ""}
                          </p>
                          {status !== undefined && (
                            <span>
                              {status.staged} staged · {status.modified} modified ·{" "}
                              {status.untracked} untracked · {status.ahead} ahead · {status.behind}{" "}
                              behind
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
                          {detailTab === "Maintenance" &&
                            managed !== undefined &&
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
                        {detailTab === "Maintenance" && (removalBlocker || !managed) && (
                          <p className="entity-context-note">
                            {removalBlocker ?? "Only Nanasa-managed worktrees can be removed."}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </EntitySection>
            )}
          </EntityInspector>
        )}
      </div>

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
                  <input
                    value={base}
                    onChange={(event) => setBase(event.target.value)}
                    list={referenceListId}
                    autoComplete="off"
                    title="HEAD means the current commit in the source checkout, without uncommitted changes. You can also enter a branch, tag, or commit ID."
                    required
                  />
                </label>
                <datalist id={referenceListId}>
                  <option value="HEAD" label="Current commit in the source checkout" />
                  {references.map((reference) => (
                    <option
                      key={`${reference.kind}:${reference.name}`}
                      value={reference.name}
                      label={
                        reference.kind === "remote"
                          ? "Remote branch"
                          : reference.kind === "tag"
                            ? "Tag"
                            : "Local branch"
                      }
                    />
                  ))}
                </datalist>
                {referenceState !== "ready" && (
                  <small role="status">
                    {referenceState === "loading"
                      ? "Loading revisions..."
                      : "Revision suggestions unavailable"}
                  </small>
                )}
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
