import type {
  AgentAction,
  AgentActionAcknowledgement,
  AgentActionAttempt,
  AgentActionWorkspace,
  AgentRun,
  AgentStatusSummary,
  Group,
  GroupMembership,
  OpenWait,
  PortalSnapshot,
} from "@nanasa/contracts";
import { describe, expect, it } from "vitest";
import {
  type AttentionItem,
  attentionActiveProgressCount,
  attentionCategoryCount,
  attentionCounts,
  attentionItemsByCategory,
  attentionItemsForScope,
  attentionReviewCount,
  attentionReviewCountsByGroup,
  attentionReviewItems,
  attentionUnreadMessageCount,
  deriveAttentionItems,
  groupAttentionItems,
  repositoryAttentionItems,
} from "./attention-items.js";
import { launchConsentRequest } from "./test/launch-consent-fixture.js";

const timestamp = "2026-08-31T12:00:00.000Z";

const groups: Group[] = [
  {
    id: "group-b",
    name: "Beta",
    order: 1,
    membershipRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    id: "group-a",
    name: "Alpha",
    order: 0,
    membershipRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];

function member(
  memberId: string,
  groupId = "group-a",
  overrides: Partial<GroupMembership> = {},
): GroupMembership {
  return {
    id: `${groupId}-${memberId}-membership`,
    groupId,
    memberId,
    agentProfileId: "profile-one",
    alias: memberId.replace(/^./, (value) => value.toUpperCase()),
    order: 0,
    state: "active",
    joinedAt: timestamp,
    ...overrides,
  };
}

function run(owner: GroupMembership, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: `run-${owner.groupId}-${owner.memberId}`,
    groupId: owner.groupId,
    memberId: owner.memberId,
    agentProfileId: owner.agentProfileId,
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

function status(
  owner: GroupMembership,
  ownerRun: AgentRun,
  overrides: Partial<AgentStatusSummary> = {},
): AgentStatusSummary {
  return {
    groupId: owner.groupId,
    memberId: owner.memberId,
    alias: owner.alias,
    agentType: "copilot",
    runId: ownerRun.id,
    generation: ownerRun.generation,
    runStatus: ownerRun.status,
    state: "working",
    phase: "model",
    outcome: "unknown",
    confidence: "high",
    attention: "none",
    observedAt: timestamp,
    stateChangedAt: timestamp,
    statusRevision: 1,
    completionRevision: 0,
    operatorAcknowledgedCompletionRevision: 0,
    completionPending: false,
    interactiveReady: true,
    staleAuthority: false,
    authorityKind: "reporter",
    authorityId: "reporter-one",
    evidenceConfidence: "high",
    processState: "present",
    ...overrides,
  };
}

function snapshot(overrides: Partial<PortalSnapshot> = {}): PortalSnapshot {
  return {
    instanceId: "daemon-one",
    daemonEpoch: 1,
    sequence: 1,
    generatedAt: timestamp,
    orderRevision: 1,
    groups,
    agentProfiles: [],
    memberships: [],
    runs: [],
    repositories: [],
    checkouts: [],
    worktrees: [],
    messages: [],
    deliveryOutcomes: [],
    ...overrides,
  };
}

function action(
  owner: GroupMembership,
  ownerRun: AgentRun,
  id: string,
  overrides: Partial<AgentAction> = {},
): AgentAction {
  return {
    version: 1,
    id,
    kind: "prompt",
    principal: { kind: "operator", operatorId: "operator-one" },
    target: {
      groupId: owner.groupId,
      memberId: owner.memberId,
      runId: ownerRun.id,
      generation: ownerRun.generation,
      daemonEpoch: 1,
      reporterSessionId: "reporter-session-one",
      reporterId: "reporter-one",
      reporterEpoch: "reporter-epoch-one",
      baselineStatusRevision: 1,
      baselineCompletionRevision: 0,
    },
    idempotencyKey: `key-${id}`,
    requestDigest: "a".repeat(64),
    prompt: "Continue the task",
    allowWorking: false,
    state: "started",
    queueDeadlineAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function wait(
  owner: GroupMembership,
  ownerRun: AgentRun,
  id: string,
  overrides: Partial<OpenWait> = {},
): OpenWait {
  return {
    id,
    groupId: owner.groupId,
    memberId: owner.memberId,
    runId: ownerRun.id,
    generation: ownerRun.generation,
    reporterSessionId: "reporter-session-one",
    reporterId: "reporter-one",
    reporterEpoch: "reporter-epoch-one",
    providerRequestId: `request-${id}`,
    kind: "question",
    summary: `Question ${id}`,
    replyChannel: "terminal",
    openedStatusRevision: 1,
    state: "open",
    openedAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function attempt(source: AgentAction): AgentActionAttempt {
  return {
    id: `attempt-${source.id}`,
    actionId: source.id,
    attempt: 1,
    effect: "terminal-injection",
    state: "submitted",
    daemonEpoch: 1,
    groupId: source.target.groupId,
    memberId: source.target.memberId,
    runId: source.target.runId,
    generation: source.target.generation,
    reporterSessionId: source.target.reporterSessionId,
    reporterId: source.target.reporterId,
    reporterEpoch: source.target.reporterEpoch,
    baselineStatusRevision: source.target.baselineStatusRevision,
    baselineCompletionRevision: source.target.baselineCompletionRevision,
    terminalBinding: {
      serverName: "nanasa",
      sessionId: "session-one",
      windowId: "@1",
      paneId: "%1",
    },
    terminalBindingFingerprint: "b".repeat(64),
    leaseOwner: "daemon-one",
    leaseExpiresAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    submittedAt: timestamp,
  };
}

function acknowledgement(
  source: AgentAction,
  sourceAttempt: AgentActionAttempt,
): AgentActionAcknowledgement {
  return {
    id: `ack-${source.id}`,
    actionId: source.id,
    attemptId: sourceAttempt.id,
    kind: "started",
    runId: source.target.runId,
    generation: source.target.generation,
    reporterSessionId: source.target.reporterSessionId,
    reporterId: source.target.reporterId,
    reporterEpoch: source.target.reporterEpoch,
    sourceSequence: 1,
    completionRevision: 0,
    acknowledgedAt: timestamp,
    data: {},
  };
}

function workspace(
  groupId: string,
  overrides: Partial<AgentActionWorkspace> = {},
): AgentActionWorkspace {
  return {
    groupId,
    actions: [],
    attempts: [],
    acknowledgements: [],
    openWaits: [],
    ...overrides,
  };
}

function itemOfKind<Kind extends AttentionItem["kind"]>(
  items: readonly AttentionItem[],
  kind: Kind,
): Extract<AttentionItem, { kind: Kind }> {
  const item = items.find(
    (candidate): candidate is Extract<AttentionItem, { kind: Kind }> => candidate.kind === kind,
  );
  expect(item, `Expected an item of kind ${kind}`).toBeDefined();
  return item!;
}

describe("deriveAttentionItems", () => {
  it("projects only the latest actionable launch consent per member", () => {
    const owner = member("builder", "group-a");
    const requests = [
      launchConsentRequest({
        id: "old-consent",
        groupId: "group-a",
        memberId: owner.memberId,
        state: "denied",
        requestedAt: "2026-09-02T09:00:00.000Z",
      }),
      launchConsentRequest({
        id: "current-consent",
        groupId: "group-a",
        memberId: owner.memberId,
      }),
    ];

    const items = deriveAttentionItems(snapshot({ memberships: [owner] }), {
      launchConsents: requests,
    });

    expect(items).toHaveLength(1);
    expect(itemOfKind(items, "launch-consent")).toMatchObject({
      category: "response",
      urgency: "high",
      counted: true,
      consentState: "pending",
      request: { id: "current-consent" },
      targetPath: "/groups/group-a/terminals#launch-consent-current-consent",
    });
  });

  it("counts update failures but keeps successful restarts as informational activity", () => {
    const uncertainOwner = member("reviewer");
    const restartedOwner = member("builder");
    const approvalOwner = member("operator");
    const transition = {
      id: "update-one",
      runId: "run-old",
      generation: 1,
      memberId: uncertainOwner.memberId,
      providerId: "copilot",
      previousSnapshotDigest: "a".repeat(64),
      currentSnapshotDigest: "b".repeat(64),
      state: "completed" as const,
      detectedAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    };
    const uncertainRun = run(uncertainOwner, {
      status: "failed",
      recoveryPhase: "failed",
      providerUpdate: {
        ...transition,
        outcome: "ownership-uncertain",
        safeError: {
          code: "provider_update_ownership_uncertain",
          message: "Nanasa could not safely identify the old process",
          retryable: false,
        },
      },
    });
    const restartedRun = run(restartedOwner, {
      id: "run-new",
      generation: 2,
      providerUpdate: {
        ...transition,
        id: "update-two",
        memberId: restartedOwner.memberId,
        outcome: "restarted",
        replacementRunId: "run-new",
      },
    });
    const approvalRun = run(approvalOwner, {
      status: "failed",
      recoveryPhase: "failed",
      providerUpdate: {
        ...transition,
        id: "update-three",
        memberId: approvalOwner.memberId,
        outcome: "approval-required",
      },
    });
    const consent = launchConsentRequest({
      id: "update-consent",
      groupId: approvalOwner.groupId,
      memberId: approvalOwner.memberId,
    });

    const items = deriveAttentionItems(
      snapshot({
        memberships: [uncertainOwner, restartedOwner, approvalOwner],
        runs: [uncertainRun, restartedRun, approvalRun],
      }),
      { launchConsents: [consent] },
    );

    expect(itemOfKind(items, "health")).toMatchObject({
      healthType: "ownership-uncertain",
      title: "Reviewer needs help",
      counted: true,
      summary:
        "Nanasa cannot safely confirm which process belongs to this agent. It will not stop anything automatically.",
    });
    expect(itemOfKind(items, "provider-update")).toMatchObject({
      title: "Builder restarted",
      counted: false,
      category: "updates",
    });
    expect(itemOfKind(items, "launch-consent")).toMatchObject({
      title: "Review before restarting Operator",
      providerUpdate: true,
      counted: true,
    });
    expect(items.filter((item) => item.kind === "response")).toHaveLength(0);
    expect(attentionReviewCount(items)).toBe(2);
  });

  it("projects each counted semantic kind and neutral unread metadata", () => {
    const responseMember = member("response");
    const failedMember = member("failed");
    const stuckMember = member("stuck");
    const doneMember = member("done");
    const runs = [run(responseMember), run(failedMember), run(stuckMember), run(doneMember)];
    const input = snapshot({
      memberships: [responseMember, failedMember, stuckMember, doneMember],
      runs,
      agentStatuses: [
        status(responseMember, runs[0]!, {
          state: "waiting",
          phase: "question",
          attention: "input_required",
          blocker: "Choose a database",
        }),
        status(failedMember, runs[1]!, {
          state: "failed",
          phase: "exited",
          attention: "process_failed",
        }),
        status(stuckMember, runs[2]!, {
          state: "suspected_stuck",
          attention: "progress_stale",
        }),
        status(doneMember, runs[3]!, {
          state: "idle",
          phase: "settled",
          completionRevision: 4,
          completionPending: true,
        }),
      ],
      messageGroups: [
        {
          groupId: "group-a",
          latestGroupSeq: 9,
          oldestRetainedGroupSeq: 1,
          retainedMessageCount: 9,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: ["failed", "failed"],
        },
      ],
    });

    const items = deriveAttentionItems(input, { unreadCounts: new Map([["group-a", 3]]) });

    expect(items.map(({ kind }) => kind)).toEqual([
      "response",
      "health",
      "health",
      "delivery",
      "completion",
      "unread",
    ]);
    expect(itemOfKind(items, "response")).toMatchObject({
      category: "response",
      urgency: "high",
      counted: true,
      summary: "Choose a database",
      targetPath: "/groups/group-a/terminals/run-group-a-response",
    });
    expect(items.filter(({ kind }) => kind === "health").map(({ urgency }) => urgency)).toEqual([
      "critical",
      "medium",
    ]);
    expect(itemOfKind(items, "completion")).toMatchObject({
      category: "completion",
      urgency: "low",
      completionRevision: 4,
    });
    expect(itemOfKind(items, "delivery")).toMatchObject({
      category: "delivery",
      urgency: "medium",
      recipientMemberId: "failed",
      targetPath: "/groups/group-a/messages",
    });
    expect(itemOfKind(items, "unread")).toMatchObject({
      category: "updates",
      urgency: "none",
      counted: false,
      unreadCount: 3,
      latestGroupSequence: 9,
      targetPath: "/groups/group-a/messages",
    });
    expect(attentionReviewCount(items)).toBe(5);
  });

  it("keeps a pending completion visible while the agent works on a later turn", () => {
    const owner = member("builder");
    const ownerRun = run(owner);
    const items = deriveAttentionItems(
      snapshot({
        memberships: [owner],
        runs: [ownerRun],
        agentStatuses: [
          status(owner, ownerRun, {
            state: "working",
            phase: "model",
            completionRevision: 2,
            completionPending: true,
          }),
        ],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "completion",
      completionRevision: 2,
      status: { state: "working" },
    });
  });

  it("reuses member status precedence rather than emitting overlapping semantic kinds", () => {
    const owner = member("builder");
    const ownerRun = run(owner);
    const items = deriveAttentionItems(
      snapshot({
        memberships: [owner],
        runs: [ownerRun],
        agentStatuses: [
          status(owner, ownerRun, {
            state: "failed",
            attention: "decision_required",
            completionRevision: 2,
            completionPending: true,
          }),
        ],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "health", healthType: "failed" });
  });

  it("suppresses only the matching response fallback and preserves every exact wait", () => {
    const owner = member("builder");
    const other = member("reviewer");
    const ownerRun = run(owner);
    const otherRun = run(other);
    const input = snapshot({
      memberships: [owner, other],
      runs: [ownerRun, otherRun],
      agentStatuses: [
        status(owner, ownerRun, {
          state: "blocked",
          phase: "plan_approval",
          attention: "decision_required",
        }),
        status(other, otherRun, {
          state: "waiting",
          phase: "question",
          attention: "input_required",
        }),
      ],
    });
    const waits = [
      wait(owner, ownerRun, "wait-two", { kind: "plan_approval" }),
      wait(owner, ownerRun, "wait-one", { kind: "permission", state: "replying" }),
      wait(owner, ownerRun, "closed-wait", { state: "answered" }),
    ];

    const items = deriveAttentionItems(input, [workspace("group-a", { openWaits: waits })]);

    expect(
      items
        .filter((item): item is Extract<AttentionItem, { kind: "wait" }> => item.kind === "wait")
        .map((item) => item.wait.id),
    ).toEqual(["wait-one", "wait-two"]);
    expect(items.filter(({ kind }) => kind === "response")).toHaveLength(1);
    expect(itemOfKind(items, "response").memberId).toBe("reviewer");
    expect(attentionReviewCount(items)).toBe(3);
  });

  it("requires group, member, run, and generation to match before wait deduplication", () => {
    const owner = member("shared", "group-a");
    const sameMemberOtherGroup = member("shared", "group-b");
    const ownerRun = run(owner);
    const otherRun = run(sameMemberOtherGroup);
    const input = snapshot({
      memberships: [owner, sameMemberOtherGroup],
      runs: [ownerRun, otherRun],
      agentStatuses: [
        status(owner, ownerRun, { state: "blocked", attention: "input_required" }),
        status(sameMemberOtherGroup, otherRun, {
          state: "blocked",
          attention: "input_required",
        }),
      ],
    });
    const mismatchedWait = wait(owner, ownerRun, "new-generation", { generation: 2 });

    const items = deriveAttentionItems(input, [
      workspace("group-a", { openWaits: [mismatchedWait] }),
    ]);

    expect(items.filter(({ kind }) => kind === "response")).toHaveLength(2);
    expect(items.filter(({ kind }) => kind === "wait")).toHaveLength(1);
  });

  it("attaches linked action evidence to waits and removes only that action from progress", () => {
    const owner = member("builder");
    const ownerRun = run(owner);
    const linked = action(owner, ownerRun, "linked-action");
    const independent = action(owner, ownerRun, "independent-action", { state: "completed" });
    const linkedAttempt = attempt(linked);
    const linkedAcknowledgement = acknowledgement(linked, linkedAttempt);
    const items = deriveAttentionItems(snapshot({ memberships: [owner], runs: [ownerRun] }), {
      workspaces: new Map([
        [
          "group-a",
          workspace("group-a", {
            actions: [linked, independent],
            attempts: [linkedAttempt],
            acknowledgements: [linkedAcknowledgement],
            openWaits: [wait(owner, ownerRun, "linked-wait", { actionId: linked.id })],
          }),
        ],
      ]),
    });

    expect(itemOfKind(items, "wait")).toMatchObject({
      action: linked,
      attempts: [linkedAttempt],
      acknowledgements: [linkedAcknowledgement],
    });
    const progress = items.filter((item) => item.kind === "action");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ action: independent, active: false, counted: false });
  });

  it("keeps ordinary action progress neutral and distinguishes active from history", () => {
    const owner = member("builder");
    const ownerRun = run(owner);
    const active = action(owner, ownerRun, "active", { state: "blocked" });
    const history = action(owner, ownerRun, "history", { state: "failed" });
    const items = deriveAttentionItems(snapshot({ memberships: [owner], runs: [ownerRun] }), [
      workspace("group-a", { actions: [history, active] }),
    ]);

    expect(items).toMatchObject([
      { kind: "action", category: "progress", urgency: "none", counted: false, active: true },
      { kind: "action", category: "progress", urgency: "none", counted: false, active: false },
    ]);
    expect(attentionReviewCount(items)).toBe(0);
    expect(attentionActiveProgressCount(items)).toBe(1);
  });

  it("qualifies delivery identity by group and retains removed recipients by raw ID", () => {
    const removed = member("shared", "group-a", { state: "removed", removedAt: timestamp });
    const input = snapshot({
      memberships: [removed],
      messageGroups: [
        {
          groupId: "group-a",
          latestGroupSeq: 1,
          retainedMessageCount: 1,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: ["shared", "shared"],
        },
        {
          groupId: "group-b",
          latestGroupSeq: 2,
          retainedMessageCount: 2,
          activeDeliveryCount: 0,
          failedRecipientMemberIds: ["shared"],
        },
      ],
    });

    const deliveries = deriveAttentionItems(input).filter((item) => item.kind === "delivery");

    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map(({ id }) => id)).size).toBe(2);
    expect(deliveries.map(({ groupId }) => groupId)).toEqual(["group-a", "group-b"]);
    expect(deliveries[0]).toMatchObject({
      label: "shared",
      targetPath: "/groups/group-a/messages",
    });
    expect(deliveries[0]?.member).toBeUndefined();
  });

  it("keeps incident identities stable across incidental revisions and renews semantic occurrences", () => {
    const owner = member("builder");
    const ownerRun = run(owner);
    const baseStatus = status(owner, ownerRun, {
      state: "waiting",
      attention: "input_required",
      statusRevision: 2,
    });
    const first = itemOfKind(
      deriveAttentionItems(
        snapshot({ memberships: [owner], runs: [ownerRun], agentStatuses: [baseStatus] }),
      ),
      "response",
    );
    const revised = itemOfKind(
      deriveAttentionItems(
        snapshot({
          memberships: [owner],
          runs: [ownerRun],
          agentStatuses: [{ ...baseStatus, statusRevision: 99, blocker: "More detail" }],
        }),
      ),
      "response",
    );
    const renewed = itemOfKind(
      deriveAttentionItems(
        snapshot({
          memberships: [owner],
          runs: [ownerRun],
          agentStatuses: [
            { ...baseStatus, statusRevision: 100, stateChangedAt: "2026-08-31T13:00:00.000Z" },
          ],
        }),
      ),
      "response",
    );

    expect(revised.id).toBe(first.id);
    expect(revised.summary).not.toBe(first.summary);
    expect(renewed.id).not.toBe(first.id);
  });

  it("keys completion occurrences by revision", () => {
    const owner = member("builder");
    const ownerRun = run(owner);
    const completionId = (completionRevision: number) =>
      itemOfKind(
        deriveAttentionItems(
          snapshot({
            memberships: [owner],
            runs: [ownerRun],
            agentStatuses: [
              status(owner, ownerRun, {
                state: "idle",
                phase: "settled",
                completionRevision,
                completionPending: true,
              }),
            ],
          }),
        ),
        "completion",
      ).id;

    expect(completionId(3)).toBe(completionId(3));
    expect(completionId(4)).not.toBe(completionId(3));
  });

  it("URL-encodes direct group, run, wait, and action destinations", () => {
    const owner = member("builder", "group / one");
    const ownerRun = run(owner, { id: "run / one" });
    const sourceAction = action(owner, ownerRun, "action / one");
    const items = deriveAttentionItems(
      snapshot({
        groups: [{ ...groups[0]!, id: owner.groupId }],
        memberships: [owner],
        runs: [ownerRun],
        agentStatuses: [status(owner, ownerRun, { state: "failed" })],
      }),
      [
        workspace(owner.groupId, {
          actions: [sourceAction],
          openWaits: [wait(owner, ownerRun, "wait / one")],
        }),
      ],
    );

    expect(itemOfKind(items, "wait").targetPath).toBe(
      "/groups/group%20%2F%20one/activity#wait-wait%20%2F%20one",
    );
    expect(itemOfKind(items, "action").targetPath).toBe(
      "/groups/group%20%2F%20one/activity#action-action%20%2F%20one",
    );
    expect(itemOfKind(items, "health").targetPath).toBe(
      "/groups/group%20%2F%20one/terminals/run%20%2F%20one",
    );
  });
});

describe("attention sorting, filtering, and counts", () => {
  function projection(): AttentionItem[] {
    const responseB = member("zeta", "group-b");
    const responseA = member("alpha", "group-a");
    const failed = member("health", "group-a");
    const done = member("done", "group-a");
    const responseBRun = run(responseB);
    const responseARun = run(responseA);
    const failedRun = run(failed);
    const doneRun = run(done);
    const activeAction = action(responseA, responseARun, "progress");
    return deriveAttentionItems(
      snapshot({
        memberships: [responseB, responseA, failed, done],
        runs: [responseBRun, responseARun, failedRun, doneRun],
        agentStatuses: [
          status(responseB, responseBRun, { state: "blocked", attention: "input_required" }),
          status(responseA, responseARun, { state: "blocked", attention: "input_required" }),
          status(failed, failedRun, { state: "failed" }),
          status(done, doneRun, {
            state: "idle",
            completionRevision: 1,
            completionPending: true,
          }),
        ],
        messageGroups: [
          {
            groupId: "group-a",
            latestGroupSeq: 5,
            retainedMessageCount: 5,
            activeDeliveryCount: 0,
            failedRecipientMemberIds: ["health"],
          },
        ],
      }),
      {
        workspaces: [workspace("group-a", { actions: [activeAction] })],
        unreadCounts: { "group-a": 2 },
      },
    );
  }

  it("uses one deterministic review order followed by neutral metadata", () => {
    const items = projection();

    expect(items.map(({ kind, groupId, memberId }) => [kind, groupId, memberId])).toEqual([
      ["response", "group-a", "alpha"],
      ["response", "group-b", "zeta"],
      ["health", "group-a", "health"],
      ["delivery", "group-a", "health"],
      ["completion", "group-a", "done"],
      ["action", "group-a", "alpha"],
      ["unread", "group-a", undefined],
    ]);
    expect(repositoryAttentionItems(items.slice().reverse()).map(({ id }) => id)).toEqual(
      items.map(({ id }) => id),
    );
  });

  it("filters repository, group, category, and review views without mutating input", () => {
    const items = projection();
    const reversed = items.slice().reverse();

    expect(attentionItemsForScope(reversed, { kind: "repository" })).toEqual(items);
    expect(attentionItemsForScope(reversed, { kind: "group", groupId: "group-b" })).toHaveLength(1);
    expect(groupAttentionItems(items, "group-a")).toHaveLength(6);
    expect(attentionItemsByCategory(items, "response")).toHaveLength(2);
    expect(attentionReviewItems(items)).toHaveLength(5);
    expect(reversed).toEqual(items.slice().reverse());
  });

  it("reports review, category, active progress, unread, and per-group counts", () => {
    const items = projection();

    expect(attentionReviewCount(items)).toBe(5);
    expect(attentionCategoryCount(items, "response")).toBe(2);
    expect(attentionActiveProgressCount(items)).toBe(1);
    expect(attentionUnreadMessageCount(items)).toBe(2);
    expect(attentionCounts(items)).toEqual({
      review: 5,
      response: 2,
      health: 1,
      delivery: 1,
      completion: 1,
      progress: 1,
      activeProgress: 1,
      updates: 1,
      unreadMessages: 2,
    });
    expect([...attentionReviewCountsByGroup(items)]).toEqual([
      ["group-a", 4],
      ["group-b", 1],
    ]);
  });
});
