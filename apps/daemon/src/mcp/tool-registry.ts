import {
  AgentActionStateSchema,
  AgentProgressReportCommandSchema,
  AskForemanMemberCommandSchema,
  DelegateForemanGoalCommandSchema,
  ForemanChannelQuerySchema,
  ForemanCheckInCommandSchema,
  ForemanConversationQuerySchema,
  ProposeForemanGoalCommandSchema,
  ReplyForemanConversationCommandSchema,
  ReportDelegationCommandSchema,
  RequestHumanDecisionCommandSchema,
  SendForemanMessageCommandSchema,
} from "@nanasa/contracts";
import { z } from "zod";
import type { McpPrincipal } from "../mcp-auth.js";
import { DomainError } from "../store.js";

export const McpIdentifierSchema = z.string().trim().min(1).max(128);
export const McpForemanBootstrapSchema = z.object({}).strict();
export const McpConversationReferenceSchema = z.object({ id: McpIdentifierSchema }).strict();
export const McpGoalReferenceSchema = z.object({ goalId: McpIdentifierSchema }).strict();
export const McpObserveTeamSchema = z
  .object({ delegationId: McpIdentifierSchema, memberId: McpIdentifierSchema.optional() })
  .strict();
export const McpMessageFieldsSchema = z
  .object({
    groupId: McpIdentifierSchema.optional(),
    text: z.string().min(1),
    intent: z.enum(["inform", "request", "response"]).default("request"),
    contentType: z.enum(["text/plain", "text/markdown"]).default("text/markdown"),
    conversationId: McpIdentifierSchema.optional(),
    replyTo: McpIdentifierSchema.optional(),
  })
  .strict();
export const McpDirectMessageSchema = McpMessageFieldsSchema.extend({
  recipientMemberId: McpIdentifierSchema,
});
export const McpMulticastMessageSchema = McpMessageFieldsSchema.extend({
  recipientMemberIds: z
    .array(McpIdentifierSchema)
    .min(2)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const McpListMembersSchema = z.object({ groupId: McpIdentifierSchema.optional() }).strict();
export const McpListAgentStatusesSchema = z
  .object({
    groupId: McpIdentifierSchema.optional(),
    attentionOnly: z.boolean().default(false),
  })
  .strict();
export const McpGetAgentStatusSchema = z
  .object({ groupId: McpIdentifierSchema.optional(), memberId: McpIdentifierSchema })
  .strict();
export const McpPromptPeerSchema = z
  .object({
    groupId: McpIdentifierSchema.optional(),
    memberId: McpIdentifierSchema,
    prompt: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1).max(256),
    expectedRunId: McpIdentifierSchema.optional(),
    expectedGeneration: z.number().int().positive().optional(),
    expectedStatusRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export const McpActionReferenceSchema = z.object({ actionId: McpIdentifierSchema }).strict();
export const McpWaitActionSchema = McpActionReferenceSchema.extend({
  states: z.array(AgentActionStateSchema).min(1).max(16),
  timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
}).strict();
export const McpOwnWaitsSchema = z.object({ groupId: McpIdentifierSchema.optional() }).strict();
export const McpDeliverySchema = z
  .object({
    messageId: McpIdentifierSchema,
    recipientMemberId: McpIdentifierSchema.optional(),
  })
  .strict();
export const McpVisibleHistorySchema = z
  .object({
    groupId: McpIdentifierSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    before: z.number().int().positive().optional(),
    after: z.number().int().positive().optional(),
  })
  .strict();

export interface McpToolDeclaration {
  readonly name: `nanasa.${string}`;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly principals: ReadonlyArray<McpPrincipal["kind"]>;
  readonly scope: string;
  readonly authority: "read" | "self-write" | "scoped-peer-action" | "message";
}

function tool(input: McpToolDeclaration): McpToolDeclaration {
  return Object.freeze({ ...input, principals: Object.freeze([...input.principals]) });
}

export const MCP_TOOL_REGISTRY = Object.freeze([
  tool({
    name: "nanasa.foreman_ask_member",
    description:
      "Ask a selected team member a bounded question without creating a goal or reserving a team; delivery waits for idle readiness, and only a correlated reply counts as answered",
    inputSchema: AskForemanMemberCommandSchema,
    principals: ["foreman"],
    scope: "foreman:conversations:ask",
    authority: "message",
  }),
  tool({
    name: "nanasa.foreman_read_conversations",
    description:
      "Read durable ad hoc requests and member replies, including pending and expired requests",
    inputSchema: ForemanConversationQuerySchema,
    principals: ["foreman"],
    scope: "foreman:conversations:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_finish_conversation",
    description:
      "Acknowledge processing a conversation result after reporting it to the Human; does not erase the thread",
    inputSchema: McpConversationReferenceSchema,
    principals: ["foreman"],
    scope: "foreman:conversations:finish",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.member_foreman_conversations",
    description:
      "Read only conversation requests addressed to your authenticated member and runtime",
    inputSchema: ForemanConversationQuerySchema,
    principals: ["agent"],
    scope: "member:foreman-conversations:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.reply_foreman",
    description:
      "Deliver a durable correlated answer to an addressed Foreman request; terminal output alone is not a reply",
    inputSchema: ReplyForemanConversationCommandSchema,
    principals: ["agent"],
    scope: "member:foreman-conversations:reply",
    authority: "message",
  }),
  tool({
    name: "nanasa.foreman_check_in",
    description:
      "Send a bounded idle check-in to the accountable member only, under explicit intervention policy and exact observed runtime identity",
    inputSchema: ForemanCheckInCommandSchema,
    principals: ["foreman"],
    scope: "foreman:teams:check-in",
    authority: "scoped-peer-action",
  }),
  tool({
    name: "nanasa.foreman_discover_teams",
    description:
      "Discover current teams, role descriptions, permissions, readiness and reservations; discovery does not grant authority",
    inputSchema: McpForemanBootstrapSchema,
    principals: ["foreman"],
    scope: "foreman:teams:discover",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_propose_goal",
    description:
      "Propose a high-level outcome for human approval without requiring an implementation plan",
    inputSchema: ProposeForemanGoalCommandSchema,
    principals: ["foreman"],
    scope: "foreman:goals:propose",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_get_goal",
    description: "Read durable goal, team delegations, reports and human decisions",
    inputSchema: McpGoalReferenceSchema,
    principals: ["foreman"],
    scope: "foreman:goals:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_delegate_goal",
    description:
      "Propose a specific team and accountable member to own research, planning, implementation and review; requires explicit human authorization",
    inputSchema: DelegateForemanGoalCommandSchema,
    principals: ["foreman"],
    scope: "foreman:goals:delegate",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_observe_team",
    description:
      "Observe approved delegated team health and optionally bounded untrusted member transcript evidence",
    inputSchema: McpObserveTeamSchema,
    principals: ["foreman"],
    scope: "foreman:teams:observe",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_finish_goal_review",
    description: "Finish the durable goal supervision wakeup without claiming team completion",
    inputSchema: McpGoalReferenceSchema,
    principals: ["foreman"],
    scope: "foreman:goals:review",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.team_delegations",
    description: "Read your team's approved outcome delegation, checkpoints and human decisions",
    inputSchema: McpForemanBootstrapSchema,
    principals: ["agent"],
    scope: "team:delegations:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.report_delegation",
    description:
      "Report acceptance, a plan, progress, blockers or readiness with evidence; only the accountable member can accept or finish",
    inputSchema: ReportDelegationCommandSchema,
    principals: ["agent"],
    scope: "team:delegations:report",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.request_human_decision",
    description:
      "Raise a durable correlated human question; an answer never grants unrelated runtime permissions",
    inputSchema: RequestHumanDecisionCommandSchema,
    principals: ["foreman", "agent"],
    scope: "coordination:decisions:request",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_read_channel",
    description:
      "Read bounded operator instructions and Foreman replies from the repository channel",
    inputSchema: ForemanChannelQuerySchema,
    principals: ["foreman"],
    scope: "foreman:channel:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_reply",
    description:
      "Reply to an operator channel message with preserved context and a retry-safe request ID",
    inputSchema: SendForemanMessageCommandSchema,
    principals: ["foreman"],
    scope: "foreman:channel:reply",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_bootstrap",
    description: "Read repository Foreman identity, policy ceilings, goals, and live team metadata",
    inputSchema: McpForemanBootstrapSchema,
    principals: ["foreman"],
    scope: "foreman:bootstrap",
    authority: "read",
  }),
  tool({
    name: "nanasa.list_members",
    description: "List active members visible in the caller's group",
    inputSchema: McpListMembersSchema,
    principals: ["agent", "operator"],
    scope: "members:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.list_agent_statuses",
    description: "List semantic status in the caller's group",
    inputSchema: McpListAgentStatusesSchema,
    principals: ["agent", "operator"],
    scope: "status:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.get_agent_status",
    description: "Read one visible agent status",
    inputSchema: McpGetAgentStatusSchema,
    principals: ["agent", "operator"],
    scope: "status:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.report_progress",
    description: "Report progress for the authenticated agent runtime",
    inputSchema: AgentProgressReportCommandSchema,
    principals: ["agent"],
    scope: "progress:write:self",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.send_dm",
    description: "Send a durable direct message",
    inputSchema: McpDirectMessageSchema,
    principals: ["agent", "operator"],
    scope: "messages:send",
    authority: "message",
  }),
  tool({
    name: "nanasa.send_multicast",
    description: "Send a durable multicast message",
    inputSchema: McpMulticastMessageSchema,
    principals: ["agent", "operator"],
    scope: "messages:send",
    authority: "message",
  }),
  tool({
    name: "nanasa.broadcast_group",
    description: "Broadcast a durable group message",
    inputSchema: McpMessageFieldsSchema,
    principals: ["agent", "operator"],
    scope: "messages:send",
    authority: "message",
  }),
  tool({
    name: "nanasa.prompt_peer",
    description: "Create a safe exact-target peer prompt action",
    inputSchema: McpPromptPeerSchema,
    principals: ["agent", "operator"],
    scope: "actions:prompt:peer",
    authority: "scoped-peer-action",
  }),
  tool({
    name: "nanasa.get_action_result",
    description: "Read a caller-owned action result",
    inputSchema: McpActionReferenceSchema,
    principals: ["agent", "operator"],
    scope: "actions:read:own",
    authority: "read",
  }),
  tool({
    name: "nanasa.wait_action",
    description: "Wait for a caller-owned exact action",
    inputSchema: McpWaitActionSchema,
    principals: ["agent", "operator"],
    scope: "actions:wait:own",
    authority: "read",
  }),
  tool({
    name: "nanasa.cancel_action",
    description: "Cancel a caller-owned pending action",
    inputSchema: McpActionReferenceSchema,
    principals: ["agent", "operator"],
    scope: "actions:cancel:own",
    authority: "scoped-peer-action",
  }),
  tool({
    name: "nanasa.get_delivery",
    description: "Read a visible per-recipient delivery outcome",
    inputSchema: McpDeliverySchema,
    principals: ["agent", "operator"],
    scope: "delivery:read:visible",
    authority: "read",
  }),
  tool({
    name: "nanasa.list_visible_history",
    description: "Read bounded message history visible to the caller",
    inputSchema: McpVisibleHistorySchema,
    principals: ["agent", "operator"],
    scope: "history:read:visible",
    authority: "read",
  }),
  tool({
    name: "nanasa.list_own_waits",
    description: "List only the authenticated runtime's open waits",
    inputSchema: McpOwnWaitsSchema,
    principals: ["agent"],
    scope: "waits:read:self",
    authority: "read",
  }),
] satisfies readonly McpToolDeclaration[]);

const tools = new Map(MCP_TOOL_REGISTRY.map((item) => [item.name, item]));

export function mcpTool(name: McpToolDeclaration["name"]): McpToolDeclaration {
  const declaration = tools.get(name);
  if (declaration === undefined) throw new Error(`Unknown MCP tool: ${name}`);
  return declaration;
}

export function assertMcpToolPrincipal(
  name: McpToolDeclaration["name"],
  principal: McpPrincipal,
): void {
  if (!mcpTool(name).principals.includes(principal.kind)) {
    throw new DomainError("mcp_tool_forbidden", "The tool is not available to this principal", 403);
  }
}
