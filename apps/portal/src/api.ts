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
  type ControlMetadata,
} from "@nanasa/contracts";
import {
  CONTROL_API_PREFIX,
  ControlClientError,
  NanasaControlClient,
  type Schema,
} from "@nanasa/control-client";

export { ControlClientError as ApiError };

export interface PortalClient {
  createConsole(): Promise<AdHocConsoleSession>;
  closeConsole(consoleId: string): Promise<void>;
  loadMetadata(): Promise<ControlMetadata>;
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
  createEventsSocket(afterSequence: number, instanceId: string): WebSocket;
}

const control = new NanasaControlClient();

async function request<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  return control.request(path, schema, { ...(init === undefined ? {} : { init }) });
}

async function requestVoid(path: string, init: RequestInit): Promise<void> {
  return control.requestVoid(path, init);
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
  createConsole: () =>
    request(`${CONTROL_API_PREFIX}/consoles`, AdHocConsoleSessionSchema, commandInit("POST", {})),
  closeConsole: (consoleId) =>
    requestVoid(
      `${CONTROL_API_PREFIX}/consoles/${encodeURIComponent(consoleId)}`,
      commandInit("DELETE", {}),
    ),
  loadMetadata: () => control.metadata(),
  loadSnapshot: () => request(`${CONTROL_API_PREFIX}/snapshot`, PortalSnapshotSchema),
  loadConfig: () => request(`${CONTROL_API_PREFIX}/config`, NanasaConfigSchema),
  createGroup: (command) =>
    request(
      `${CONTROL_API_PREFIX}/groups`,
      GroupSchema,
      commandInit("POST", CreateGroupCommandSchema.parse(command)),
    ),
  updateGroup: (groupId, command) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}`,
      GroupSchema,
      commandInit("PATCH", UpdateGroupCommandSchema.parse(command)),
    ),
  deleteGroup: (groupId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}`,
      DeleteGroupResultSchema,
      commandInit("DELETE", {}),
    ),
  createAgent: (groupId, command) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/agents`,
      GroupMembershipSchema,
      commandInit("POST", CreateGroupAgentCommandSchema.parse(command)),
    ),
  updateAgent: (groupId, agentId, command) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}`,
      GroupMembershipSchema,
      commandInit("PATCH", UpdateGroupAgentCommandSchema.parse(command)),
    ),
  removeAgent: (groupId, agentId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}`,
      RemoveGroupAgentResultSchema,
      commandInit("DELETE", {}),
    ),
  reorderAgents: (groupId, command) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/agent-order`,
      ReorderGroupAgentsResultSchema,
      commandInit("PUT", ReorderGroupAgentsCommandSchema.parse(command)),
    ),
  updateRolePresentation: (roleId, command) =>
    request(
      `${CONTROL_API_PREFIX}/roles/${encodeURIComponent(roleId)}/presentation`,
      RoleDefinitionSchema,
      commandInit("PATCH", UpdateRolePresentationCommandSchema.parse(command)),
    ),
  startRun: (groupId, agentId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}/run`,
      AgentRunSchema,
      commandInit("POST", {}),
    ),
  startAllRuns: (groupId, idempotencyKey) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/runs/start-all`,
      StartGroupRunsResultSchema,
      commandInit("POST", {}, idempotencyKey),
    ),
  stopRun: (groupId, agentId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}/run`,
      AgentRunSchema,
      commandInit("DELETE", {}),
    ),
  submitMessage: (groupId, command) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/messages`,
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
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/messages${suffix}`,
      MessagePageSchema,
    );
  },
  clearMessages: (groupId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/messages`,
      ClearMessageHistoryResultSchema,
      commandInit("DELETE", {}),
    ),
  getTerminalEndpointStatus: (runId) =>
    request(
      `${CONTROL_API_PREFIX}/runs/${encodeURIComponent(runId)}/terminal`,
      TerminalEndpointStatusSchema,
    ),
  createEventsSocket: (afterSequence, instanceId) => control.openEvents(afterSequence, instanceId),
};
