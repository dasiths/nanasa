import type { AgentRun, AgentStatusSummary, GroupMembership } from "@nanasa/contracts";

export type MemberStatusKey =
  | "failed"
  | "needs-approval"
  | "needs-input"
  | "stuck"
  | "starting"
  | "working"
  | "done"
  | "idle"
  | "stopped"
  | "not-started"
  | "unknown";

export interface MemberStatusView {
  key: MemberStatusKey;
  label: string;
  rank: number;
  attentionWorthy: boolean;
  run?: AgentRun;
  status?: AgentStatusSummary;
}

const statusPresentation = {
  failed: { label: "Failed", rank: 1, attentionWorthy: true },
  "needs-approval": { label: "Needs approval", rank: 2, attentionWorthy: true },
  "needs-input": { label: "Needs input", rank: 3, attentionWorthy: true },
  stuck: { label: "Stuck", rank: 4, attentionWorthy: true },
  starting: { label: "Starting", rank: 5, attentionWorthy: false },
  working: { label: "Working", rank: 6, attentionWorthy: false },
  done: { label: "Done", rank: 7, attentionWorthy: true },
  idle: { label: "Idle", rank: 8, attentionWorthy: false },
  stopped: { label: "Stopped", rank: 9, attentionWorthy: false },
  "not-started": { label: "Not started", rank: 10, attentionWorthy: false },
  unknown: { label: "Unknown", rank: 11, attentionWorthy: false },
} as const satisfies Record<
  MemberStatusKey,
  { label: string; rank: number; attentionWorthy: boolean }
>;

const activeRecoveryPhases = new Set<AgentRun["recoveryPhase"]>([
  "reconciling",
  "resuming",
  "restarting",
]);

export function currentMemberRun(
  runs: readonly AgentRun[],
  member: GroupMembership,
): AgentRun | undefined {
  return runs
    .filter((run) => run.groupId === member.groupId && run.memberId === member.memberId)
    .sort((left, right) => right.generation - left.generation)[0];
}

function currentMemberStatus(
  statuses: readonly AgentStatusSummary[] | undefined,
  member: GroupMembership,
  run: AgentRun | undefined,
): AgentStatusSummary | undefined {
  const candidates = statuses?.filter(
    (candidate) => candidate.groupId === member.groupId && candidate.memberId === member.memberId,
  );
  if (run === undefined) {
    return candidates?.find(
      (candidate) => candidate.runId === undefined && candidate.generation === undefined,
    );
  }

  const compatible = candidates?.filter(
    (candidate) =>
      (candidate.runId === undefined || candidate.runId === run.id) &&
      (candidate.generation === undefined || candidate.generation === run.generation),
  );
  return (
    compatible?.find(
      (candidate) => candidate.runId === run.id && candidate.generation === run.generation,
    ) ??
    compatible?.find(
      (candidate) => candidate.runId === run.id && candidate.generation === undefined,
    ) ??
    compatible?.find(
      (candidate) => candidate.runId === undefined && candidate.generation === run.generation,
    ) ??
    compatible?.find(
      (candidate) => candidate.runId === undefined && candidate.generation === undefined,
    )
  );
}

function view(
  key: MemberStatusKey,
  run: AgentRun | undefined,
  status: AgentStatusSummary | undefined,
): MemberStatusView {
  return {
    key,
    ...statusPresentation[key],
    ...(run === undefined ? {} : { run }),
    ...(status === undefined ? {} : { status }),
  };
}

export function memberStatusView(
  statuses: readonly AgentStatusSummary[] | undefined,
  runs: readonly AgentRun[],
  member: GroupMembership,
): MemberStatusView {
  const run = currentMemberRun(runs, member);
  const status = currentMemberStatus(statuses, member, run);

  if (run === undefined) return view("not-started", undefined, status);
  if (
    status?.state === "failed" ||
    status?.outcome === "failed" ||
    status?.attention === "process_failed" ||
    run.status === "failed" ||
    run.recoveryPhase === "failed"
  ) {
    return view("failed", run, status);
  }
  if (status?.attention === "decision_required") return view("needs-approval", run, status);
  if (status?.attention === "input_required" || status?.state === "blocked") {
    return view("needs-input", run, status);
  }
  if (status?.state === "suspected_stuck" || status?.attention === "progress_stale") {
    return view("stuck", run, status);
  }
  if (
    activeRecoveryPhases.has(run.recoveryPhase) ||
    status?.state === "starting" ||
    (status === undefined && run.status === "starting")
  ) {
    return view("starting", run, status);
  }
  if (
    status?.state === "working" ||
    status?.state === "waiting" ||
    (status === undefined && (run.status === "running" || run.recoveryPhase === "recovered"))
  ) {
    return view("working", run, status);
  }
  if (status?.state === "idle" && status.completionPending) return view("done", run, status);
  if (status?.state === "idle") return view("idle", run, status);
  if (
    status?.state === "stopped" ||
    (status === undefined && (run.status === "stopping" || run.status === "stopped"))
  ) {
    return view("stopped", run, status);
  }
  return view("unknown", run, status);
}
