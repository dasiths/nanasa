import {
  type AddGroupMembershipCommand,
  AddGroupMembershipCommandSchema,
  type AgentProfile,
  AgentProfileSchema,
  type AgentRun,
  AgentRunSchema,
  type ClearMessageHistoryResult,
  ClearMessageHistoryResultSchema,
  type CreateAgentProfileCommand,
  CreateAgentProfileCommandSchema,
  type CreateGroupCommand,
  CreateGroupCommandSchema,
  type DeleteGroupResult,
  DeleteGroupResultSchema,
  type Group,
  type GroupMembership,
  GroupMembershipSchema,
  GroupSchema,
  type MessagePage,
  MessagePageSchema,
  type MessageSubmissionResult,
  MessageSubmissionResultSchema,
  type NanasaConfig,
  NanasaConfigSchema,
  type PortalSnapshot,
  PortalSnapshotSchema,
  type StartGroupRunsResult,
  StartGroupRunsResultSchema,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
  type TerminalEndpointStatus,
  TerminalEndpointStatusSchema,
  type UpdateAgentProfileCommand,
  UpdateAgentProfileCommandSchema,
  type UpdateGroupCommand,
  UpdateGroupCommandSchema,
  type UpdateGroupMembershipCommand,
  UpdateGroupMembershipCommandSchema,
} from "@nanasa/contracts";

interface Schema<T> {
  parse(value: unknown): T;
}

export class ApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface PortalClient {
  loadSnapshot(): Promise<PortalSnapshot>;
  loadConfig(): Promise<NanasaConfig>;
  createGroup(command: CreateGroupCommand): Promise<Group>;
  updateGroup(groupId: string, command: UpdateGroupCommand): Promise<Group>;
  deleteGroup(groupId: string): Promise<DeleteGroupResult>;
  createAgentProfile(command: CreateAgentProfileCommand): Promise<AgentProfile>;
  updateAgentProfile(profileId: string, command: UpdateAgentProfileCommand): Promise<AgentProfile>;
  addMembership(groupId: string, command: AddGroupMembershipCommand): Promise<GroupMembership>;
  updateMembership(
    groupId: string,
    memberId: string,
    command: UpdateGroupMembershipCommand,
  ): Promise<GroupMembership>;
  removeMembership(groupId: string, memberId: string): Promise<GroupMembership>;
  startRun(groupId: string, memberId: string): Promise<AgentRun>;
  startAllRuns(groupId: string, idempotencyKey: string): Promise<StartGroupRunsResult>;
  stopRun(groupId: string, memberId: string): Promise<AgentRun>;
  submitMessage(groupId: string, command: SubmitMessageCommand): Promise<MessageSubmissionResult>;
  loadMessages(
    groupId: string,
    options?: { limit?: number; before?: number; after?: number },
  ): Promise<MessagePage>;
  clearMessages(groupId: string): Promise<ClearMessageHistoryResult>;
  getTerminalEndpointStatus(runId: string): Promise<TerminalEndpointStatus>;
  createEventsSocket(afterSequence: number): WebSocket;
}

function websocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function request<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "message" in payload
        ? String(payload.message)
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return schema.parse(payload);
}

function commandInit(
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  };
}

export const api: PortalClient = {
  loadSnapshot: () => request("/api/snapshot", PortalSnapshotSchema),
  loadConfig: () => request("/api/config", NanasaConfigSchema),
  createGroup: (command) =>
    request(
      "/api/groups",
      GroupSchema,
      commandInit("POST", CreateGroupCommandSchema.parse(command)),
    ),
  updateGroup: (groupId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}`,
      GroupSchema,
      commandInit("PATCH", UpdateGroupCommandSchema.parse(command)),
    ),
  deleteGroup: (groupId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}`,
      DeleteGroupResultSchema,
      commandInit("DELETE", {}),
    ),
  createAgentProfile: (command) =>
    request(
      "/api/agent-profiles",
      AgentProfileSchema,
      commandInit("POST", CreateAgentProfileCommandSchema.parse(command)),
    ),
  updateAgentProfile: (profileId, command) =>
    request(
      `/api/agent-profiles/${encodeURIComponent(profileId)}`,
      AgentProfileSchema,
      commandInit("PATCH", UpdateAgentProfileCommandSchema.parse(command)),
    ),
  addMembership: (groupId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/memberships`,
      GroupMembershipSchema,
      commandInit("POST", AddGroupMembershipCommandSchema.parse(command)),
    ),
  updateMembership: (groupId, memberId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/memberships/${encodeURIComponent(memberId)}`,
      GroupMembershipSchema,
      commandInit("PATCH", UpdateGroupMembershipCommandSchema.parse(command)),
    ),
  removeMembership: (groupId, memberId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/memberships/${encodeURIComponent(memberId)}`,
      GroupMembershipSchema,
      commandInit("DELETE", {}),
    ),
  startRun: (groupId, memberId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/memberships/${encodeURIComponent(memberId)}/run`,
      AgentRunSchema,
      commandInit("POST", {}),
    ),
  startAllRuns: (groupId, idempotencyKey) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/runs/start-all`,
      StartGroupRunsResultSchema,
      commandInit("POST", {}, idempotencyKey),
    ),
  stopRun: (groupId, memberId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/memberships/${encodeURIComponent(memberId)}/run`,
      AgentRunSchema,
      commandInit("DELETE", {}),
    ),
  submitMessage: (groupId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/messages`,
      MessageSubmissionResultSchema,
      commandInit("POST", SubmitMessageCommandSchema.parse(command)),
    ),
  loadMessages: (groupId, options = {}) => {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.before !== undefined) query.set("before", String(options.before));
    if (options.after !== undefined) query.set("after", String(options.after));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return request(
      `/api/groups/${encodeURIComponent(groupId)}/messages${suffix}`,
      MessagePageSchema,
    );
  },
  clearMessages: (groupId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/messages`,
      ClearMessageHistoryResultSchema,
      commandInit("DELETE", {}),
    ),
  getTerminalEndpointStatus: (runId) =>
    request(`/api/runs/${encodeURIComponent(runId)}/terminal`, TerminalEndpointStatusSchema),
  createEventsSocket: (afterSequence) =>
    new WebSocket(websocketUrl(`/api/events?after=${afterSequence}`)),
};
