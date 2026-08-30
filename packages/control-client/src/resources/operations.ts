import {
  AgentActionSchema,
  AgentActionWorkspaceSchema,
  AgentRunSchema,
  AgentStatusDetailSchema,
  AgentStatusSummarySchema,
  ClearMessageHistoryResultSchema,
  DeliveryOutcomeSchema,
  MessagePageSchema,
  MessageSubmissionResultSchema,
  OpenWaitSchema,
  ProviderStateBindingSchema,
  StartGroupRunsResultSchema,
  TerminalEndpointStatusSchema,
  TerminalReadResultSchema,
  type AgentAction,
  type AgentActionWorkspace,
  type AgentRun,
  type AgentStatusDetail,
  type AgentStatusSummary,
  type ClearMessageHistoryResult,
  type CreateAgentActionCommand,
  type DeliveryOutcome,
  type MessagePage,
  type MessageSubmissionResult,
  type OpenWait,
  type ProviderStateBinding,
  type ReplyOpenWaitCommand,
  type StartGroupRunsResult,
  type SubmitMessageCommand,
  type TerminalEndpointStatus,
  type TerminalReadResult,
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

  public startRun(groupId: string, agentId: string, size: object, key?: string): Promise<AgentRun> {
    return request(
      this.client,
      path("groups", groupId, "agents", agentId, "run"),
      AgentRunSchema,
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

  public restartRun(runId: string, size: object, key?: string): Promise<AgentRun> {
    return request(
      this.client,
      path("runs", runId, "restart"),
      AgentRunSchema,
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

  public restartAll(groupId: string, size: object, key?: string): Promise<AgentRun[]> {
    return request(
      this.client,
      path("groups", groupId, "runs", "restart-all"),
      AgentRunSchema.array(),
      commandInit("POST", size, key),
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
