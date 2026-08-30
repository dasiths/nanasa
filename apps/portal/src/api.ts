import {
  type AdHocConsoleSession,
  AdHocConsoleSessionSchema,
  type AgentAction,
  AgentActionSchema,
  type AgentActionWorkspace,
  AgentActionWorkspaceSchema,
  type CreateAgentActionCommand,
  CreateAgentActionCommandSchema,
  type OpenWait,
  OpenWaitSchema,
  type ReplyOpenWaitCommand,
  ReplyOpenWaitCommandSchema,
  type AgentRun,
  AgentRunSchema,
  type AssignAgentCheckoutCommand,
  AssignAgentCheckoutCommandSchema,
  type ClearMessageHistoryResult,
  ClearMessageHistoryResultSchema,
  type CreateGroupAgentCommand,
  CreateGroupAgentCommandSchema,
  type CreateGroupCommand,
  CreateGroupCommandSchema,
  type CreateWorktreeCommand,
  CreateWorktreeCommandSchema,
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
  type ReorderGroupsCommand,
  type ReorderGroupsResult,
  ReorderGroupsCommandSchema,
  type ReparentGroupAgentCommand,
  type ReparentGroupAgentResult,
  ReparentGroupAgentCommandSchema,
  type RoleDefinition,
  RoleDefinitionSchema,
  type OpenCheckoutCommand,
  OpenCheckoutCommandSchema,
  type RemoveWorktreeCommand,
  RemoveWorktreeCommandSchema,
  type WorktreeOperationResult,
  type StartGroupRunsResult,
  StartGroupRunsResultSchema,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
  type TerminalEndpointStatus,
  TerminalEndpointStatusSchema,
  type TerminalCheckpoint,
  TerminalCheckpointContentSchema,
  TerminalCheckpointSchema,
  type TerminalReadResult,
  TerminalReadResultSchema,
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
  NanasaControlResources,
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
  reorderGroups(command: ReorderGroupsCommand): Promise<ReorderGroupsResult>;
  reparentAgent(
    groupId: string,
    agentId: string,
    command: ReparentGroupAgentCommand,
  ): Promise<ReparentGroupAgentResult>;
  assignCheckout(
    groupId: string,
    agentId: string,
    command: AssignAgentCheckoutCommand,
  ): Promise<void>;
  createWorktree(command: CreateWorktreeCommand): Promise<WorktreeOperationResult>;
  openCheckout(command: OpenCheckoutCommand): Promise<WorktreeOperationResult>;
  removeWorktree(
    worktreeId: string,
    command: RemoveWorktreeCommand,
  ): Promise<WorktreeOperationResult>;
  updateRolePresentation(
    roleId: string,
    command: UpdateRolePresentationCommand,
  ): Promise<RoleDefinition>;
  startRun(groupId: string, agentId: string): Promise<AgentRun>;
  startAllRuns(groupId: string, idempotencyKey: string): Promise<StartGroupRunsResult>;
  stopRun(groupId: string, agentId: string): Promise<AgentRun>;
  submitMessage(groupId: string, command: SubmitMessageCommand): Promise<MessageSubmissionResult>;
  createAgentAction(command: CreateAgentActionCommand): Promise<AgentAction>;
  loadActionWorkspace(groupId: string): Promise<AgentActionWorkspace>;
  replyOpenWait(waitId: string, command: ReplyOpenWaitCommand): Promise<OpenWait>;
  loadMessages(
    groupId: string,
    options?: { limit?: number; before?: number; after?: number },
  ): Promise<MessagePage>;
  clearMessages(groupId: string): Promise<ClearMessageHistoryResult>;
  getTerminalEndpointStatus(runId: string): Promise<TerminalEndpointStatus>;
  readTerminal(runId: string, generation: number): Promise<TerminalReadResult>;
  listTerminalCheckpoints(): Promise<TerminalCheckpoint[]>;
  getTerminalCheckpoint(
    checkpointId: string,
  ): Promise<{ checkpoint: TerminalCheckpoint; text: string }>;
  createEventsSocket(afterSequence: number, instanceId: string): WebSocket;
}

const control = new NanasaControlClient();
const resources = new NanasaControlResources(control);

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
    resources.topology.reorderAgents(
      groupId,
      ReorderGroupAgentsCommandSchema.parse(command),
      crypto.randomUUID(),
    ),
  reorderGroups: (command) =>
    resources.topology.reorderGroups(
      ReorderGroupsCommandSchema.parse(command),
      crypto.randomUUID(),
    ),
  reparentAgent: (groupId, agentId, command) =>
    resources.topology.reparentAgent(
      groupId,
      agentId,
      ReparentGroupAgentCommandSchema.parse(command),
      crypto.randomUUID(),
    ),
  assignCheckout: (groupId, agentId, command) =>
    resources.workspace.assignCheckout(
      groupId,
      agentId,
      AssignAgentCheckoutCommandSchema.parse(command),
      crypto.randomUUID(),
    ),
  createWorktree: (command) =>
    resources.workspace.createWorktree(
      CreateWorktreeCommandSchema.parse(command),
      crypto.randomUUID(),
    ),
  openCheckout: (command) =>
    resources.workspace.openCheckout(OpenCheckoutCommandSchema.parse(command), crypto.randomUUID()),
  removeWorktree: (worktreeId, command) =>
    resources.workspace.removeWorktree(
      worktreeId,
      RemoveWorktreeCommandSchema.parse(command),
      crypto.randomUUID(),
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
  createAgentAction: (command) =>
    request(
      `${CONTROL_API_PREFIX}/agent-actions`,
      AgentActionSchema,
      commandInit("POST", CreateAgentActionCommandSchema.parse(command)),
    ),
  loadActionWorkspace: (groupId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/action-workspace`,
      AgentActionWorkspaceSchema,
    ),
  replyOpenWait: (waitId, command) =>
    request(
      `${CONTROL_API_PREFIX}/open-waits/${encodeURIComponent(waitId)}/reply`,
      OpenWaitSchema,
      commandInit("POST", ReplyOpenWaitCommandSchema.parse(command)),
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
  readTerminal: (runId, generation) =>
    request(
      `${CONTROL_API_PREFIX}/runs/${encodeURIComponent(runId)}/terminal/read?generation=${generation}&source=history&maxLines=500&maxBytes=262144`,
      TerminalReadResultSchema,
    ),
  listTerminalCheckpoints: () =>
    request(`${CONTROL_API_PREFIX}/terminal-checkpoints`, {
      parse: (value: unknown) => TerminalCheckpointSchema.array().parse(value),
    }),
  getTerminalCheckpoint: (checkpointId) =>
    request(
      `${CONTROL_API_PREFIX}/terminal-checkpoints/${encodeURIComponent(checkpointId)}`,
      TerminalCheckpointContentSchema,
    ),
  createEventsSocket: (afterSequence, instanceId) => control.openEvents(afterSequence, instanceId),
};
