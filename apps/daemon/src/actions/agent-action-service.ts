import { createHash, randomUUID } from "node:crypto";
import {
  type AgentAction,
  AgentActionSchema,
  type AgentActionPrincipal,
  type AgentActionWorkspace,
  AgentActionWorkspaceSchema,
  type CreateAgentActionCommand,
  CreateAgentActionCommandSchema,
} from "@nanasa/contracts";
import { DomainError, type NanasaStore } from "../store.js";
import { PeerCapabilityPolicy } from "./peer-capability-policy.js";

const TERMINAL_ACTION_STATES = new Set<AgentAction["state"]>([
  "completed",
  "settled-unverified",
  "failed",
  "stalled",
  "timed-out",
  "cancelled",
  "expired",
  "superseded",
  "rejected",
]);

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class AgentActionService {
  public constructor(
    private readonly store: NanasaStore,
    private readonly daemonEpoch: number,
    private readonly policy = new PeerCapabilityPolicy(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  public create(
    principal: AgentActionPrincipal,
    command: CreateAgentActionCommand,
    idempotencyKey: string,
  ): AgentAction {
    const input = CreateAgentActionCommandSchema.parse(command);
    this.policy.assertCreate(principal, input);
    const run = this.store.getActiveRun(input.groupId, input.memberId);
    if (run === undefined || !["starting", "running"].includes(run.status)) {
      throw new DomainError("agent_action_target_offline", "The target has no active run", 409);
    }
    if (input.expectedRunId !== undefined && input.expectedRunId !== run.id) {
      throw new DomainError(
        "agent_action_run_mismatch",
        "The expected target run was replaced",
        409,
      );
    }
    if (input.expectedGeneration !== undefined && input.expectedGeneration !== run.generation) {
      throw new DomainError(
        "agent_action_generation_mismatch",
        "The expected target generation was replaced",
        409,
      );
    }
    const reporter = this.store.getCurrentReporterSession(run.id, run.generation);
    if (reporter === undefined) {
      throw new DomainError(
        "agent_action_reporter_unavailable",
        "The target has no current reporter identity",
        409,
      );
    }
    const status = this.store.getAgentStatus(input.groupId, input.memberId);
    if (
      input.expectedStatusRevision !== undefined &&
      input.expectedStatusRevision !== status.statusRevision
    ) {
      throw new DomainError(
        "agent_action_status_revision_mismatch",
        "The expected target status revision changed",
        409,
      );
    }
    let conversationId = input.conversationId;
    if (input.messageId !== undefined) {
      const message = this.store.getMessage(input.messageId);
      if (message.groupId !== input.groupId) {
        throw new DomainError(
          "agent_action_message_mismatch",
          "The linked message belongs to another group",
          409,
        );
      }
      if (conversationId !== undefined && conversationId !== message.conversationId) {
        throw new DomainError(
          "agent_action_conversation_mismatch",
          "The linked message belongs to another conversation",
          409,
        );
      }
      conversationId = message.conversationId;
    }
    if (input.replyToActionId !== undefined) {
      const parent = this.store.getAgentAction(input.replyToActionId);
      if (parent.target.groupId !== input.groupId) {
        throw new DomainError(
          "agent_action_reply_mismatch",
          "The parent action belongs to another group",
          409,
        );
      }
    }
    const createdAt = this.now();
    const requestDigest = digest({ principal, input });
    return this.store.createAgentAction(
      AgentActionSchema.parse({
        version: 1,
        id: `action_${randomUUID()}`,
        kind: input.kind,
        principal,
        target: {
          groupId: input.groupId,
          memberId: input.memberId,
          runId: run.id,
          generation: run.generation,
          daemonEpoch: this.daemonEpoch,
          reporterSessionId: reporter.id,
          reporterId: reporter.reporterId,
          reporterEpoch: reporter.reporterEpoch,
          nativeSessionId: reporter.nativeSessionId,
          baselineStatusRevision: status.statusRevision,
          baselineCompletionRevision: status.completionRevision,
        },
        messageId: input.messageId,
        conversationId,
        replyToActionId: input.replyToActionId,
        causationId: input.causationId,
        idempotencyKey,
        requestDigest,
        prompt: input.prompt,
        allowWorking: input.allowWorking,
        state: "created",
        queueDeadlineAt: new Date(createdAt.getTime() + input.queueTimeoutMs).toISOString(),
        acceptanceDeadlineAt: new Date(
          createdAt.getTime() + input.queueTimeoutMs + input.acceptanceTimeoutMs,
        ).toISOString(),
        completionDeadlineAt: new Date(
          createdAt.getTime() + input.queueTimeoutMs + input.completionTimeoutMs,
        ).toISOString(),
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      }),
    );
  }

  public get(principal: AgentActionPrincipal, actionId: string): AgentAction {
    const action = this.store.getAgentAction(actionId);
    this.policy.assertRead(principal, action);
    return action;
  }

  public listWorkspace(groupId: string): AgentActionWorkspace {
    const actions = this.store.listAgentActions(groupId);
    const actionIds = new Set(actions.map((action) => action.id));
    return AgentActionWorkspaceSchema.parse({
      groupId,
      actions,
      attempts: this.store
        .listActionAttempts()
        .filter((attempt) => actionIds.has(attempt.actionId)),
      acknowledgements: this.store
        .listActionAcknowledgements()
        .filter((acknowledgement) => actionIds.has(acknowledgement.actionId)),
      openWaits: this.store.listOpenWaits(groupId),
    });
  }

  public cancel(principal: AgentActionPrincipal, actionId: string): AgentAction {
    const action = this.store.getAgentAction(actionId);
    this.policy.assertCancel(principal, action);
    if (TERMINAL_ACTION_STATES.has(action.state)) return action;
    if (!["created", "deferred"].includes(action.state)) {
      throw new DomainError(
        "agent_action_cancel_requires_ack",
        "Submitted work is not cancelled until the exact provider acknowledges cancellation",
        409,
      );
    }
    return this.store.transitionAgentAction(action.id, [action.state], "cancelled");
  }
}
