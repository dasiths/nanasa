import type { AgentRun, AgentStatusSummary, GroupMembership } from "@nanasa/contracts";
import { describe, expect, it } from "vitest";
import { currentMemberRun, type MemberStatusKey, memberStatusView } from "./member-status.js";

const timestamp = "2026-08-31T12:00:00.000Z";

const member: GroupMembership = {
  id: "membership-one",
  groupId: "group-one",
  memberId: "member-one",
  agentProfileId: "profile-one",
  alias: "Builder",
  order: 0,
  state: "active",
  joinedAt: timestamp,
};

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-one",
    groupId: member.groupId,
    memberId: member.memberId,
    agentProfileId: member.agentProfileId,
    generation: 1,
    status: "running",
    desiredState: "running",
    recoveryPhase: "idle",
    recoveryAttempts: 0,
    launchKind: "fresh",
    requestedModelSource: "provider-default",
    startedAt: timestamp,
    ...overrides,
  };
}

function status(overrides: Partial<AgentStatusSummary> = {}): AgentStatusSummary {
  return {
    groupId: member.groupId,
    memberId: member.memberId,
    alias: member.alias,
    agentType: "copilot",
    runId: "run-one",
    generation: 1,
    runStatus: "running",
    state: "unknown",
    phase: "startup",
    outcome: "unknown",
    confidence: "high",
    attention: "none",
    observedAt: timestamp,
    stateChangedAt: timestamp,
    statusRevision: 1,
    completionRevision: 0,
    operatorAcknowledgedCompletionRevision: 0,
    completionPending: false,
    interactiveReady: false,
    staleAuthority: false,
    authorityKind: "process",
    evidenceConfidence: "high",
    processState: "present",
    ...overrides,
  };
}

const expectedPresentation: Record<
  MemberStatusKey,
  { label: string; rank: number; attentionWorthy: boolean }
> = {
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
};

describe("memberStatusView", () => {
  it.each([
    ["failed", status({ state: "failed" }), run()],
    ["needs-approval", status({ state: "blocked", attention: "decision_required" }), run()],
    ["needs-input", status({ state: "blocked", attention: "input_required" }), run()],
    ["stuck", status({ state: "suspected_stuck", attention: "progress_stale" }), run()],
    ["starting", status({ state: "starting" }), run({ status: "starting" })],
    ["working", status({ state: "working" }), run()],
    [
      "done",
      status({ state: "idle", phase: "settled", completionRevision: 1, completionPending: true }),
      run(),
    ],
    ["idle", status({ state: "idle", phase: "settled" }), run()],
    ["stopped", status({ state: "stopped", phase: "exited" }), run({ status: "stopped" })],
    [
      "not-started",
      status({
        runId: undefined,
        generation: undefined,
        runStatus: undefined,
        processState: "missing",
      }),
      undefined,
    ],
    ["unknown", status({ attention: "reporter_stale" }), run()],
  ] as const)("projects %s with its exact presentation metadata", (key, summary, currentRun) => {
    const result = memberStatusView(
      [summary],
      currentRun === undefined ? [] : [currentRun],
      member,
    );

    expect(result).toMatchObject({ key, ...expectedPresentation[key] });
  });

  it("gives failure precedence over pending completion and active recovery", () => {
    const failed = status({
      state: "idle",
      phase: "settled",
      outcome: "failed",
      completionRevision: 1,
      completionPending: true,
    });

    expect(
      memberStatusView([failed], [run({ recoveryPhase: "restarting" })], member),
    ).toMatchObject({
      key: "failed",
      ...expectedPresentation.failed,
    });
    expect(memberStatusView([status()], [run({ status: "failed" })], member).key).toBe("failed");
    expect(memberStatusView([status()], [run({ recoveryPhase: "failed" })], member).key).toBe(
      "failed",
    );
    expect(memberStatusView([status({ attention: "process_failed" })], [run()], member).key).toBe(
      "failed",
    );
  });

  it("gives approval precedence over defensive blocked and input states", () => {
    expect(
      memberStatusView(
        [status({ state: "blocked", attention: "decision_required" })],
        [run()],
        member,
      ).key,
    ).toBe("needs-approval");
    expect(memberStatusView([status({ state: "blocked" })], [run()], member).key).toBe(
      "needs-input",
    );
  });

  it("treats ordinary waiting as Working but preserves explicit human attention", () => {
    expect(memberStatusView([status({ state: "waiting" })], [run()], member)).toMatchObject({
      key: "working",
      attentionWorthy: false,
    });
    expect(
      memberStatusView(
        [status({ state: "waiting", attention: "input_required" })],
        [run()],
        member,
      ),
    ).toMatchObject({ key: "needs-input", attentionWorthy: true });
  });

  it("projects either suspected-stuck state or progress-stale attention as Stuck", () => {
    expect(memberStatusView([status({ state: "suspected_stuck" })], [run()], member).key).toBe(
      "stuck",
    );
    expect(memberStatusView([status({ attention: "progress_stale" })], [run()], member).key).toBe(
      "stuck",
    );
  });

  it.each(["reconciling", "resuming", "restarting"] as const)(
    "projects active %s recovery as Starting",
    (recoveryPhase) => {
      expect(
        memberStatusView(
          [status({ state: "unknown", attention: "reporter_stale" })],
          [run({ recoveryPhase })],
          member,
        ).key,
      ).toBe("starting");
    },
  );

  it("uses lifecycle fallbacks only when no compatible semantic summary exists", () => {
    expect(memberStatusView(undefined, [run({ status: "starting" })], member).key).toBe("starting");
    expect(memberStatusView(undefined, [run({ status: "running" })], member).key).toBe("working");
    expect(
      memberStatusView(undefined, [run({ status: "stopped", recoveryPhase: "recovered" })], member)
        .key,
    ).toBe("working");
    expect(memberStatusView(undefined, [run({ status: "stopping" })], member).key).toBe("stopped");
    expect(memberStatusView(undefined, [run({ status: "stopped" })], member).key).toBe("stopped");

    const reporterStale = status({ attention: "reporter_stale" });
    expect(memberStatusView([reporterStale], [run({ status: "running" })], member)).toMatchObject({
      key: "unknown",
      attentionWorthy: false,
      status: reporterStale,
    });
  });

  it("ignores stale run identities and generations while retaining an exact current summary", () => {
    const currentRun = run({ id: "run-two", generation: 2, status: "starting" });
    const staleRun = status({ state: "failed", runId: "run-one", generation: 2 });
    const staleGeneration = status({ state: "failed", runId: "run-two", generation: 1 });
    const exact = status({ state: "working", runId: "run-two", generation: 2 });
    const result = memberStatusView([staleRun, staleGeneration, exact], [currentRun], member);

    expect(result).toMatchObject({ key: "working", run: currentRun, status: exact });
  });

  it("falls back from an older failed summary to the replacement run lifecycle", () => {
    const currentRun = run({ id: "run-two", generation: 2, recoveryPhase: "restarting" });
    const stale = status({ state: "failed", runId: "run-one", generation: 1 });

    expect(memberStatusView([stale], [currentRun], member)).toMatchObject({
      key: "starting",
      attentionWorthy: false,
      run: currentRun,
    });
    expect(memberStatusView([stale], [currentRun], member).status).toBeUndefined();
  });

  it("accepts absent summary run identity for compatibility", () => {
    const compatible = status({ state: "working", runId: undefined, generation: undefined });

    expect(memberStatusView([compatible], [run()], member)).toMatchObject({
      key: "working",
      status: compatible,
    });
  });

  it("selects the greatest generation for the exact group and member", () => {
    const otherGroup = run({ id: "other-group", groupId: "group-two", generation: 9 });
    const otherMember = run({ id: "other-member", memberId: "member-two", generation: 8 });
    const older = run({ id: "older", generation: 1 });
    const current = run({ id: "current", generation: 3 });

    expect(currentMemberRun([otherGroup, otherMember, older, current], member)).toBe(current);
    expect(memberStatusView(undefined, [otherGroup], member).key).toBe("not-started");
  });

  it("does not cross-associate a status from the same member ID in another group", () => {
    const otherGroupStatus = status({ groupId: "group-two", state: "failed" });
    const exactGroupStatus = status({ state: "working" });

    expect(memberStatusView([otherGroupStatus, exactGroupStatus], [run()], member)).toMatchObject({
      key: "working",
      status: exactGroupStatus,
    });
  });

  it("does not attach an explicitly run-bound summary when no current run exists", () => {
    const stale = status({ state: "failed" });

    expect(memberStatusView([stale], [], member)).toEqual({
      key: "not-started",
      ...expectedPresentation["not-started"],
    });
  });
});
