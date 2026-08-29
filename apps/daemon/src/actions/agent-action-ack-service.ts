import { randomUUID } from "node:crypto";
import {
  type AgentActionAcknowledgementCommand,
  AgentActionAcknowledgementCommandSchema,
} from "@nanasa/contracts";
import type { McpPrincipal } from "../mcp-auth.js";
import { DomainError, type NanasaStore } from "../store.js";

export class AgentActionAckService {
  public constructor(
    private readonly store: NanasaStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public acknowledge(
    principal: McpPrincipal,
    actionId: string,
    command: AgentActionAcknowledgementCommand,
  ) {
    if (principal.kind !== "agent") {
      throw new DomainError(
        "agent_action_ack_reporter_required",
        "Only the exact target reporter may acknowledge an action",
        403,
      );
    }
    const input = AgentActionAcknowledgementCommandSchema.parse(command);
    const action = this.store.getAgentAction(actionId);
    if (
      principal.groupId !== action.target.groupId ||
      principal.memberId !== action.target.memberId ||
      principal.runId !== action.target.runId ||
      principal.generation !== action.target.generation
    ) {
      throw new DomainError(
        "agent_action_ack_principal_mismatch",
        "The authenticated run does not own this action target",
        403,
      );
    }
    const attempt = this.store.listActionAttempts(action.id).at(-1);
    const reporter = this.store.getCurrentReporterSession(
      action.target.runId,
      action.target.generation,
    );
    if (attempt === undefined || reporter === undefined) {
      throw new DomainError(
        "agent_action_ack_target_unavailable",
        "The action has no submitted attempt or current reporter",
        409,
      );
    }
    return this.store.recordAgentActionAcknowledgement({
      id: `ack_${randomUUID()}`,
      actionId: action.id,
      attemptId: attempt.id,
      kind: input.kind,
      runId: action.target.runId,
      generation: action.target.generation,
      reporterSessionId: reporter.id,
      reporterId: reporter.reporterId,
      reporterEpoch: reporter.reporterEpoch,
      sourceSequence: input.sourceSequence,
      nativeSessionId: reporter.nativeSessionId,
      providerTurnId: input.providerTurnId,
      providerRequestId: input.providerRequestId,
      completionRevision: input.completionRevision,
      acknowledgedAt: this.now().toISOString(),
      data: input.data,
    });
  }
}
