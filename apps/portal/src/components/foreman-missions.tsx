import {
  CreateMissionCommandSchema,
  type ForemanConfig,
  type Mission,
  type MissionControlCommand,
  type MissionWorkspace,
} from "@nanasa/contracts";
import { ArrowLeft, Check, Pause, Play, Plus, ShieldOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";

export function ForemanMissions({
  client,
  configuration,
  onNavigate,
}: {
  client: PortalClient;
  configuration: ForemanConfig | undefined;
  onNavigate(path: string): void;
}) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selected, setSelected] = useState<string>();
  const [workspace, setWorkspace] = useState<MissionWorkspace>();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [verification, setVerification] = useState("[]");
  const [templates, setTemplates] = useState<string[]>(
    configuration?.autonomy.permittedTeamTemplates ?? [],
  );
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
        const [list, detail] = await Promise.all([
          client.listMissions(),
          selected === undefined ? Promise.resolve(undefined) : client.getMission(selected),
        ]);
        if (!cancelled) {
          setMissions(list);
          setWorkspace(detail);
        }
      } catch (cause) {
        if (!cancelled) setError(toPortalError(cause, "Unable to load missions"));
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
        toPortalError(cause, cause instanceof Error ? cause.message : "Mission operation failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const control = (action: MissionControlCommand["action"]) =>
    operate(async () => {
      if (workspace === undefined) return;
      await client.controlMission(workspace.mission.id, {
        expectedRevision: workspace.mission.revision,
        action,
      });
    });
  const create = () =>
    operate(async () => {
      if (configuration === undefined) return;
      const criteria = acceptance
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      const commands: unknown = JSON.parse(verification);
      if (!Array.isArray(commands))
        throw new Error("Verification commands must be a JSON array of argument arrays");
      const body = {
        title,
        objective,
        acceptance: criteria,
        grant: { ...configuration.autonomy, permittedTeamTemplates: templates },
        verification: commands.map((command, index) => ({
          id: `check-${index + 1}`,
          command,
          acceptanceIndexes: criteria.map((_criterion, index) => index),
          timeoutSeconds: 300,
        })),
      };
      const digest = JSON.stringify(body);
      if (request.current?.body !== digest)
        request.current = { body: digest, id: crypto.randomUUID() };
      const mission = await client.createMission(
        CreateMissionCommandSchema.parse({ ...body, requestId: request.current.id }),
      );
      setSelected(mission.id);
      setCreating(false);
      setTitle("");
      setObjective("");
      setAcceptance("");
      request.current = undefined;
    });
  return (
    <section className="foreman-missions" aria-label="Missions">
      {error !== undefined && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {creating ? (
        <form
          className="foreman-settings"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="foreman-toolbar">
            <h3>New mission</h3>
            <button
              type="button"
              className="icon-button"
              aria-label="Cancel mission creation"
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
              Objective
              <textarea
                rows={3}
                required
                maxLength={16384}
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <label className="foreman-wide">
              Acceptance criteria
              <textarea
                rows={4}
                required
                value={acceptance}
                onChange={(event) => setAcceptance(event.target.value)}
              />
            </label>
            <label className="foreman-wide">
              Verification commands (JSON argument arrays)
              <textarea
                rows={3}
                value={verification}
                onChange={(event) => setVerification(event.target.value)}
              />
            </label>
            <div className="foreman-wide">
              <span>Approved templates</span>
              {configuration?.autonomy.permittedTeamTemplates.map((id) => (
                <label className="foreman-checkbox" key={id}>
                  <input
                    type="checkbox"
                    checked={templates.includes(id)}
                    onChange={(event) =>
                      setTemplates(
                        event.target.checked
                          ? [...templates, id]
                          : templates.filter((value) => value !== id),
                      )
                    }
                  />
                  {id}
                </label>
              ))}
            </div>
            <dl className="foreman-budget foreman-wide">
              <div>
                <dt>Mode</dt>
                <dd>{configuration?.autonomy.mode}</dd>
              </div>
              <div>
                <dt>Hours</dt>
                <dd>{configuration?.autonomy.maxMissionHours}</dd>
              </div>
              <div>
                <dt>Concurrent tasks</dt>
                <dd>{configuration?.autonomy.maxConcurrentTasks}</dd>
              </div>
              <div>
                <dt>Turns</dt>
                <dd>{configuration?.autonomy.maxForemanTurns}</dd>
              </div>
            </dl>
          </fieldset>
          <button type="submit" className="primary-button" disabled={busy}>
            <Plus size={15} aria-hidden="true" />
            Create mission
          </button>
        </form>
      ) : selected === undefined ? (
        <>
          <header className="foreman-toolbar">
            <h3>Missions</h3>
            <button
              className="compact-button"
              disabled={configuration?.enabled !== true}
              onClick={() => setCreating(true)}
            >
              <Plus size={15} aria-hidden="true" />
              New mission
            </button>
          </header>
          {missions.length === 0 ? (
            <p className="foreman-empty">No missions yet</p>
          ) : (
            <ul className="foreman-mission-list">
              {missions.map((mission) => (
                <li key={mission.id}>
                  <button onClick={() => setSelected(mission.id)}>
                    <strong>{mission.title}</strong>
                    <span>{mission.state}</span>
                    <small>
                      {mission.turnsUsed}/{mission.grant.maxForemanTurns} turns
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : workspace === undefined ? (
        <p role="status">Loading mission</p>
      ) : (
        <>
          <button className="compact-button" onClick={() => setSelected(undefined)}>
            <ArrowLeft size={15} aria-hidden="true" />
            All missions
          </button>
          <header className="foreman-toolbar">
            <h3>{workspace.mission.title}</h3>
            <span>{workspace.mission.state}</span>
          </header>
          <p className="foreman-mission-objective">{workspace.mission.objective}</p>
          <div className="foreman-toolbar-actions" aria-label="Mission controls">
            {workspace.mission.state === "planning" && (
              <button
                disabled={busy}
                className="compact-button"
                onClick={() => void control("start")}
              >
                <Play size={15} />
                Start mission
              </button>
            )}
            {workspace.mission.state === "running" && (
              <button
                disabled={busy}
                className="compact-button"
                onClick={() => void control("pause")}
              >
                <Pause size={15} />
                Pause mission
              </button>
            )}
            {["paused", "blocked"].includes(workspace.mission.state) && (
              <button
                disabled={busy}
                className="compact-button"
                onClick={() => void control("resume")}
              >
                <Play size={15} />
                Resume mission
              </button>
            )}
            {workspace.mission.state === "awaiting-acceptance" && (
              <button
                disabled={busy}
                className="primary-button"
                onClick={() => void control("accept")}
              >
                <Check size={15} />
                Accept verified result
              </button>
            )}
            {!["completed", "cancelled", "revoked", "failed"].includes(workspace.mission.state) && (
              <button
                disabled={busy}
                className="compact-button"
                onClick={() => void control("revoke")}
              >
                <ShieldOff size={15} />
                Revoke mission
              </button>
            )}
          </div>
          <dl className="foreman-budget">
            <div>
              <dt>Turns used</dt>
              <dd>
                {workspace.mission.turnsUsed}/{workspace.mission.grant.maxForemanTurns}
              </dd>
            </div>
            <div>
              <dt>Recovery attempts</dt>
              <dd>
                {workspace.mission.recoveryAttempts}/
                {workspace.mission.grant.recovery.maxAttemptsPerMission}
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{new Date(workspace.mission.expiresAt).toLocaleString()}</dd>
            </div>
          </dl>
          <h4>Acceptance</h4>
          <ol>
            {workspace.mission.acceptance.map((criterion, index) => (
              <li key={`${index}:${criterion}`}>{criterion}</li>
            ))}
          </ol>
          <h4>Decisions</h4>
          {(workspace.approvals ?? []).filter((approval) => approval.state === "pending").length ===
          0 ? (
            <p>No decisions pending</p>
          ) : (
            <ul className="foreman-mission-list">
              {workspace.approvals
                ?.filter((approval) => approval.state === "pending")
                .map((approval) => (
                  <li key={approval.id}>
                    <span>{approval.summary}</span>
                    <button
                      className="compact-button"
                      disabled={busy}
                      onClick={() =>
                        void operate(() =>
                          client.decideMissionApproval(approval.id, {
                            expectedGrantRevision: approval.grantRevision,
                            decision: "approved",
                          }),
                        )
                      }
                    >
                      <Check size={14} />
                      Approve
                    </button>
                    <button
                      className="compact-button"
                      disabled={busy}
                      onClick={() =>
                        void operate(() =>
                          client.decideMissionApproval(approval.id, {
                            expectedGrantRevision: approval.grantRevision,
                            decision: "denied",
                          }),
                        )
                      }
                    >
                      <X size={14} />
                      Deny
                    </button>
                  </li>
                ))}
            </ul>
          )}
          <h4>Tasks</h4>
          {workspace.tasks.length === 0 ? (
            <p>No tasks planned</p>
          ) : (
            <ul className="foreman-mission-list">
              {workspace.tasks.map((task) => (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  <span>
                    {task.roleId} / {task.state}
                  </span>
                  {task.runId && task.groupId && (
                    <button
                      className="compact-button"
                      onClick={() =>
                        onNavigate(
                          `/groups/${encodeURIComponent(task.groupId!)}/terminals/${encodeURIComponent(task.runId!)}`,
                        )
                      }
                    >
                      Open task terminal
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h4>Verification</h4>
          {(workspace.evidence ?? []).length === 0 ? (
            <p>No verification evidence yet</p>
          ) : (
            <ul className="foreman-mission-list">
              {workspace.evidence?.map((evidence) => (
                <li key={evidence.id}>
                  <strong>
                    {evidence.recipeId}: {evidence.state}
                  </strong>
                  <code>{evidence.candidateCommit}</code>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
