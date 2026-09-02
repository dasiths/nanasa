import type { NanasaConfig, PortalSnapshot } from "@nanasa/contracts";
import { GitBranch, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";

export function CheckoutWorkspace({
  client,
  snapshot,
  config,
  onChanged,
}: {
  client: PortalClient;
  snapshot: PortalSnapshot;
  config: NanasaConfig;
  onChanged(): Promise<void>;
}) {
  const repository = snapshot.repositories[0];
  const sourceCheckout = snapshot.checkouts.find(
    (checkout) => checkout.id === repository?.primaryCheckoutId,
  );
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [openPath, setOpenPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError>();
  const [forceWorktreeId, setForceWorktreeId] = useState<string>();

  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await onChanged();
    } catch (cause) {
      setError(toPortalError(cause, "Git operation failed"));
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (sourceCheckout === undefined) return;
    await execute(() =>
      client.createWorktree({
        sourceCheckoutId: sourceCheckout.id,
        branch,
        base,
        assignAgentIds: [],
      }),
    );
    setBranch("");
  };

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (sourceCheckout === undefined) return;
    await execute(() =>
      client.openCheckout({ sourceCheckoutId: sourceCheckout.id, path: openPath }),
    );
    setOpenPath("");
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

  return (
    <div className="checkout-workspace">
      {repository === undefined || sourceCheckout === undefined ? (
        <div className="empty-state route-empty">
          <p>No usable primary checkout is available.</p>
        </div>
      ) : (
        <section className="workflow-card" aria-labelledby="checkout-create-title">
          <div>
            <h3 id="checkout-create-title">Create or open a checkout</h3>
            <p>
              <strong>{repository.displayName}</strong> · {sourceCheckout.branch ?? "detached"}
            </p>
          </div>
          <div className="checkout-route-forms">
            <form
              className="checkout-operation-form"
              onSubmit={(event) => void create(event).catch(() => undefined)}
            >
              <label>
                New branch
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  required
                />
              </label>
              <label>
                Base revision
                <input value={base} onChange={(event) => setBase(event.target.value)} required />
              </label>
              <button type="submit" className="compact-button" disabled={busy}>
                <GitBranch aria-hidden="true" size={15} />
                Create managed worktree
              </button>
            </form>
            <form
              className="checkout-operation-form"
              onSubmit={(event) => void open(event).catch(() => undefined)}
            >
              <label>
                Existing absolute worktree path
                <input
                  value={openPath}
                  onChange={(event) => setOpenPath(event.target.value)}
                  required
                />
              </label>
              <button type="submit" className="compact-button" disabled={busy}>
                Open existing checkout
              </button>
            </form>
          </div>
        </section>
      )}

      <div className="checkout-route-grid">
        <section className="workflow-card" aria-labelledby="available-checkouts-title">
          <h3 id="available-checkouts-title">Available checkouts</h3>
          {snapshot.checkouts.length === 0 ? (
            <p>No checkouts are available.</p>
          ) : (
            <ul className="checkout-list">
              {snapshot.checkouts.map((checkout) => {
                const managed = snapshot.worktrees.find(
                  (worktree) => worktree.checkoutId === checkout.id && worktree.state !== "removed",
                );
                return (
                  <li key={checkout.id}>
                    <div>
                      <strong>{checkout.branch ?? "Detached HEAD"}</strong>
                      <small>{checkout.path}</small>
                      <span>
                        {checkout.kind}
                        {checkout.dirty ? " · dirty" : " · clean"}
                      </span>
                    </div>
                    {managed !== undefined &&
                      managed.state === "ready" &&
                      (forceWorktreeId === managed.id ? (
                        <button
                          type="button"
                          className="compact-button danger-button"
                          disabled={busy}
                          onClick={() => void remove(managed.id, true)}
                        >
                          Confirm force remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="icon-button danger-button"
                          aria-label={`Remove worktree ${checkout.branch ?? checkout.id}`}
                          disabled={busy}
                          onClick={() => void remove(managed.id, false)}
                        >
                          <Trash2 aria-hidden="true" size={15} />
                        </button>
                      ))}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="workflow-card" aria-labelledby="checkout-assignments-title">
          <h3 id="checkout-assignments-title">Stopped-agent assignments</h3>
          {snapshot.memberships.filter((membership) => membership.state === "active").length ===
          0 ? (
            <p>No agents are available for checkout assignment.</p>
          ) : (
            snapshot.memberships
              .filter((membership) => membership.state === "active")
              .map((membership) => {
                const agentEntry = Object.entries(
                  config.groups[membership.groupId]?.agents ?? {},
                ).find(([, agent]) => agent.memberId === membership.memberId);
                if (agentEntry === undefined) return null;
                const [agentId, agent] = agentEntry;
                const active = snapshot.runs.some(
                  (run) =>
                    run.groupId === membership.groupId &&
                    run.memberId === membership.memberId &&
                    (run.desiredState === "running" ||
                      ["starting", "running", "stopping"].includes(run.status)),
                );
                return (
                  <label key={membership.id} className="checkout-assignment">
                    {agent.name}
                    <select
                      value={membership.checkoutId ?? sourceCheckout?.id ?? ""}
                      disabled={busy || active || sourceCheckout === undefined}
                      onChange={(event) =>
                        void execute(() =>
                          client.assignCheckout(membership.groupId, agentId, {
                            checkoutId: event.target.value,
                          }),
                        ).catch(() => undefined)
                      }
                    >
                      {snapshot.checkouts
                        .filter((checkout) => checkout.kind !== "bare")
                        .map((checkout) => (
                          <option key={checkout.id} value={checkout.id}>
                            {checkout.branch ?? "detached"} · {checkout.path}
                          </option>
                        ))}
                    </select>
                    {active && <small>Stop this agent before changing its checkout.</small>}
                  </label>
                );
              })
          )}
        </section>
      </div>

      {busy && (
        <p role="status" className="checkout-operation-status">
          <RefreshCw className="spin" aria-hidden="true" size={14} /> Git operation in progress
        </p>
      )}
      {error !== undefined && <ErrorNotice error={error} className="form-error" />}
    </div>
  );
}
