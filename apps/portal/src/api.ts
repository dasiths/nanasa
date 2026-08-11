import {
  type AdHocConsoleSession,
  AdHocConsoleSessionSchema,
  type AgentRun,
  AgentRunSchema,
  type ClearMessageHistoryResult,
  ClearMessageHistoryResultSchema,
  type CreateGroupAgentCommand,
  CreateGroupAgentCommandSchema,
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
  type RemoveGroupAgentResult,
  RemoveGroupAgentResultSchema,
  type ReorderGroupAgentsCommand,
  ReorderGroupAgentsCommandSchema,
  type ReorderGroupAgentsResult,
  ReorderGroupAgentsResultSchema,
  type RoleDefinition,
  RoleDefinitionSchema,
  type StartGroupRunsResult,
  StartGroupRunsResultSchema,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
  type TerminalEndpointStatus,
  TerminalEndpointStatusSchema,
  type UpdateGroupAgentCommand,
  UpdateGroupAgentCommandSchema,
  type UpdateGroupCommand,
  UpdateGroupCommandSchema,
  type UpdateRolePresentationCommand,
  UpdateRolePresentationCommandSchema,
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
  createConsole(): Promise<AdHocConsoleSession>;
  closeConsole(consoleId: string): Promise<void>;
  loadSnapshot(): Promise<PortalSnapshot>;
  loadConfig(): Promise<NanasaConfig>;
  createGroup(command: CreateGroupCommand): Promise<Group>;
  updateGroup(groupId: string, command: UpdateGroupCommand): Promise<Group>;
  deleteGroup(groupId: string): Promise<DeleteGroupResult>;
  createAgent(groupId: string, command: CreateGroupAgentCommand): Promise<GroupMembership>;
  updateAgent(
    groupId: string,
    agentId: string,
    command: UpdateGroupAgentCommand,
  ): Promise<GroupMembership>;
  removeAgent(groupId: string, agentId: string): Promise<RemoveGroupAgentResult>;
  reorderAgents(
    groupId: string,
    command: ReorderGroupAgentsCommand,
  ): Promise<ReorderGroupAgentsResult>;
  updateRolePresentation(
    roleId: string,
    command: UpdateRolePresentationCommand,
  ): Promise<RoleDefinition>;
  startRun(groupId: string, agentId: string): Promise<AgentRun>;
  startAllRuns(groupId: string, idempotencyKey: string): Promise<StartGroupRunsResult>;
  stopRun(groupId: string, agentId: string): Promise<AgentRun>;
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

async function requestVoid(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(path, init);
  if (response.ok) return;
  const payload: unknown = await response.json();
  const message =
    typeof payload === "object" && payload !== null && "message" in payload
      ? String(payload.message)
      : `Request failed with status ${response.status}`;
  throw new ApiError(message, response.status);
}

function commandInit(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
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
  createConsole: () => request("/api/consoles", AdHocConsoleSessionSchema, commandInit("POST", {})),
  closeConsole: (consoleId) =>
    requestVoid(`/api/consoles/${encodeURIComponent(consoleId)}`, commandInit("DELETE", {})),
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
  createAgent: (groupId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/agents`,
      GroupMembershipSchema,
      commandInit("POST", CreateGroupAgentCommandSchema.parse(command)),
    ),
  updateAgent: (groupId, agentId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}`,
      GroupMembershipSchema,
      commandInit("PATCH", UpdateGroupAgentCommandSchema.parse(command)),
    ),
  removeAgent: (groupId, agentId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}`,
      RemoveGroupAgentResultSchema,
      commandInit("DELETE", {}),
    ),
  reorderAgents: (groupId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/agent-order`,
      ReorderGroupAgentsResultSchema,
      commandInit("PUT", ReorderGroupAgentsCommandSchema.parse(command)),
    ),
  updateRolePresentation: (roleId, command) =>
    request(
      `/api/roles/${encodeURIComponent(roleId)}/presentation`,
      RoleDefinitionSchema,
      commandInit("PATCH", UpdateRolePresentationCommandSchema.parse(command)),
    ),
  startRun: (groupId, agentId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}/run`,
      AgentRunSchema,
      commandInit("POST", {}),
    ),
  startAllRuns: (groupId, idempotencyKey) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/runs/start-all`,
      StartGroupRunsResultSchema,
      commandInit("POST", {}, idempotencyKey),
    ),
  stopRun: (groupId, agentId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}/run`,
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
