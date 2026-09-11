import {
  type AdHocConsoleSession,
  AdHocConsoleSessionSchema,
  type AgentAction,
  AgentActionSchema,
  type AgentActionWorkspace,
  AgentActionWorkspaceSchema,
  type AgentRun,
  AgentRunSchema,
  type AgentStatusDetail,
  AgentStatusDetailSchema,
  type ApproveCustomLaunchConsentCommand,
  ApproveCustomLaunchConsentCommandSchema,
  type AssignGroupCheckoutCommand,
  AssignGroupCheckoutCommandSchema,
  type AssignGroupCheckoutResult,
  type AttentionDismissalList,
  AttentionDismissalListSchema,
  type AttentionEventType,
  type AttentionSubscriptionsSnapshot,
  AttentionSubscriptionsSnapshotSchema,
  type BrowserRestartFrame,
  BrowserRestartFrameSchema,
  type CancelCustomLaunchConsentCommand,
  CancelCustomLaunchConsentCommandSchema,
  type ClearMessageHistoryResult,
  ClearMessageHistoryResultSchema,
  type ConfigStatus,
  ConfigStatusSchema,
  type ConfigureForemanCommand,
  type ControlMetadata,
  type CreateAgentActionCommand,
  CreateAgentActionCommandSchema,
  type CreateGroupAgentCommand,
  CreateGroupAgentCommandSchema,
  type CreateGroupCommand,
  CreateGroupCommandSchema,
  type CreateMissionCommand,
  type CreateWorktreeCommand,
  CreateWorktreeCommandSchema,
  type CustomLaunchConsentDecision,
  type CustomLaunchConsentDecisionResult,
  CustomLaunchConsentDecisionResultSchema,
  CustomLaunchConsentDecisionSchema,
  type CustomLaunchConsentRequest,
  CustomLaunchConsentRequestListSchema,
  CustomLaunchConsentRequestSchema,
  type CustomLaunchConsentRequestState,
  type DecideMissionApprovalCommand,
  type DeleteGroupResult,
  DeleteGroupResultSchema,
  type DenyCustomLaunchConsentCommand,
  DenyCustomLaunchConsentCommandSchema,
  type DismissAttentionItemsCommand,
  type ExtensionLifecycleCommand,
  type ExtensionTrustReceipt,
  ExtensionTrustReceiptSchema,
  type ForemanChannelMessage,
  ForemanChannelMessageSchema,
  type ForemanChannelPage,
  ForemanChannelPageSchema,
  type ForemanRun,
  ForemanRunSchema,
  type ForemanWorkspace,
  ForemanWorkspaceSchema,
  type GitReference,
  type GitStatusProjection,
  type Group,
  type GroupMembership,
  GroupMembershipSchema,
  GroupSchema,
  type InstallProviderExtensionCommand,
  type MemberAttentionSubscriptions,
  MemberAttentionSubscriptionsSchema,
  type MessagePage,
  MessagePageSchema,
  type MessageSubmissionResult,
  MessageSubmissionResultSchema,
  type Mission,
  type MissionApproval,
  MissionApprovalSchema,
  type MissionControlCommand,
  MissionSchema,
  type MissionWorkspace,
  MissionWorkspaceSchema,
  type NanasaConfig,
  NanasaConfigSchema,
  type OpenCheckoutCommand,
  OpenCheckoutCommandSchema,
  type OpenWait,
  OpenWaitSchema,
  type PortalSnapshot,
  PortalSnapshotSchema,
  type ProviderCatalogItem,
  ProviderCatalogItemSchema,
  type ProviderExtensionHealth,
  ProviderExtensionHealthSchema,
  type ProviderExtensionInspect,
  ProviderExtensionInspectSchema,
  type ProviderExtensionPlan,
  ProviderExtensionPlanSchema,
  type ProviderStateBinding,
  ProviderStateBindingSchema,
  type ProviderUpdateOutcome,
  type ProviderUpdateRecoveryCommand,
  type ProviderUpdateRecoveryResult,
  type RemoteDescriptor,
  RemoteDescriptorSchema,
  type RemoveGroupAgentResult,
  RemoveGroupAgentResultSchema,
  type RemoveWorktreeCommand,
  RemoveWorktreeCommandSchema,
  type ReorderGroupAgentsCommand,
  ReorderGroupAgentsCommandSchema,
  type ReorderGroupAgentsResult,
  type ReorderGroupsCommand,
  ReorderGroupsCommandSchema,
  type ReorderGroupsResult,
  type ReparentGroupAgentCommand,
  ReparentGroupAgentCommandSchema,
  type ReparentGroupAgentResult,
  type ReplyOpenWaitCommand,
  ReplyOpenWaitCommandSchema,
  type ResolveForemanInputCommand,
  type RevokeCustomLaunchConsentCommand,
  RevokeCustomLaunchConsentCommandSchema,
  type RoleDefinition,
  RoleDefinitionSchema,
  type SendForemanMessageCommand,
  type ServiceDescriptor,
  ServiceDescriptorSchema,
  type SetAttentionSubscriptionCommand,
  type StartAgentRunResult,
  StartAgentRunResultSchema,
  type StartForemanCommand,
  type StartGroupRunsResult,
  StartGroupRunsResultSchema,
  type StopForemanCommand,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
  type TerminalCheckpoint,
  type TerminalCheckpointCapture,
  TerminalCheckpointContentSchema,
  TerminalCheckpointSchema,
  type TerminalEndpointStatus,
  TerminalEndpointStatusSchema,
  type TerminalReadResult,
  TerminalReadResultSchema,
  type TrustProviderExtensionCommand,
  type UpdateGroupAgentCommand,
  UpdateGroupAgentCommandSchema,
  type UpdateGroupCommand,
  UpdateGroupCommandSchema,
  type UpdateRolePresentationCommand,
  UpdateRolePresentationCommandSchema,
  type UrlOpenRequest,
  UrlOpenRequestListSchema,
  UrlOpenRequestSchema,
  type WorktreeOperationResult,
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
  decideMissionApproval(
    approvalId: string,
    command: DecideMissionApprovalCommand,
  ): Promise<MissionApproval>;
  resolveForemanInput(command: ResolveForemanInputCommand): Promise<ForemanWorkspace>;
  listMissions(): Promise<Mission[]>;
  getMission(missionId: string): Promise<MissionWorkspace>;
  createMission(command: CreateMissionCommand): Promise<Mission>;
  controlMission(missionId: string, command: MissionControlCommand): Promise<Mission>;
  loadForeman(): Promise<ForemanWorkspace>;
  configureForeman(command: ConfigureForemanCommand): Promise<ForemanWorkspace>;
  startForeman(command: StartForemanCommand): Promise<ForemanRun>;
  stopForeman(command: StopForemanCommand): Promise<ForemanWorkspace>;
  loadForemanChannel(after?: number): Promise<ForemanChannelPage>;
  sendForemanMessage(command: SendForemanMessageCommand): Promise<ForemanChannelMessage>;
  createConsole(): Promise<AdHocConsoleSession>;
  closeConsole(consoleId: string): Promise<void>;
  loadMetadata(): Promise<ControlMetadata>;
  loadSnapshot(): Promise<PortalSnapshot>;
  loadConfig(): Promise<NanasaConfig>;
  loadConfigStatus(): Promise<ConfigStatus>;
  loadServiceStatus(): Promise<ServiceDescriptor>;
  loadRemoteStatus(): Promise<RemoteDescriptor>;
  planServiceRestart(reason: BrowserRestartFrame["reason"]): Promise<BrowserRestartFrame>;
  listProviderStates(): Promise<ProviderStateBinding[]>;
  listProviderExtensions(): Promise<ProviderCatalogItem[]>;
  inspectProviderExtension(extensionId: string): Promise<ProviderExtensionInspect>;
  planProviderExtension(extensionId: string): Promise<ProviderExtensionPlan>;
  providerExtensionHealth(extensionId: string): Promise<ProviderExtensionHealth>;
  trustProviderExtension(
    extensionId: string,
    command: TrustProviderExtensionCommand,
  ): Promise<ExtensionTrustReceipt>;
  installProviderExtension(
    extensionId: string,
    command: InstallProviderExtensionCommand,
  ): Promise<ProviderExtensionInspect>;
  repairProviderExtension(
    extensionId: string,
    command: InstallProviderExtensionCommand,
  ): Promise<ProviderExtensionInspect>;
  disableProviderExtension(
    extensionId: string,
    command: ExtensionLifecycleCommand,
  ): Promise<ProviderExtensionInspect>;
  rollbackProviderExtension(
    extensionId: string,
    command: ExtensionLifecycleCommand,
  ): Promise<ProviderExtensionInspect>;
  removeProviderExtension(
    extensionId: string,
    command: ExtensionLifecycleCommand,
  ): Promise<ProviderCatalogItem>;
  retainProviderState(bindingId: string): Promise<ProviderStateBinding>;
  deleteProviderState(bindingId: string): Promise<ProviderStateBinding>;
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
    command: AssignGroupCheckoutCommand,
  ): Promise<AssignGroupCheckoutResult>;
  refreshCheckout(checkoutId: string): Promise<GitStatusProjection>;
  listCheckoutReferences(checkoutId: string): Promise<GitReference[]>;
  fetchCheckout(checkoutId: string): Promise<GitStatusProjection[]>;
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
  startRun(groupId: string, agentId: string): Promise<StartAgentRunResult>;
  startAllRuns(groupId: string, idempotencyKey: string): Promise<StartGroupRunsResult>;
  recoverGroupRuns(
    groupId: string,
    command: ProviderUpdateRecoveryCommand,
  ): Promise<ProviderUpdateRecoveryResult>;
  recoverAgentRun(
    groupId: string,
    agentId: string,
    command: ProviderUpdateRecoveryCommand,
  ): Promise<ProviderUpdateOutcome>;
  stopRun(groupId: string, agentId: string): Promise<AgentRun>;
  stopAllRuns(groupId: string): Promise<AgentRun[]>;
  listLaunchConsents(
    state?: CustomLaunchConsentRequestState,
  ): Promise<CustomLaunchConsentRequest[]>;
  getLaunchConsent(requestId: string): Promise<CustomLaunchConsentRequest>;
  approveLaunchConsent(
    requestId: string,
    command: ApproveCustomLaunchConsentCommand,
  ): Promise<CustomLaunchConsentDecisionResult>;
  denyLaunchConsent(
    requestId: string,
    command: DenyCustomLaunchConsentCommand,
  ): Promise<CustomLaunchConsentDecisionResult>;
  cancelLaunchConsent(
    requestId: string,
    command: CancelCustomLaunchConsentCommand,
  ): Promise<CustomLaunchConsentRequest>;
  revokeLaunchConsent(
    receiptId: string,
    command: RevokeCustomLaunchConsentCommand,
  ): Promise<CustomLaunchConsentDecision>;
  submitMessage(groupId: string, command: SubmitMessageCommand): Promise<MessageSubmissionResult>;
  createAgentAction(command: CreateAgentActionCommand): Promise<AgentAction>;
  loadActionWorkspace(groupId: string): Promise<AgentActionWorkspace>;
  cancelAgentAction(actionId: string): Promise<AgentAction>;
  replyOpenWait(waitId: string, command: ReplyOpenWaitCommand): Promise<OpenWait>;
  acknowledgeCompletion(groupId: string, memberId: string): Promise<AgentStatusDetail>;
  listAttentionDismissals(): Promise<AttentionDismissalList>;
  listUrlOpenRequests(): Promise<UrlOpenRequest[]>;
  getUrlOpenRequest(requestId: string): Promise<UrlOpenRequest>;
  dismissAttentionItems(command: DismissAttentionItemsCommand): Promise<AttentionDismissalList>;
  listAttentionSubscriptions(): Promise<AttentionSubscriptionsSnapshot>;
  setAttentionSubscription(
    groupId: string,
    memberId: string,
    eventType: AttentionEventType,
    command: SetAttentionSubscriptionCommand,
  ): Promise<MemberAttentionSubscriptions>;
  resetAttentionSubscriptions(
    groupId: string,
    memberId: string,
  ): Promise<MemberAttentionSubscriptions>;
  loadMessages(
    groupId: string,
    options?: { limit?: number; before?: number; after?: number },
  ): Promise<MessagePage>;
  clearMessages(groupId: string): Promise<ClearMessageHistoryResult>;
  getTerminalEndpointStatus(runId: string): Promise<TerminalEndpointStatus>;
  readTerminal(runId: string, generation: number): Promise<TerminalReadResult>;
  listTerminalCheckpoints(): Promise<TerminalCheckpoint[]>;
  createTerminalCheckpoint(
    runId: string,
    command: TerminalCheckpointCapture,
  ): Promise<TerminalCheckpoint>;
  getTerminalCheckpoint(
    checkpointId: string,
  ): Promise<{ checkpoint: TerminalCheckpoint; text: string }>;
  deleteTerminalCheckpoint(checkpointId: string): Promise<void>;
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
  idempotencyKey?: string,
): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  };
}

export const api: PortalClient = {
  decideMissionApproval: (approvalId, command) =>
    request(
      `${CONTROL_API_PREFIX}/mission-approvals/${encodeURIComponent(approvalId)}`,
      MissionApprovalSchema,
      commandInit("POST", command),
    ),
  resolveForemanInput: (command) =>
    request(
      `${CONTROL_API_PREFIX}/foreman/inbox/resolve`,
      ForemanWorkspaceSchema,
      commandInit("POST", command),
    ),
  listMissions: () => request(`${CONTROL_API_PREFIX}/missions`, MissionSchema.array()),
  getMission: (missionId) =>
    request(
      `${CONTROL_API_PREFIX}/missions/${encodeURIComponent(missionId)}`,
      MissionWorkspaceSchema,
    ),
  createMission: (command) =>
    request(`${CONTROL_API_PREFIX}/missions`, MissionSchema, commandInit("POST", command)),
  controlMission: (missionId, command) =>
    request(
      `${CONTROL_API_PREFIX}/missions/${encodeURIComponent(missionId)}/control`,
      MissionSchema,
      commandInit("POST", command),
    ),
  loadForeman: () => request(`${CONTROL_API_PREFIX}/foreman`, ForemanWorkspaceSchema),
  configureForeman: (command) =>
    request(
      `${CONTROL_API_PREFIX}/foreman/configuration`,
      ForemanWorkspaceSchema,
      commandInit("PUT", command),
    ),
  startForeman: (command) =>
    request(
      `${CONTROL_API_PREFIX}/foreman/run/start`,
      ForemanRunSchema,
      commandInit("POST", command),
    ),
  stopForeman: (command) =>
    request(
      `${CONTROL_API_PREFIX}/foreman/run/stop`,
      ForemanWorkspaceSchema,
      commandInit("POST", command),
    ),
  loadForemanChannel: (after = 0) =>
    request(
      `${CONTROL_API_PREFIX}/foreman/channel?after=${after}&limit=100`,
      ForemanChannelPageSchema,
    ),
  sendForemanMessage: (command) =>
    request(
      `${CONTROL_API_PREFIX}/foreman/channel`,
      ForemanChannelMessageSchema,
      commandInit("POST", command),
    ),
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
  loadConfigStatus: () => request(`${CONTROL_API_PREFIX}/config/status`, ConfigStatusSchema),
  loadServiceStatus: () => request(`${CONTROL_API_PREFIX}/service`, ServiceDescriptorSchema),
  loadRemoteStatus: () => request(`${CONTROL_API_PREFIX}/remote`, RemoteDescriptorSchema),
  planServiceRestart: (reason) =>
    request(
      `${CONTROL_API_PREFIX}/service/restart-plan`,
      BrowserRestartFrameSchema,
      commandInit("POST", { reason }, crypto.randomUUID()),
    ),
  listProviderStates: () =>
    request(`${CONTROL_API_PREFIX}/provider-states`, ProviderStateBindingSchema.array()),
  listProviderExtensions: () =>
    request(`${CONTROL_API_PREFIX}/extensions`, ProviderCatalogItemSchema.array()),
  inspectProviderExtension: (extensionId) =>
    request(
      `${CONTROL_API_PREFIX}/extensions/${encodeURIComponent(extensionId)}`,
      ProviderExtensionInspectSchema,
    ),
  planProviderExtension: (extensionId) =>
    request(
      `${CONTROL_API_PREFIX}/extensions/${encodeURIComponent(extensionId)}/plan`,
      ProviderExtensionPlanSchema,
    ),
  providerExtensionHealth: (extensionId) =>
    request(
      `${CONTROL_API_PREFIX}/extensions/${encodeURIComponent(extensionId)}/health`,
      ProviderExtensionHealthSchema,
    ),
  trustProviderExtension: (extensionId, command) =>
    request(
      `${CONTROL_API_PREFIX}/extensions/${encodeURIComponent(extensionId)}/trust`,
      ExtensionTrustReceiptSchema,
      commandInit("POST", command),
    ),
  installProviderExtension: (extensionId, command) =>
    request(
      `${CONTROL_API_PREFIX}/extensions/${encodeURIComponent(extensionId)}/install`,
      ProviderExtensionInspectSchema,
      commandInit("POST", command),
    ),
  repairProviderExtension: (extensionId, command) =>
    request(
      `${CONTROL_API_PREFIX}/extensions/${encodeURIComponent(extensionId)}/repair`,
      ProviderExtensionInspectSchema,
      commandInit("POST", command),
    ),
  disableProviderExtension: (extensionId, command) =>
    request(
      `${CONTROL_API_PREFIX}/extensions/${encodeURIComponent(extensionId)}/disable`,
      ProviderExtensionInspectSchema,
      commandInit("POST", command),
    ),
  rollbackProviderExtension: (extensionId, command) =>
    request(
      `${CONTROL_API_PREFIX}/extensions/${encodeURIComponent(extensionId)}/rollback`,
      ProviderExtensionInspectSchema,
      commandInit("POST", command),
    ),
  removeProviderExtension: (extensionId, command) =>
    request(
      `${CONTROL_API_PREFIX}/extensions/${encodeURIComponent(extensionId)}`,
      ProviderCatalogItemSchema,
      commandInit("DELETE", command),
    ),
  retainProviderState: (bindingId) =>
    request(
      `${CONTROL_API_PREFIX}/provider-states/${encodeURIComponent(bindingId)}/retain`,
      ProviderStateBindingSchema,
      commandInit("POST", {}, crypto.randomUUID()),
    ),
  deleteProviderState: (bindingId) =>
    request(
      `${CONTROL_API_PREFIX}/provider-states/${encodeURIComponent(bindingId)}`,
      ProviderStateBindingSchema,
      commandInit("DELETE", {}, crypto.randomUUID()),
    ),
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
    resources.topology.reorderAgents(groupId, ReorderGroupAgentsCommandSchema.parse(command)),
  reorderGroups: (command) =>
    resources.topology.reorderGroups(ReorderGroupsCommandSchema.parse(command)),
  reparentAgent: (groupId, agentId, command) =>
    resources.topology.reparentAgent(
      groupId,
      agentId,
      ReparentGroupAgentCommandSchema.parse(command),
    ),
  assignCheckout: (groupId, command) =>
    resources.topology.assignCheckout(groupId, AssignGroupCheckoutCommandSchema.parse(command)),
  refreshCheckout: (checkoutId) => resources.workspace.refreshCheckout(checkoutId),
  listCheckoutReferences: (checkoutId) => resources.workspace.listCheckoutReferences(checkoutId),
  fetchCheckout: (checkoutId) => resources.workspace.fetchCheckout(checkoutId),
  createWorktree: (command) =>
    resources.workspace.createWorktree(CreateWorktreeCommandSchema.parse(command)),
  openCheckout: (command) =>
    resources.workspace.openCheckout(OpenCheckoutCommandSchema.parse(command)),
  removeWorktree: (worktreeId, command) =>
    resources.workspace.removeWorktree(worktreeId, RemoveWorktreeCommandSchema.parse(command)),
  updateRolePresentation: (roleId, command) =>
    request(
      `${CONTROL_API_PREFIX}/roles/${encodeURIComponent(roleId)}/presentation`,
      RoleDefinitionSchema,
      commandInit("PATCH", UpdateRolePresentationCommandSchema.parse(command)),
    ),
  startRun: (groupId, agentId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}/run`,
      StartAgentRunResultSchema,
      commandInit("POST", {}),
    ),
  startAllRuns: (groupId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/runs/start-all`,
      StartGroupRunsResultSchema,
      commandInit("POST", {}),
    ),
  recoverGroupRuns: (groupId, command) => resources.operations.recoverGroupRuns(groupId, command),
  recoverAgentRun: (groupId, agentId, command) =>
    resources.operations.recoverAgentRun(groupId, agentId, command),
  stopRun: (groupId, agentId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}/run`,
      AgentRunSchema,
      commandInit("DELETE", {}),
    ),
  stopAllRuns: (groupId) => resources.operations.stopAll(groupId, false),
  listLaunchConsents: (state) => {
    const query = state === undefined ? "" : `?${new URLSearchParams({ state }).toString()}`;
    return request(
      `${CONTROL_API_PREFIX}/launch-consents${query}`,
      CustomLaunchConsentRequestListSchema,
    );
  },
  getLaunchConsent: (requestId) =>
    request(
      `${CONTROL_API_PREFIX}/launch-consents/${encodeURIComponent(requestId)}`,
      CustomLaunchConsentRequestSchema,
    ),
  approveLaunchConsent: (requestId, command) =>
    request(
      `${CONTROL_API_PREFIX}/launch-consents/${encodeURIComponent(requestId)}/approve`,
      CustomLaunchConsentDecisionResultSchema,
      commandInit("POST", ApproveCustomLaunchConsentCommandSchema.parse(command)),
    ),
  denyLaunchConsent: (requestId, command) =>
    request(
      `${CONTROL_API_PREFIX}/launch-consents/${encodeURIComponent(requestId)}/deny`,
      CustomLaunchConsentDecisionResultSchema,
      commandInit("POST", DenyCustomLaunchConsentCommandSchema.parse(command)),
    ),
  cancelLaunchConsent: (requestId, command) =>
    request(
      `${CONTROL_API_PREFIX}/launch-consents/${encodeURIComponent(requestId)}/cancel`,
      CustomLaunchConsentRequestSchema,
      commandInit("POST", CancelCustomLaunchConsentCommandSchema.parse(command)),
    ),
  revokeLaunchConsent: (receiptId, command) =>
    request(
      `${CONTROL_API_PREFIX}/trust/${encodeURIComponent(receiptId)}/revoke`,
      CustomLaunchConsentDecisionSchema,
      commandInit("POST", RevokeCustomLaunchConsentCommandSchema.parse(command)),
    ),
  submitMessage: (groupId, command) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/messages`,
      MessageSubmissionResultSchema,
      commandInit("POST", SubmitMessageCommandSchema.parse(command), crypto.randomUUID()),
    ),
  createAgentAction: (command) =>
    request(
      `${CONTROL_API_PREFIX}/agent-actions`,
      AgentActionSchema,
      commandInit("POST", CreateAgentActionCommandSchema.parse(command), crypto.randomUUID()),
    ),
  loadActionWorkspace: (groupId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/action-workspace`,
      AgentActionWorkspaceSchema,
    ),
  cancelAgentAction: (actionId) =>
    request(
      `${CONTROL_API_PREFIX}/agent-actions/${encodeURIComponent(actionId)}/cancel`,
      AgentActionSchema,
      commandInit("POST", {}, crypto.randomUUID()),
    ),
  replyOpenWait: (waitId, command) =>
    request(
      `${CONTROL_API_PREFIX}/open-waits/${encodeURIComponent(waitId)}/reply`,
      OpenWaitSchema,
      commandInit("POST", ReplyOpenWaitCommandSchema.parse(command)),
    ),
  acknowledgeCompletion: (groupId, memberId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}/status/acknowledge`,
      AgentStatusDetailSchema,
      commandInit("POST", {}, crypto.randomUUID()),
    ),
  listAttentionDismissals: () =>
    request(`${CONTROL_API_PREFIX}/attention-dismissals`, AttentionDismissalListSchema),
  listUrlOpenRequests: () =>
    request(`${CONTROL_API_PREFIX}/url-open-requests`, UrlOpenRequestListSchema),
  getUrlOpenRequest: (requestId) =>
    request(
      `${CONTROL_API_PREFIX}/url-open-requests/${encodeURIComponent(requestId)}`,
      UrlOpenRequestSchema,
    ),
  dismissAttentionItems: (command) =>
    request(
      `${CONTROL_API_PREFIX}/attention-dismissals`,
      AttentionDismissalListSchema,
      commandInit("POST", command, crypto.randomUUID()),
    ),
  listAttentionSubscriptions: () =>
    request(`${CONTROL_API_PREFIX}/attention-subscriptions`, AttentionSubscriptionsSnapshotSchema),
  setAttentionSubscription: (groupId, memberId, eventType, command) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}/attention-subscriptions/${encodeURIComponent(eventType)}`,
      MemberAttentionSubscriptionsSchema,
      commandInit("PUT", command, crypto.randomUUID()),
    ),
  resetAttentionSubscriptions: (groupId, memberId) =>
    request(
      `${CONTROL_API_PREFIX}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}/attention-subscriptions`,
      MemberAttentionSubscriptionsSchema,
      commandInit("DELETE", {}, crypto.randomUUID()),
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
      commandInit("DELETE", {}, crypto.randomUUID()),
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
  createTerminalCheckpoint: (runId, command) =>
    request(
      `${CONTROL_API_PREFIX}/runs/${encodeURIComponent(runId)}/terminal/checkpoints`,
      TerminalCheckpointSchema,
      commandInit("POST", command),
    ),
  getTerminalCheckpoint: (checkpointId) =>
    request(
      `${CONTROL_API_PREFIX}/terminal-checkpoints/${encodeURIComponent(checkpointId)}`,
      TerminalCheckpointContentSchema,
    ),
  deleteTerminalCheckpoint: (checkpointId) =>
    requestVoid(
      `${CONTROL_API_PREFIX}/terminal-checkpoints/${encodeURIComponent(checkpointId)}`,
      commandInit("DELETE", {}),
    ),
  createEventsSocket: (afterSequence, instanceId) => control.openEvents(afterSequence, instanceId),
};
