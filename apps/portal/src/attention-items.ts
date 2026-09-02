import type {
  AgentAction,
  AgentActionAcknowledgement,
  AgentActionAttempt,
  AgentActionState,
  AgentActionWorkspace,
  AgentRun,
  AgentStatusSummary,
  Group,
  GroupMembership,
  OpenWait,
  PortalSnapshot,
} from "@nanasa/contracts";
import { type MemberStatusView, memberStatusView } from "./member-status.js";

export type AttentionReviewKind = "wait" | "response" | "health" | "completion" | "delivery";
export type AttentionNeutralKind = "action" | "unread";
export type AttentionItemKind = AttentionReviewKind | AttentionNeutralKind;
export type AttentionReviewCategory = "response" | "health" | "completion" | "delivery";
export type AttentionNeutralCategory = "progress" | "updates";
export type AttentionCategory = AttentionReviewCategory | AttentionNeutralCategory;
export type AttentionUrgency = "critical" | "high" | "medium" | "low" | "none";

export const ATTENTION_CATEGORY_LABELS = {
  response: "Requires response",
  health: "Agent health",
  completion: "Completions",
  delivery: "Delivery",
  progress: "Progress",
  updates: "Updates",
} as const satisfies Record<AttentionCategory, string>;

interface AttentionItemBase<
  Kind extends AttentionItemKind,
  Category extends AttentionCategory,
  Urgency extends AttentionUrgency,
  Counted extends boolean,
> {
  id: string;
  sourceIdentity: string;
  kind: Kind;
  category: Category;
  urgency: Urgency;
  counted: Counted;
  review: Counted;
  scope: { kind: "group"; groupId: string };
  groupId: string;
  group: Group;
  memberId?: string;
  runId?: string;
  generation?: number;
  label: string;
  title: string;
  summary: string;
  targetPath: string;
}

export interface WaitAttentionItem extends AttentionItemBase<"wait", "response", "high", true> {
  memberId: string;
  runId: string;
  generation: number;
  wait: OpenWait;
  member?: GroupMembership;
  action?: AgentAction;
  attempts: AgentActionAttempt[];
  acknowledgements: AgentActionAcknowledgement[];
}

export interface ResponseAttentionItem
  extends AttentionItemBase<"response", "response", "high", true> {
  memberId: string;
  runId: string;
  generation: number;
  member: GroupMembership;
  run: AgentRun;
  status?: AgentStatusSummary;
  statusView: MemberStatusView;
  responseType: "input" | "approval";
}

export interface HealthAttentionItem
  extends AttentionItemBase<"health", "health", "critical" | "medium", true> {
  memberId: string;
  member: GroupMembership;
  run?: AgentRun;
  status?: AgentStatusSummary;
  statusView: MemberStatusView;
  healthType: "failed" | "stuck";
}

export interface CompletionAttentionItem
  extends AttentionItemBase<"completion", "completion", "low", true> {
  memberId: string;
  runId: string;
  generation: number;
  member: GroupMembership;
  run: AgentRun;
  status: AgentStatusSummary;
  completionRevision: number;
}

export interface DeliveryAttentionItem
  extends AttentionItemBase<"delivery", "delivery", "medium", true> {
  memberId: string;
  recipientMemberId: string;
  member?: GroupMembership;
}

export interface ActionAttentionItem
  extends AttentionItemBase<"action", "progress", "none", false> {
  memberId: string;
  runId: string;
  generation: number;
  action: AgentAction;
  member?: GroupMembership;
  attempts: AgentActionAttempt[];
  acknowledgements: AgentActionAcknowledgement[];
  active: boolean;
}

export interface UnreadAttentionItem extends AttentionItemBase<"unread", "updates", "none", false> {
  unreadCount: number;
  latestGroupSequence: number;
}

export type AttentionReviewItem =
  | WaitAttentionItem
  | ResponseAttentionItem
  | HealthAttentionItem
  | CompletionAttentionItem
  | DeliveryAttentionItem;
export type AttentionNeutralItem = ActionAttentionItem | UnreadAttentionItem;
export type AttentionItem = AttentionReviewItem | AttentionNeutralItem;

export type AttentionWorkspaceCollection =
  | readonly AgentActionWorkspace[]
  | ReadonlyMap<string, AgentActionWorkspace | undefined>
  | Readonly<Record<string, AgentActionWorkspace | undefined>>;
export type AttentionUnreadCounts =
  | ReadonlyMap<string, number | undefined>
  | Readonly<Record<string, number | undefined>>;

export interface AttentionProjectionOptions {
  workspaces?: AttentionWorkspaceCollection;
  unreadCounts?: AttentionUnreadCounts;
}

export type AttentionScope = { kind: "repository" } | { kind: "group"; groupId: string };

export interface AttentionCounts {
  review: number;
  response: number;
  health: number;
  delivery: number;
  completion: number;
  progress: number;
  activeProgress: number;
  updates: number;
  unreadMessages: number;
}

const activeActionStates = new Set<AgentActionState>([
  "created",
  "deferred",
  "submitted",
  "accepted",
  "started",
  "blocked",
]);

const kindSortRank = {
  wait: 0,
  response: 1,
  health: 2,
  delivery: 3,
  completion: 4,
  action: 5,
  unread: 6,
} as const satisfies Record<AttentionItemKind, number>;

function sourceIdentity(kind: AttentionItemKind, ...parts: readonly (string | number)[]): string {
  return [kind, ...parts.map((part) => `${String(part).length}:${String(part)}`)].join("|");
}

function itemIdentity(source: string): string {
  return `attention:${source}`;
}

function groupPath(groupId: string, section: "activity" | "messages" | "terminals"): string {
  return `/groups/${encodeURIComponent(groupId)}/${section}`;
}

function terminalPath(groupId: string, runId: string | undefined): string {
  const base = groupPath(groupId, "terminals");
  return runId === undefined ? base : `${base}/${encodeURIComponent(runId)}`;
}

function itemScope(groupId: string): { kind: "group"; groupId: string } {
  return { kind: "group", groupId };
}

function memberLabel(member: GroupMembership | undefined, memberId: string): string {
  return member?.alias ?? memberId;
}

function statusSummary(view: MemberStatusView, member: GroupMembership): string {
  return (
    view.status?.blocker ??
    view.status?.lastProgressSummary ??
    `${member.alias} is ${view.label.toLocaleLowerCase()}.`
  );
}

function incidentMarker(view: MemberStatusView, member: GroupMembership): string {
  return (
    view.status?.stateChangedAt ?? view.run?.stoppedAt ?? view.run?.startedAt ?? member.joinedAt
  );
}

function suppressionKey(
  groupId: string,
  memberId: string,
  runId: string,
  generation: number,
): string {
  return sourceIdentity("response", groupId, memberId, runId, generation);
}

function workspaceValues(
  collection: AttentionWorkspaceCollection | undefined,
): AgentActionWorkspace[] {
  if (collection === undefined) return [];
  if (Array.isArray(collection)) return [...collection];
  if (collection instanceof Map) {
    return [...collection.values()].filter(
      (workspace): workspace is AgentActionWorkspace => workspace !== undefined,
    );
  }
  return Object.values(collection).filter(
    (workspace): workspace is AgentActionWorkspace => workspace !== undefined,
  );
}

function unreadCountForGroup(counts: AttentionUnreadCounts | undefined, groupId: string): number {
  const value =
    counts instanceof Map
      ? counts.get(groupId)
      : (counts as Readonly<Record<string, number | undefined>> | undefined)?.[groupId];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isProjectionOptions(
  input: AttentionWorkspaceCollection | AttentionProjectionOptions | undefined,
): input is AttentionProjectionOptions {
  return (
    input !== undefined &&
    !Array.isArray(input) &&
    !(input instanceof Map) &&
    (Object.hasOwn(input, "workspaces") || Object.hasOwn(input, "unreadCounts"))
  );
}

function commonFields(
  source: string,
  group: Group,
  fields: {
    memberId?: string;
    runId?: string;
    generation?: number;
    label: string;
    title: string;
    summary: string;
    targetPath: string;
  },
) {
  return {
    id: itemIdentity(source),
    sourceIdentity: source,
    scope: itemScope(group.id),
    groupId: group.id,
    group,
    ...(fields.memberId === undefined ? {} : { memberId: fields.memberId }),
    ...(fields.runId === undefined ? {} : { runId: fields.runId }),
    ...(fields.generation === undefined ? {} : { generation: fields.generation }),
    label: fields.label,
    title: fields.title,
    summary: fields.summary,
    targetPath: fields.targetPath,
  };
}

function statusItems(
  snapshot: PortalSnapshot,
  groups: ReadonlyMap<string, Group>,
): AttentionReviewItem[] {
  const items: AttentionReviewItem[] = [];
  for (const member of snapshot.memberships) {
    if (member.state !== "active") continue;
    const group = groups.get(member.groupId);
    if (group === undefined) continue;
    const view = memberStatusView(snapshot.agentStatuses, snapshot.runs, member);
    const { run, status } = view;

    if ((view.key === "needs-input" || view.key === "needs-approval") && run !== undefined) {
      const responseType = view.key === "needs-approval" ? "approval" : "input";
      const source = sourceIdentity(
        "response",
        group.id,
        member.memberId,
        run.id,
        run.generation,
        responseType,
        incidentMarker(view, member),
      );
      items.push({
        ...commonFields(source, group, {
          memberId: member.memberId,
          runId: run.id,
          generation: run.generation,
          label: member.alias,
          title: `${member.alias} · ${view.label}`,
          summary: statusSummary(view, member),
          targetPath: terminalPath(group.id, run.id),
        }),
        kind: "response",
        category: "response",
        urgency: "high",
        counted: true,
        review: true,
        memberId: member.memberId,
        runId: run.id,
        generation: run.generation,
        member,
        run,
        ...(status === undefined ? {} : { status }),
        statusView: view,
        responseType,
      });
      continue;
    }

    if (view.key === "failed" || view.key === "stuck") {
      const source = sourceIdentity(
        "health",
        group.id,
        member.memberId,
        run?.id ?? "no-run",
        run?.generation ?? 0,
        view.key,
        incidentMarker(view, member),
      );
      items.push({
        ...commonFields(source, group, {
          memberId: member.memberId,
          ...(run === undefined ? {} : { runId: run.id, generation: run.generation }),
          label: member.alias,
          title: `${member.alias} · ${view.label}`,
          summary: statusSummary(view, member),
          targetPath: terminalPath(group.id, run?.id),
        }),
        kind: "health",
        category: "health",
        urgency: view.key === "failed" ? "critical" : "medium",
        counted: true,
        review: true,
        memberId: member.memberId,
        member,
        ...(run === undefined ? {} : { run }),
        ...(status === undefined ? {} : { status }),
        statusView: view,
        healthType: view.key,
      });
      continue;
    }

    if (view.key === "done" && run !== undefined && status !== undefined) {
      const source = sourceIdentity(
        "completion",
        group.id,
        member.memberId,
        run.id,
        run.generation,
        status.completionRevision,
      );
      items.push({
        ...commonFields(source, group, {
          memberId: member.memberId,
          runId: run.id,
          generation: run.generation,
          label: member.alias,
          title: `${member.alias} · Completion ready`,
          summary: `Completion revision ${status.completionRevision} is ready for review.`,
          targetPath: terminalPath(group.id, run.id),
        }),
        kind: "completion",
        category: "completion",
        urgency: "low",
        counted: true,
        review: true,
        memberId: member.memberId,
        runId: run.id,
        generation: run.generation,
        member,
        run,
        status,
        completionRevision: status.completionRevision,
      });
    }
  }
  return items;
}

function workspaceItems(
  snapshot: PortalSnapshot,
  groups: ReadonlyMap<string, Group>,
  workspaces: AttentionWorkspaceCollection | undefined,
): { items: Array<WaitAttentionItem | ActionAttentionItem>; exactWaitKeys: Set<string> } {
  const items: Array<WaitAttentionItem | ActionAttentionItem> = [];
  const exactWaitKeys = new Set<string>();
  const seenWaits = new Set<string>();
  const seenActions = new Set<string>();
  const linkedActions = new Set<string>();
  const members = new Map(
    snapshot.memberships
      .filter((member) => member.state === "active")
      .map((member) => [`${member.groupId}\u0000${member.memberId}`, member] as const),
  );
  const values = workspaceValues(workspaces).sort((left, right) =>
    left.groupId.localeCompare(right.groupId),
  );

  for (const workspace of values) {
    for (const wait of workspace.openWaits) {
      if (wait.state !== "open" && wait.state !== "replying") continue;
      const group = groups.get(wait.groupId);
      if (group === undefined) continue;
      const waitKey = `${wait.groupId}\u0000${wait.id}`;
      if (seenWaits.has(waitKey)) continue;
      seenWaits.add(waitKey);
      exactWaitKeys.add(suppressionKey(wait.groupId, wait.memberId, wait.runId, wait.generation));
      if (wait.actionId !== undefined) linkedActions.add(`${wait.groupId}\u0000${wait.actionId}`);

      const member = members.get(`${wait.groupId}\u0000${wait.memberId}`);
      const action =
        wait.actionId === undefined
          ? undefined
          : workspace.actions.find(
              (candidate) =>
                candidate.id === wait.actionId && candidate.target.groupId === wait.groupId,
            );
      const attempts =
        action === undefined
          ? []
          : workspace.attempts.filter((attempt) => attempt.actionId === action.id);
      const acknowledgements =
        action === undefined
          ? []
          : workspace.acknowledgements.filter((item) => item.actionId === action.id);
      const label = memberLabel(member, wait.memberId);
      const source = sourceIdentity("wait", wait.groupId, wait.id);
      items.push({
        ...commonFields(source, group, {
          memberId: wait.memberId,
          runId: wait.runId,
          generation: wait.generation,
          label,
          title: `${label} · Requires response`,
          summary: wait.summary,
          targetPath: `${groupPath(wait.groupId, "activity")}#wait-${encodeURIComponent(wait.id)}`,
        }),
        kind: "wait",
        category: "response",
        urgency: "high",
        counted: true,
        review: true,
        memberId: wait.memberId,
        runId: wait.runId,
        generation: wait.generation,
        wait,
        ...(member === undefined ? {} : { member }),
        ...(action === undefined ? {} : { action }),
        attempts,
        acknowledgements,
      });
    }
  }

  for (const workspace of values) {
    for (const action of workspace.actions) {
      const group = groups.get(action.target.groupId);
      if (group === undefined) continue;
      const actionKey = `${action.target.groupId}\u0000${action.id}`;
      if (seenActions.has(actionKey) || linkedActions.has(actionKey)) continue;
      seenActions.add(actionKey);
      const member = members.get(`${action.target.groupId}\u0000${action.target.memberId}`);
      const attempts = workspace.attempts.filter((attempt) => attempt.actionId === action.id);
      const acknowledgements = workspace.acknowledgements.filter(
        (item) => item.actionId === action.id,
      );
      const active = activeActionStates.has(action.state);
      const label = memberLabel(member, action.target.memberId);
      const source = sourceIdentity("action", action.target.groupId, action.id);
      items.push({
        ...commonFields(source, group, {
          memberId: action.target.memberId,
          runId: action.target.runId,
          generation: action.target.generation,
          label,
          title: `${label} · Action ${action.state.replaceAll("-", " ")}`,
          summary: `${action.kind.replaceAll("-", " ")} action is ${action.state.replaceAll("-", " ")}.`,
          targetPath: `${groupPath(action.target.groupId, "activity")}#action-${encodeURIComponent(action.id)}`,
        }),
        kind: "action",
        category: "progress",
        urgency: "none",
        counted: false,
        review: false,
        memberId: action.target.memberId,
        runId: action.target.runId,
        generation: action.target.generation,
        action,
        ...(member === undefined ? {} : { member }),
        attempts,
        acknowledgements,
        active,
      });
    }
  }

  return { items, exactWaitKeys };
}

function deliveryItems(
  snapshot: PortalSnapshot,
  groups: ReadonlyMap<string, Group>,
): DeliveryAttentionItem[] {
  const items: DeliveryAttentionItem[] = [];
  const seen = new Set<string>();
  for (const state of snapshot.messageGroups ?? []) {
    const group = groups.get(state.groupId);
    if (group === undefined) continue;
    for (const recipientMemberId of state.failedRecipientMemberIds) {
      const deliveryKey = `${state.groupId}\u0000${recipientMemberId}`;
      if (seen.has(deliveryKey)) continue;
      seen.add(deliveryKey);
      const member = snapshot.memberships.find(
        (candidate) =>
          candidate.state === "active" &&
          candidate.groupId === state.groupId &&
          candidate.memberId === recipientMemberId,
      );
      const label = memberLabel(member, recipientMemberId);
      const source = sourceIdentity("delivery", state.groupId, recipientMemberId);
      items.push({
        ...commonFields(source, group, {
          memberId: recipientMemberId,
          label,
          title: `${label} · Delivery failed`,
          summary: `Message delivery to ${label} failed in ${group.name}.`,
          targetPath: groupPath(state.groupId, "messages"),
        }),
        kind: "delivery",
        category: "delivery",
        urgency: "medium",
        counted: true,
        review: true,
        memberId: recipientMemberId,
        recipientMemberId,
        ...(member === undefined ? {} : { member }),
      });
    }
  }
  return items;
}

function unreadItems(
  snapshot: PortalSnapshot,
  groups: ReadonlyMap<string, Group>,
  unreadCounts: AttentionUnreadCounts | undefined,
): UnreadAttentionItem[] {
  if (unreadCounts === undefined) return [];
  const items: UnreadAttentionItem[] = [];
  const seen = new Set<string>();
  for (const state of snapshot.messageGroups ?? []) {
    if (seen.has(state.groupId)) continue;
    seen.add(state.groupId);
    const group = groups.get(state.groupId);
    const unreadCount = unreadCountForGroup(unreadCounts, state.groupId);
    if (group === undefined || unreadCount === 0) continue;
    const source = sourceIdentity("unread", state.groupId, state.latestGroupSeq);
    items.push({
      ...commonFields(source, group, {
        label: group.name,
        title: `${group.name} · Unread messages`,
        summary: `${unreadCount} unread ${unreadCount === 1 ? "message" : "messages"} in ${group.name}.`,
        targetPath: groupPath(state.groupId, "messages"),
      }),
      kind: "unread",
      category: "updates",
      urgency: "none",
      counted: false,
      review: false,
      unreadCount,
      latestGroupSequence: state.latestGroupSeq,
    });
  }
  return items;
}

export function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  return (
    kindSortRank[left.kind] - kindSortRank[right.kind] ||
    left.groupId.localeCompare(right.groupId) ||
    (left.memberId ?? "").localeCompare(right.memberId ?? "") ||
    left.id.localeCompare(right.id)
  );
}

export function deriveAttentionItems(
  snapshot: PortalSnapshot,
  input?: AttentionWorkspaceCollection | AttentionProjectionOptions,
  unreadCounts?: AttentionUnreadCounts,
): AttentionItem[] {
  const options = isProjectionOptions(input)
    ? input
    : {
        ...(input === undefined ? {} : { workspaces: input }),
        ...(unreadCounts === undefined ? {} : { unreadCounts }),
      };
  const groups = new Map(snapshot.groups.map((group) => [group.id, group] as const));
  const statuses = statusItems(snapshot, groups);
  const workspace = workspaceItems(snapshot, groups, options.workspaces);
  const deduplicatedStatuses = statuses.filter(
    (item) =>
      item.kind !== "response" ||
      !workspace.exactWaitKeys.has(
        suppressionKey(item.groupId, item.memberId, item.run.id, item.run.generation),
      ),
  );

  return [
    ...deduplicatedStatuses,
    ...workspace.items,
    ...deliveryItems(snapshot, groups),
    ...unreadItems(snapshot, groups, options.unreadCounts),
  ].sort(compareAttentionItems);
}

export function isAttentionReviewItem(item: AttentionItem): item is AttentionReviewItem {
  return item.counted;
}

export function attentionReviewItems(items: readonly AttentionItem[]): AttentionReviewItem[] {
  return items.filter(isAttentionReviewItem);
}

export function repositoryAttentionItems(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort(compareAttentionItems);
}

export function groupAttentionItems(
  items: readonly AttentionItem[],
  groupId: string,
): AttentionItem[] {
  return items.filter((item) => item.groupId === groupId).sort(compareAttentionItems);
}

export function attentionItemsForScope(
  items: readonly AttentionItem[],
  scope: AttentionScope,
): AttentionItem[] {
  return scope.kind === "repository"
    ? repositoryAttentionItems(items)
    : groupAttentionItems(items, scope.groupId);
}

export function attentionItemsByCategory(
  items: readonly AttentionItem[],
  category: AttentionCategory,
): AttentionItem[] {
  return items.filter((item) => item.category === category).sort(compareAttentionItems);
}

export function attentionReviewCount(items: readonly AttentionItem[]): number {
  return items.reduce((count, item) => count + (item.counted ? 1 : 0), 0);
}

export function attentionCategoryCount(
  items: readonly AttentionItem[],
  category: AttentionCategory,
): number {
  return items.reduce((count, item) => count + (item.category === category ? 1 : 0), 0);
}

export function attentionActiveProgressCount(items: readonly AttentionItem[]): number {
  return items.reduce((count, item) => count + (item.kind === "action" && item.active ? 1 : 0), 0);
}

export function attentionUnreadMessageCount(items: readonly AttentionItem[]): number {
  return items.reduce((count, item) => count + (item.kind === "unread" ? item.unreadCount : 0), 0);
}

export function attentionCounts(items: readonly AttentionItem[]): AttentionCounts {
  return {
    review: attentionReviewCount(items),
    response: attentionCategoryCount(items, "response"),
    health: attentionCategoryCount(items, "health"),
    delivery: attentionCategoryCount(items, "delivery"),
    completion: attentionCategoryCount(items, "completion"),
    progress: attentionCategoryCount(items, "progress"),
    activeProgress: attentionActiveProgressCount(items),
    updates: attentionCategoryCount(items, "updates"),
    unreadMessages: attentionUnreadMessageCount(items),
  };
}

export function attentionReviewCountsByGroup(
  items: readonly AttentionItem[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.counted) continue;
    counts.set(item.groupId, (counts.get(item.groupId) ?? 0) + 1);
  }
  return counts;
}
