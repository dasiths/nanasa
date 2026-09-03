import {
  type AgentAction,
  AgentActionSchema,
  type AgentActionWorkspace,
  AgentActionWorkspaceSchema,
  type AgentRun,
  AgentRunSchema,
  type AgentStatusDetail,
  AgentStatusDetailSchema,
  type AgentStatusSummary,
  AgentStatusSummarySchema,
  type ApproveCustomLaunchConsentCommand,
  type CancelCustomLaunchConsentCommand,
  type ClearMessageHistoryResult,
  ClearMessageHistoryResultSchema,
  type CreateAgentActionCommand,
  type CustomLaunchConsentDecision,
  type CustomLaunchConsentDecisionResult,
  CustomLaunchConsentDecisionResultSchema,
  CustomLaunchConsentDecisionSchema,
  type CustomLaunchConsentRequest,
  CustomLaunchConsentRequestListSchema,
  CustomLaunchConsentRequestSchema,
  type DeliveryOutcome,
  DeliveryOutcomeSchema,
  type DenyCustomLaunchConsentCommand,
  type MessagePage,
  MessagePageSchema,
  type MessageSubmissionResult,
  MessageSubmissionResultSchema,
  type OpenWait,
  OpenWaitSchema,
  type ProviderStateBinding,
  ProviderStateBindingSchema,
  type ProviderUpdateOutcome,
  ProviderUpdateOutcomeSchema,
  type ProviderUpdateRecoveryCommand,
  type ProviderUpdateRecoveryResult,
  ProviderUpdateRecoveryResultSchema,
  type ReplyOpenWaitCommand,
  type RevokeCustomLaunchConsentCommand,
  type StartAgentRunResult,
  StartAgentRunResultSchema,
  type StartGroupRunsResult,
  StartGroupRunsResultSchema,
  type SubmitMessageCommand,
  type TerminalEndpointStatus,
  TerminalEndpointStatusSchema,
  type TerminalReadResult,
  TerminalReadResultSchema,
  type WaitForAgentActionCommand,
} from "@nanasa/contracts";
import type { NanasaControlClient } from "../index.js";
import { commandInit, path, query, request } from "./common.js";

const WaitResultSchema = { parse: (value: unknown) => value };

export class OperationsResource {
  public constructor(private readonly client: NanasaControlClient) {}

  public listRuns(
    filters: { groupId?: string; memberId?: string; status?: string; active?: boolean } = {},
  ): Promise<AgentRun[]> {
    return request(this.client, `${path("runs")}${query(filters)}`, AgentRunSchema.array());
  }

  public getRun(runId: string): Promise<AgentRun> {
    return request(this.client, path("runs", runId), AgentRunSchema);
  }

  public startRun(
    groupId: string,
    agentId: string,
    size: object,
    key?: string,
  ): Promise<StartAgentRunResult> {
    return request(
      this.client,
      path("groups", groupId, "agents", agentId, "run"),
      StartAgentRunResultSchema,
      commandInit("POST", size, key),
    );
  }

  public stopRun(
    groupId: string,
    agentId: string,
    force: boolean,
    key?: string,
  ): Promise<AgentRun> {
    return request(
      this.client,
      path("groups", groupId, "agents", agentId, "run"),
      AgentRunSchema,
      commandInit("DELETE", { force }, key),
    );
  }

  public restartRun(runId: string, size: object, key?: string): Promise<StartAgentRunResult> {
    return request(
      this.client,
      path("runs", runId, "restart"),
      StartAgentRunResultSchema,
      commandInit("POST", size, key),
    );
  }

  public startAll(groupId: string, size: object, key?: string): Promise<StartGroupRunsResult> {
    return request(
      this.client,
      path("groups", groupId, "runs", "start-all"),
      StartGroupRunsResultSchema,
      commandInit("POST", size, key),
    );
  }

  public stopAll(groupId: string, force: boolean, key?: string): Promise<AgentRun[]> {
    return request(
      this.client,
      path("groups", groupId, "runs", "stop-all"),
      AgentRunSchema.array(),
      commandInit("POST", { force }, key),
    );
  }

  public restartAll(groupId: string, size: object, key?: string): Promise<StartGroupRunsResult> {
    return request(
      this.client,
      path("groups", groupId, "runs", "restart-all"),
      StartGroupRunsResultSchema,
      commandInit("POST", size, key),
    );
  }

  public recoverGroupRuns(
    groupId: string,
    command: ProviderUpdateRecoveryCommand,
  ): Promise<ProviderUpdateRecoveryResult> {
    return request(
      this.client,
      path("groups", groupId, "runs", "recover"),
      ProviderUpdateRecoveryResultSchema,
      commandInit("POST", command),
    );
  }

  public recoverAgentRun(
    groupId: string,
    agentId: string,
    command: ProviderUpdateRecoveryCommand,
  ): Promise<ProviderUpdateOutcome> {
    return request(
      this.client,
      path("groups", groupId, "agents", agentId, "run", "recover"),
      ProviderUpdateOutcomeSchema,
      commandInit("POST", command),
    );
  }

  public interrupt(runId: string, reason: string | undefined, key?: string): Promise<void> {
    return this.client.requestVoid(
      path("runs", runId, "interrupt"),
      commandInit("POST", reason === undefined ? {} : { reason }, key),
    );
  }

  public listStatuses(groupId?: string): Promise<AgentStatusSummary[]> {
    return request(
      this.client,
      `${path("statuses")}${query({ groupId })}`,
      AgentStatusSummarySchema.array(),
    );
  }

  public getStatus(groupId: string, memberId: string): Promise<AgentStatusDetail> {
    return request(
      this.client,
      path("groups", groupId, "members", memberId, "status"),
      AgentStatusDetailSchema,
    );
  }

  public acknowledgeStatus(
    groupId: string,
    memberId: string,
    key: string,
  ): Promise<AgentStatusDetail> {
    return request(
      this.client,
      path("groups", groupId, "members", memberId, "status", "acknowledge"),
      AgentStatusDetailSchema,
      commandInit("POST", {}, key),
    );
  }

  public submitMessage(
    groupId: string,
    command: SubmitMessageCommand,
    key: string,
  ): Promise<MessageSubmissionResult> {
    return request(
      this.client,
      path("groups", groupId, "messages"),
      MessageSubmissionResultSchema,
      commandInit("POST", command, key),
    );
  }

  public listMessages(
    groupId: string,
    options: { limit?: number; before?: number; after?: number } = {},
  ): Promise<MessagePage> {
    return request(
      this.client,
      `${path("groups", groupId, "messages")}${query(options)}`,
      MessagePageSchema,
    );
  }

  public clearMessages(groupId: string, key: string): Promise<ClearMessageHistoryResult> {
    return request(
      this.client,
      path("groups", groupId, "messages"),
      ClearMessageHistoryResultSchema,
      commandInit("DELETE", {}, key),
    );
  }

  public deliveries(messageId: string): Promise<DeliveryOutcome[]> {
    return request(
      this.client,
      path("messages", messageId, "deliveries"),
      DeliveryOutcomeSchema.array(),
    );
  }

  public createAction(command: CreateAgentActionCommand, key: string): Promise<AgentAction> {
    return request(
      this.client,
      path("agent-actions"),
      AgentActionSchema,
      commandInit("POST", command, key),
    );
  }

  public getAction(actionId: string): Promise<AgentAction> {
    return request(this.client, path("agent-actions", actionId), AgentActionSchema);
  }

  public actionWorkspace(groupId: string): Promise<AgentActionWorkspace> {
    return request(
      this.client,
      path("groups", groupId, "action-workspace"),
      AgentActionWorkspaceSchema,
    );
  }

  public cancelAction(actionId: string, key: string): Promise<AgentAction> {
    return request(
      this.client,
      path("agent-actions", actionId, "cancel"),
      AgentActionSchema,
      commandInit("POST", {}, key),
    );
  }

  public waitAction(actionId: string, command: WaitForAgentActionCommand): Promise<unknown> {
    return request(
      this.client,
      path("agent-actions", actionId, "wait"),
      WaitResultSchema,
      commandInit("POST", command),
    );
  }

  public listWaits(groupId: string, memberId?: string): Promise<OpenWait[]> {
    return request(
      this.client,
      `${path("open-waits")}${query({ groupId, memberId })}`,
      OpenWaitSchema.array(),
    );
  }

  public replyWait(waitId: string, command: ReplyOpenWaitCommand, key?: string): Promise<OpenWait> {
    return request(
      this.client,
      path("open-waits", waitId, "reply"),
      OpenWaitSchema,
      commandInit("POST", command, key),
    );
  }

  public listProviderStates(): Promise<ProviderStateBinding[]> {
    return request(this.client, path("provider-states"), ProviderStateBindingSchema.array());
  }

  public getProviderState(bindingId: string): Promise<ProviderStateBinding> {
    return request(this.client, path("provider-states", bindingId), ProviderStateBindingSchema);
  }

  public retainProviderState(bindingId: string, key: string): Promise<ProviderStateBinding> {
    return request(
      this.client,
      path("provider-states", bindingId, "retain"),
      ProviderStateBindingSchema,
      commandInit("POST", {}, key),
    );
  }

  public deleteProviderState(bindingId: string, key: string): Promise<ProviderStateBinding> {
    return request(
      this.client,
      path("provider-states", bindingId),
      ProviderStateBindingSchema,
      commandInit("DELETE", {}, key),
    );
  }

  public listLaunchConsents(
    state?: CustomLaunchConsentRequest["state"],
  ): Promise<CustomLaunchConsentRequest[]> {
    return request(
      this.client,
      `${path("launch-consents")}${query({ state })}`,
      CustomLaunchConsentRequestListSchema,
    );
  }

  public getLaunchConsent(requestId: string): Promise<CustomLaunchConsentRequest> {
    return request(
      this.client,
      path("launch-consents", requestId),
      CustomLaunchConsentRequestSchema,
    );
  }

  public approveLaunchConsent(
    requestId: string,
    command: ApproveCustomLaunchConsentCommand,
  ): Promise<CustomLaunchConsentDecisionResult> {
    return request(
      this.client,
      path("launch-consents", requestId, "approve"),
      CustomLaunchConsentDecisionResultSchema,
      commandInit("POST", command),
    );
  }

  public denyLaunchConsent(
    requestId: string,
    command: DenyCustomLaunchConsentCommand,
  ): Promise<CustomLaunchConsentDecisionResult> {
    return request(
      this.client,
      path("launch-consents", requestId, "deny"),
      CustomLaunchConsentDecisionResultSchema,
      commandInit("POST", command),
    );
  }

  public cancelLaunchConsent(
    requestId: string,
    command: CancelCustomLaunchConsentCommand,
  ): Promise<CustomLaunchConsentRequest> {
    return request(
      this.client,
      path("launch-consents", requestId, "cancel"),
      CustomLaunchConsentRequestSchema,
      commandInit("POST", command),
    );
  }

  public revokeLaunchConsent(
    receiptId: string,
    command: RevokeCustomLaunchConsentCommand,
  ): Promise<CustomLaunchConsentDecision> {
    return request(
      this.client,
      path("trust", receiptId, "revoke"),
      CustomLaunchConsentDecisionSchema,
      commandInit("POST", command),
    );
  }

  public terminalStatus(runId: string): Promise<TerminalEndpointStatus> {
    return request(this.client, path("runs", runId, "terminal"), TerminalEndpointStatusSchema);
  }

  public terminalRead(
    runId: string,
    generation: number,
    maxLines = 200,
    maxBytes = 65_536,
  ): Promise<TerminalReadResult> {
    return request(
      this.client,
      `${path("runs", runId, "terminal", "read")}${query({ generation, source: "history", maxLines, maxBytes })}`,
      TerminalReadResultSchema,
    );
  }
}
