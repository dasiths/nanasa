import type { NanasaConfig, PortalSnapshot } from "@nanasa/contracts";
import { GitBranch, RefreshCw, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { PortalClient } from "../api.js";

export function CheckoutWorktreeDialog({
  client,
  snapshot,
  config,
  onChanged,
  onClose,
}: {
  client: PortalClient;
  snapshot: PortalSnapshot;
  config: NanasaConfig;
  onChanged(): Promise<void>;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const repository = snapshot.repositories[0];
  const sourceCheckout = snapshot.checkouts.find(
    (checkout) => checkout.id === repository?.primaryCheckoutId,
  );
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [openPath, setOpenPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [forceWorktreeId, setForceWorktreeId] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Git operation failed");
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
    <dialog
      ref={dialogRef}
      className="confirmation-dialog checkout-dialog"
      aria-labelledby="checkout-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="confirmation-dialog-body">
        <header className="agent-settings-heading">
          <div>
            <span className="eyebrow">Git ownership</span>
            <h2 id="checkout-dialog-title">Checkouts and worktrees</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close checkouts"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        {repository === undefined || sourceCheckout === undefined ? (
          <p>No usable primary checkout is available.</p>
        ) : (
          <>
            <p>
              <strong>{repository.displayName}</strong> · {sourceCheckout.branch ?? "detached"}
            </p>
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
          </>
        )}
        <section aria-labelledby="available-checkouts-title">
          <h3 id="available-checkouts-title">Available checkouts</h3>
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
        </section>
        <section aria-labelledby="checkout-assignments-title">
          <h3 id="checkout-assignments-title">Stopped-agent assignments</h3>
          {snapshot.memberships.map((membership) => {
            const agent = config.groups[membership.groupId]?.agents[membership.id];
            if (agent === undefined) return null;
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
                  disabled={busy || active}
                  onChange={(event) =>
                    void execute(() =>
                      client.assignCheckout(membership.groupId, membership.id, {
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
              </label>
            );
          })}
        </section>
        {busy && (
          <p role="status">
            <RefreshCw className="spin" aria-hidden="true" size={14} /> Git operation in progress
          </p>
        )}
        {error !== undefined && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
