import type {
  ProviderUpdateOutcome,
  ProviderUpdateRecoveryResult,
  StartGroupRunOutcome,
  StartGroupRunsResult,
} from "@nanasa/contracts";
import { RefreshCw, ShieldCheck, X } from "lucide-react";
import { useState } from "react";

import { Dialog } from "../a11y/primitives.js";
import { ErrorNotice, portalErrorFromCode } from "../errors.js";

export interface TeamRecoveryCounts {
  kept: number;
  restarted: number;
  approval: number;
  failed: number;
}

export interface TeamRecoveryResultsProps {
  recoveryResult?: ProviderUpdateRecoveryResult | undefined;
  startAllResult?: StartGroupRunsResult | undefined;
  counts: TeamRecoveryCounts;
  agentNames: ReadonlyMap<string, string>;
  pendingApprovalCount: number;
  recovering: boolean;
  approving: boolean;
  onRecover(): void;
  onApproveAndRetry(): void;
  onReview(outcome: StartGroupRunOutcome): void;
  onDismiss(): void;
}

function agents(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"}`;
}

function need(count: number): string {
  return count === 1 ? "needs" : "need";
}

function recoverySummary(counts: TeamRecoveryCounts, dryRun: boolean): string {
  const total = counts.kept + counts.restarted + counts.approval + counts.failed;
  if (total === 0) return "No agents needed recovery.";
  const attention = counts.approval + counts.failed;
  if (dryRun) {
    return `${agents(total)} checked. ${agents(counts.restarted)} would restart and ${agents(attention)} ${need(attention)} review.`;
  }
  return `${agents(total)} processed. ${agents(counts.restarted)} restarted and ${agents(attention)} ${need(attention)} attention.`;
}

function recoveryOutcomeLabel(outcome: ProviderUpdateOutcome, dryRun: boolean): string {
  if (outcome.status === "retained") return dryRun ? "Will keep running" : "Kept running";
  if (outcome.status === "restarted") return dryRun ? "Will restart" : "Restarted";
  if (outcome.status === "approval-required") return "Needs approval";
  if (outcome.status === "ownership-uncertain") return "Needs review";
  return "Needs help";
}

function startOutcomeLabel(outcome: StartGroupRunOutcome): string {
  if (outcome.status === "started") return "Started";
  if (outcome.status === "already-running") return "Kept running";
  if (outcome.status === "approval-required") return "Needs approval";
  if (outcome.status === "denied") return "Approval denied";
  return "Needs help";
}

export function TeamRecoveryResults({
  recoveryResult,
  startAllResult,
  counts,
  agentNames,
  pendingApprovalCount,
  recovering,
  approving,
  onRecover,
  onApproveAndRetry,
  onReview,
  onDismiss,
}: TeamRecoveryResultsProps) {
  const [open, setOpen] = useState(false);
  const dryRun = recoveryResult?.dryRun === true;
  const title = dryRun ? "Team recovery preview" : "Team recovery results";
  const summary = recoverySummary(counts, dryRun);
  const close = () => setOpen(false);

  return (
    <>
      <section className="recovery-status-strip" role="status" aria-live="polite">
        <p>{summary}</p>
        <div className="recovery-status-actions">
          <button type="button" className="compact-button" onClick={() => setOpen(true)}>
            View results
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss recovery results"
            title="Dismiss results"
            onClick={onDismiss}
          >
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      </section>
      <Dialog
        open={open}
        labelledBy="team-recovery-results-title"
        onClose={close}
        className="recovery-results-dialog"
        closeOnBackdrop
      >
        <div className="recovery-results-shell">
          <header className="recovery-results-header">
            <div>
              <span className="eyebrow">Provider recovery</span>
              <h2 id="team-recovery-results-title">{title}</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={`Close ${title.toLowerCase()}`}
              onClick={close}
            >
              <X aria-hidden="true" size={16} />
            </button>
          </header>
          <div className="recovery-results-body">
            <p className="recovery-results-intro">{summary}</p>
            <dl className="recovery-counts" aria-label="Recovery summary">
              <div>
                <dt>Kept running</dt>
                <dd>{counts.kept}</dd>
              </div>
              <div>
                <dt>{dryRun ? "Would restart" : "Restarted"}</dt>
                <dd>{counts.restarted}</dd>
              </div>
              <div>
                <dt>Need approval</dt>
                <dd>{counts.approval}</dd>
              </div>
              <div>
                <dt>Need help</dt>
                <dd>{counts.failed}</dd>
              </div>
            </dl>
            <section className="recovery-outcomes" aria-labelledby="recovery-outcomes-title">
              <h3 id="recovery-outcomes-title">Agent outcomes</h3>
              <ul>
                {recoveryResult?.outcomes.map((outcome) => (
                  <li
                    key={`recovery:${outcome.runId}:${outcome.generation}`}
                    className={`recovery-outcome recovery-outcome-${outcome.status}`}
                  >
                    <div className="recovery-outcome-summary">
                      <strong>{agentNames.get(outcome.memberId) ?? outcome.memberId}</strong>
                      <span>{recoveryOutcomeLabel(outcome, dryRun)}</span>
                    </div>
                    <details>
                      <summary>Technical details</summary>
                      <dl>
                        <div>
                          <dt>Run</dt>
                          <dd>{outcome.runId}</dd>
                        </div>
                        <div>
                          <dt>Generation</dt>
                          <dd>{outcome.generation}</dd>
                        </div>
                        <div>
                          <dt>Previous setup ID</dt>
                          <dd>{outcome.previousSnapshotDigest}</dd>
                        </div>
                        <div>
                          <dt>Current setup ID</dt>
                          <dd>{outcome.currentSnapshotDigest}</dd>
                        </div>
                      </dl>
                    </details>
                  </li>
                ))}
                {startAllResult?.outcomes.map((outcome) => (
                  <li
                    key={`start:${outcome.memberId}`}
                    className={`recovery-outcome recovery-outcome-${outcome.status}`}
                  >
                    <div className="recovery-outcome-summary">
                      <strong>{agentNames.get(outcome.memberId) ?? outcome.memberId}</strong>
                      <span>{startOutcomeLabel(outcome)}</span>
                      {(outcome.status === "approval-required" || outcome.status === "denied") &&
                        outcome.request !== undefined && (
                          <button
                            type="button"
                            className="compact-button recovery-review-button"
                            onClick={() => onReview(outcome)}
                          >
                            Review approval
                          </button>
                        )}
                    </div>
                    {(outcome.runId !== undefined ||
                      outcome.reason !== undefined ||
                      outcome.error !== undefined) && (
                      <details>
                        <summary>Technical details</summary>
                        {outcome.runId !== undefined && <p>Run {outcome.runId}</p>}
                        {outcome.status === "failed" && (
                          <ErrorNotice
                            announce={false}
                            className="start-all-error"
                            error={
                              outcome.error ??
                              portalErrorFromCode(
                                outcome.reason ?? "run_start_failed",
                                "The agent could not be started.",
                              )
                            }
                          />
                        )}
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <footer className="recovery-results-footer">
            <button type="button" className="compact-button" onClick={close}>
              Close
            </button>
            {pendingApprovalCount > 0 && (
              <button
                type="button"
                className="compact-button start-all-approve"
                disabled={approving}
                onClick={onApproveAndRetry}
              >
                {approving ? (
                  <RefreshCw className="spin" aria-hidden="true" size={14} />
                ) : (
                  <ShieldCheck aria-hidden="true" size={14} />
                )}
                Approve and retry {agents(pendingApprovalCount)}
              </button>
            )}
            {dryRun && (
              <button
                type="button"
                className="compact-button recovery-primary-action"
                disabled={recovering}
                onClick={onRecover}
              >
                <RefreshCw
                  className={recovering ? "spin" : undefined}
                  aria-hidden="true"
                  size={14}
                />
                Recover team
              </button>
            )}
          </footer>
        </div>
      </Dialog>
    </>
  );
}
