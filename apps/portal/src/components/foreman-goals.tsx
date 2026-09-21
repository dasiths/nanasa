import type {
  CleanupForemanCommand,
  CleanupForemanResult,
  ForemanCleanupRequest,
  ForemanConfig,
  ForemanGoal,
  ForemanGoalWorkspace,
  HumanDecision,
  RequestForemanCleanupCommand,
} from "@nanasa/contracts";
import { ArrowLeft, Check, Pause, Play, Plus, Send, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";

export function cleanupScopeDetail(command: RequestForemanCleanupCommand): string {
  if (command.scope === "channel")
    return `Clear messages through sequence ${command.throughSequence}, including reply threads, and selected member conversations: ${command.conversationIds?.join(", ") || "none"}. Later independent messages remain visible. Active goals and input processing continue.`;
  if (command.scope === "goal")
    return `${command.cancel ? "Cancel and remove" : "Remove"} goal ${command.goal.id} at revision ${command.goal.expectedRevision}. Existing provider work may continue; live effects are retained.`;
  return `Remove only these finished goals: ${command.goals.map((goal) => `${goal.id} at revision ${goal.expectedRevision}`).join(", ")}.`;
}

export function ForemanCleanupConfirmation({
  client,
  command,
  request,
  title,
  detail,
  onDone,
  onClose,
}: {
  client: PortalClient;
  title: string;
  detail: string;
  onDone(result: CleanupForemanResult): void;
  onClose(): void;
} & (
  | { command: CleanupForemanCommand; request?: never }
  | { request: ForemanCleanupRequest; command?: never }
)) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError>();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog"
      aria-labelledby="foreman-cleanup-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="confirmation-dialog-body">
        <h2 id="foreman-cleanup-title">{title}</h2>
        <p className="foreman-goal-objective">{detail}</p>
        {request && (
          <p className="foreman-cleanup-digest">
            Request: <code>{request.id}</code>
            <br />
            Scope digest: <code>{request.digest}</code>
          </p>
        )}
        <p>
          Items are hidden for all operators, not permanently erased. Operational records and
          request receipts are retained with no automatic expiry. Workspace files and provider
          sessions are unchanged.
        </p>
        {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
        <div className="confirmation-actions">
          <button className="compact-button" disabled={busy} onClick={onClose}>
            Keep items
          </button>
          <button
            className="compact-button danger-button"
            disabled={busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              setError(undefined);
              const operation = request
                ? client
                    .approveForemanCleanup({
                      id: request.id,
                      digest: request.digest,
                      confirmation: true,
                    })
                    .then((receipt) => {
                      if (!receipt.result) throw new Error("Cleanup approval returned no result");
                      return receipt.result;
                    })
                : client.cleanupForeman(command);
              void operation
                .then(onDone)
                .catch((cause: unknown) => {
                  setError(toPortalError(cause, "Cleanup failed"));
                })
                .finally(() => setBusy(false));
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
            {busy ? "Applying..." : "Confirm cleanup"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function ForemanGoals({
  client,
  configuration,
}: {
  client: PortalClient;
  configuration: ForemanConfig | undefined;
}) {
  const [goals, setGoals] = useState<ForemanGoal[]>([]);
  const [selected, setSelected] = useState<string>();
  const [workspace, setWorkspace] = useState<ForemanGoalWorkspace>();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [constraints, setConstraints] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError>();
  const [refresh, setRefresh] = useState(0);
  const [cleanup, setCleanup] = useState<{
    command: CleanupForemanCommand;
    title: string;
    detail: string;
  }>();
  const [cleanupResult, setCleanupResult] = useState<string>();
  const [pendingEffects, setPendingEffects] = useState<CleanupForemanResult["pendingEffects"]>([]);
  const request = useRef<{ body: string; id: string } | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setWorkspace(undefined);
    const load = async () => {
      try {
        const [list, effects] = await Promise.all([
          client.listForemanGoals(),
          client.loadForemanCleanupEffects(),
        ]);
        const detail = selected ? await client.getForemanGoal(selected) : undefined;
        if (!cancelled) {
          setGoals(list);
          setWorkspace(detail);
          setPendingEffects(effects);
        }
      } catch (cause) {
        if (!cancelled) setError(toPortalError(cause, "Unable to load goals"));
      } finally {
        if (!cancelled) timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, selected, refresh]);
  const operate = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(
        toPortalError(cause, cause instanceof Error ? cause.message : "Goal operation failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const decide = (decision: HumanDecision, answer: string) =>
    operate(() =>
      client.resolveHumanDecision({
        id: decision.id,
        expectedRevision: decision.revision,
        requestId: `decision-${decision.id}-${decision.revision}`,
        answer,
      }),
    );
  const control = (action: Parameters<PortalClient["controlForemanGoal"]>[0]["action"]) =>
    operate(async () => {
      if (workspace)
        await client.controlForemanGoal({
          id: workspace.goal.id,
          expectedRevision: workspace.goal.revision,
          action,
        });
    });
  const finished = goals.filter((goal) => ["completed", "cancelled"].includes(goal.state));
  return (
    <section className="foreman-goals" aria-label="Goals">
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {cleanup && (
        <ForemanCleanupConfirmation
          client={client}
          {...cleanup}
          onClose={() => setCleanup(undefined)}
          onDone={(result) => {
            setCleanup(undefined);
            setSelected(undefined);
            setWorkspace(undefined);
            setCleanupResult(
              `${result.removedGoalIds.length} goals removed from the list. Operational records retained.`,
            );
            setRefresh((value) => value + 1);
          }}
        />
      )}
      {cleanupResult && <p role="status">{cleanupResult}</p>}
      {pendingEffects.length > 0 && (
        <section className="foreman-inbox-notice" aria-label="Removed goals with live effects">
          <h3>Removed goals with live effects</h3>
          <p>
            Future goal work is fenced. Existing provider work has not been forcibly stopped;
            inspect the addressed runs before reusing their workspaces.
          </p>
          <ul className="foreman-goal-list">
            {pendingEffects.map((effect) => (
              <li key={effect.goalId}>
                <button
                  onClick={() => setSelected(effect.goalId)}
                  title="Inspect retained goal details"
                >
                  <strong>{effect.goalId}</strong>
                </button>
                <span>
                  {effect.actionIds.length} unsettled actions, {effect.runIds.length} live runs
                </span>
                <details>
                  <summary>Retained effects</summary>
                  {effect.actionIds.map((id) => (
                    <p key={id}>
                      Action: <code>{id}</code>
                    </p>
                  ))}
                  {effect.runIds.map((id) => (
                    <p key={id}>
                      Run: <code>{id}</code>
                    </p>
                  ))}
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}
      {creating ? (
        <form
          className="foreman-settings"
          onSubmit={(event) => {
            event.preventDefault();
            void operate(async () => {
              const body = {
                title,
                objective,
                constraints: constraints
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              };
              const serialized = JSON.stringify(body);
              if (request.current?.body !== serialized)
                request.current = { body: serialized, id: crypto.randomUUID() };
              const goal = await client.proposeForemanGoal({
                ...body,
                requestId: request.current.id,
              });
              setSelected(goal.id);
              setCreating(false);
              request.current = undefined;
            });
          }}
        >
          <div className="foreman-toolbar">
            <h3>New goal</h3>
            <button
              type="button"
              className="icon-button"
              aria-label="Cancel goal creation"
              onClick={() => setCreating(false)}
            >
              <X size={16} />
            </button>
          </div>
          <fieldset disabled={busy}>
            <label className="foreman-wide">
              Title
              <input
                required
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="foreman-wide">
              Goal
              <textarea
                required
                rows={5}
                maxLength={16384}
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <label className="foreman-wide">
              Constraints
              <textarea
                rows={3}
                value={constraints}
                onChange={(event) => setConstraints(event.target.value)}
              />
            </label>
            <button className="compact-button" type="submit">
              <Plus size={16} />
              Propose goal
            </button>
          </fieldset>
        </form>
      ) : workspace ? (
        <>
          <div className="foreman-toolbar">
            <button
              className="icon-button"
              aria-label="Back to goals"
              onClick={() => setSelected(undefined)}
            >
              <ArrowLeft size={16} />
            </button>
            <h3>{workspace.goal.title}</h3>
            <span>{workspace.goal.state}</span>
          </div>
          <p className="foreman-goal-objective">{workspace.goal.objective}</p>
          {workspace.goal.constraints.length > 0 && (
            <ul>
              {workspace.goal.constraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          )}
          <dl className="foreman-budget">
            <div>
              <dt>Hours</dt>
              <dd>{workspace.goal.grant.maxGoalHours}</dd>
            </div>
            <div>
              <dt>Teams</dt>
              <dd>{workspace.goal.grant.maxTeamsPerGoal}</dd>
            </div>
            <div>
              <dt>Concurrent work</dt>
              <dd>{workspace.goal.grant.maxConcurrentActions}</dd>
            </div>
            <div>
              <dt>Reviews</dt>
              <dd>
                {workspace.goal.turnsUsed} / {workspace.goal.grant.maxForemanTurns}
              </dd>
            </div>
          </dl>
          <div className="foreman-toolbar-actions">
            {workspace.goal.state === "proposed" && (
              <button
                className="compact-button"
                disabled={busy}
                onClick={() => void control("approve")}
              >
                <Check size={16} />
                Approve goal
              </button>
            )}
            {workspace.goal.state === "running" && (
              <button
                className="compact-button"
                disabled={busy}
                onClick={() => void control("pause")}
              >
                <Pause size={16} />
                Pause
              </button>
            )}
            {["paused", "blocked"].includes(workspace.goal.state) && (
              <button
                className="compact-button"
                disabled={busy}
                onClick={() => void control("resume")}
              >
                <Play size={16} />
                Resume
              </button>
            )}
            {workspace.goal.state === "awaiting-acceptance" && (
              <button
                className="compact-button"
                disabled={busy}
                onClick={() => void control("accept")}
              >
                <Check size={16} />
                Accept outcome
              </button>
            )}
            {!["completed", "cancelled"].includes(workspace.goal.state) && (
              <button
                className="compact-button"
                disabled={busy}
                onClick={() => void control("cancel")}
              >
                <X size={16} />
                Cancel goal
              </button>
            )}
            <button
              className="compact-button"
              disabled={busy}
              onClick={() => {
                const cancel = !["completed", "cancelled"].includes(workspace.goal.state);
                setCleanup({
                  command: {
                    scope: "goal",
                    requestId: crypto.randomUUID(),
                    confirmation: true,
                    goal: { id: workspace.goal.id, expectedRevision: workspace.goal.revision },
                    cancel,
                  },
                  title: cancel ? "Cancel and remove goal?" : "Remove goal?",
                  detail: `${workspace.goal.title}. ${cancel ? "Future goal work will be cancelled. Existing provider work is not forcibly interrupted and remains visible under live effects." : "Remove this finished goal from the normal list."}`,
                });
              }}
            >
              <Trash2 size={16} aria-hidden="true" />
              {["completed", "cancelled"].includes(workspace.goal.state)
                ? "Remove goal"
                : "Cancel and remove"}
            </button>
          </div>
          <h4>Decisions</h4>
          {workspace.decisions.length === 0 && <p>No decisions pending</p>}
          {workspace.decisions.map((decision) => (
            <section
              className="foreman-goal-decision"
              key={decision.id}
              aria-label={`Decision ${decision.id}`}
            >
              <p>{decision.question}</p>
              {decision.recommendation && <p>Recommendation: {decision.recommendation}</p>}
              {decision.state !== "pending" ? (
                <p>
                  {decision.state}
                  {decision.answer ? `: ${decision.answer}` : ""}
                </p>
              ) : decision.options.length ? (
                <div className="foreman-toolbar">
                  {decision.options.map((option) => (
                    <button
                      key={option}
                      className="compact-button"
                      disabled={busy}
                      onClick={() => void decide(decision, option)}
                    >
                      <Check size={16} />
                      {option}
                    </button>
                  ))}
                </div>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void decide(decision, answers[decision.id] ?? "");
                  }}
                >
                  <label>
                    Answer
                    <textarea
                      required
                      maxLength={16384}
                      value={answers[decision.id] ?? ""}
                      onChange={(event) =>
                        setAnswers({ ...answers, [decision.id]: event.target.value })
                      }
                    />
                  </label>
                  <button className="compact-button" disabled={busy} type="submit">
                    <Send size={16} />
                    Submit answer
                  </button>
                </form>
              )}
            </section>
          ))}
          {(workspace.preparations?.length ?? 0) > 0 && (
            <section aria-label="Workspace preparations">
              <h4>Workspace preparations</h4>
              <ul className="foreman-goal-list foreman-preparation-list">
                {workspace.preparations?.map((preparation) => {
                  const nextActor = ["cancelled", "ready", "delegated"].includes(preparation.phase)
                    ? "None"
                    : ["held", "expired", "needs-approval"].includes(preparation.phase) ||
                        workspace.goal.state !== "running" ||
                        workspace.decisions.some(
                          (decision) => decision.blocking && decision.state === "pending",
                        )
                      ? "Human"
                      : "Daemon";
                  return (
                    <li key={preparation.id} aria-label={`Preparation ${preparation.groupId}`}>
                      <strong>Team: {preparation.groupId}</strong>
                      <dl className="foreman-budget">
                        <div>
                          <dt>Phase</dt>
                          <dd>{preparation.phase}</dd>
                        </div>
                        <div>
                          <dt>Reason</dt>
                          <dd>{preparation.reason ?? "No blocker"}</dd>
                        </div>
                        <div>
                          <dt>Next actor</dt>
                          <dd>{nextActor}</dd>
                        </div>
                        <div>
                          <dt>Pinned base</dt>
                          <dd>
                            <code>{preparation.sourceHead ?? "Not yet resolved"}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Source checkout</dt>
                          <dd>
                            <code>{preparation.sourceCheckoutId ?? "Not yet resolved"}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Target checkout</dt>
                          <dd>
                            <code>{preparation.checkoutId ?? "Not yet prepared"}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Source disposition</dt>
                          <dd>
                            {preparation.sourceDirty === true
                              ? "Uncommitted changes are NOT copied. Source files are unchanged."
                              : preparation.sourceDirty === false
                                ? "Clean at last check"
                                : "Not recorded"}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <h4>Team ownership</h4>
          <ul className="foreman-goal-list">
            {workspace.delegations.map((delegation) => (
              <li key={delegation.id}>
                <strong>{delegation.memberId}</strong>
                <span>{delegation.state}</span>
                <p>{delegation.rationale}</p>
                <code>{delegation.groupId}</code>
              </li>
            ))}
          </ul>
          <h4>Progress and evidence</h4>
          {workspace.reports.map((report) => (
            <section className="foreman-goal-report" key={report.id}>
              <strong>
                {report.kind} / {report.memberId}
              </strong>
              <p>{report.summary}</p>
              {report.candidatePath && (
                <p>
                  Working-tree candidate: <code>{report.candidatePath}</code>
                  <br />
                  <code>{report.candidateDigest}</code>
                </p>
              )}
              {report.evidence.length > 0 && (
                <ul>
                  {report.evidence.map((evidence) => (
                    <li key={evidence}>{evidence}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </>
      ) : (
        <>
          <div className="foreman-toolbar">
            <h3>Goals</h3>
            <button
              className="compact-button"
              disabled={busy || finished.length === 0}
              onClick={() =>
                setCleanup({
                  command: {
                    scope: "finished-goals",
                    requestId: crypto.randomUUID(),
                    confirmation: true,
                    goals: finished.map((goal) => ({
                      id: goal.id,
                      expectedRevision: goal.revision,
                    })),
                  },
                  title: `Clear ${finished.length} finished goals?`,
                  detail:
                    "Only the selected completed and cancelled goals will be removed from the list. Active goals and goals that finish after this confirmation opens are unchanged.",
                })
              }
            >
              <Trash2 size={16} aria-hidden="true" />
              Clear finished
            </button>
            <button
              disabled={!configuration?.enabled}
              className="compact-button"
              onClick={() => {
                setTitle("");
                setObjective("");
                setConstraints("");
                setCreating(true);
              }}
            >
              <Plus size={16} />
              New goal
            </button>
          </div>
          {goals.length === 0 && <p>No goals</p>}
          <ul className="foreman-goal-list">
            {goals.map((goal) => (
              <li key={goal.id}>
                <button onClick={() => setSelected(goal.id)}>
                  <strong>{goal.title}</strong>
                  <span>{goal.state}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
