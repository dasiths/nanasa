import type { AgentRun, AgentStatusSummary, GroupMembership } from "@nanasa/contracts";

export function currentMemberRun(
  runs: readonly AgentRun[],
  member: GroupMembership,
): AgentRun | undefined {
  return runs
    .filter((run) => run.groupId === member.groupId && run.memberId === member.memberId)
    .sort((left, right) => right.generation - left.generation)[0];
}

export function memberStatusView(
  statuses: readonly AgentStatusSummary[] | undefined,
  runs: readonly AgentRun[],
  member: GroupMembership,
): { label: string; run?: AgentRun; status?: AgentStatusSummary } {
  const status = statuses?.find(
    (candidate) => candidate.groupId === member.groupId && candidate.memberId === member.memberId,
  );
  const run = currentMemberRun(runs, member);
  if (status !== undefined) {
    return { label: status.state, ...(run === undefined ? {} : { run }), status };
  }
  if (run === undefined) return { label: "not_started" };
  return {
    label: run.recoveryPhase === "idle" ? run.status : run.recoveryPhase,
    run,
  };
}
