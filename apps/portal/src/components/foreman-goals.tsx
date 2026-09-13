import type {
  ForemanConfig,
  ForemanGoal,
  ForemanGoalWorkspace,
  HumanDecision,
} from "@nanasa/contracts";
import { ArrowLeft, Check, Pause, Play, Plus, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";

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
  const request = useRef<{ body: string; id: string } | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setWorkspace(undefined);
    const load = async () => {
      try {
        const list = await client.listForemanGoals();
        const detail = selected ? await client.getForemanGoal(selected) : undefined;
        if (!cancelled) {
          setGoals(list);
          setWorkspace(detail);
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
  return (
    <section className="foreman-goals" aria-label="Goals">
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
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
