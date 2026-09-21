import {
  AgentActionStateSchema,
  AgentProgressReportCommandSchema,
  AskForemanMemberCommandSchema,
  AssignForemanOutcomeCommandSchema,
  DelegateForemanGoalCommandSchema,
  ForemanChannelQuerySchema,
  ForemanCheckInCommandSchema,
  ForemanConversationQuerySchema,
  ProposeForemanGoalCommandSchema,
  ReplyForemanConversationCommandSchema,
  ReportDelegationCommandSchema,
  RequestForemanCleanupCommandSchema,
  RequestHumanDecisionCommandSchema,
  SendForemanMessageCommandSchema,
} from "@nanasa/contracts";
import { z } from "zod";
import { BrowserCandidateVerificationSchema } from "../browser-candidate-verifier.js";
import type { McpPrincipal } from "../mcp-auth.js";
import { DomainError } from "../store.js";

export const McpIdentifierSchema = z.string().trim().min(1).max(128);
export const McpForemanBootstrapSchema = z.object({}).strict();
export const McpForemanContextSchema = z
  .object({
    teamOffset: z.number().int().nonnegative().optional(),
    goalOffset: z.number().int().nonnegative().optional(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const McpForemanDiscoverySchema = z
  .object({
    offset: z.number().int().nonnegative().optional(),
    groupId: McpIdentifierSchema.optional(),
    memberOffset: z.number().int().nonnegative().optional(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const McpConversationReferenceSchema = z.object({ id: McpIdentifierSchema }).strict();
export const McpCleanupRequestQuerySchema = z
  .object({ id: McpIdentifierSchema.optional() })
  .strict();
export const McpGoalReferenceSchema = z.object({ goalId: McpIdentifierSchema }).strict();
export const McpProposeGoalSchema = ProposeForemanGoalCommandSchema.extend({
  sourceMessageId: ProposeForemanGoalCommandSchema.shape.sourceMessageId
    .nullable()
    .describe(
      "Original stored Human (operator) message ID from foreman_read_channel, usually fm_*. Never an agent/Foreman message or a thread ID. Optional for native TUI requests with no channel message; omit or null means absent, not permission to discard invalid linkage.",
    ),
  sourceConversationIds: ProposeForemanGoalCommandSchema.shape.sourceConversationIds
    .nullable()
    .describe(
      "Optional supporting member-question request IDs returned by foreman_ask_member or foreman_read_conversations, owned by this Foreman. These are not channel message IDs or channel conversation/thread IDs and grant no authority. Omit, null or [] when no member-question context is intended.",
    ),
});
export const McpReportDelegationSchema = z
  .object({
    ...ReportDelegationCommandSchema.shape,
    reviewOutcome: ReportDelegationCommandSchema.shape.reviewOutcome
      .nullable()
      .describe(
        "For kind review, required explicit approved or changes-required verdict for the exact candidate. For other report kinds, omit or null.",
      ),
    candidateHead: ReportDelegationCommandSchema.shape.candidateHead.nullable(),
    candidatePath: ReportDelegationCommandSchema.shape.candidatePath.nullable(),
  })
  .strict();
export const McpAcceptGoalSchema = McpGoalReferenceSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
});
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
    expectedRunId: McpIdentifierSchema.nullish(),
    expectedGeneration: z.number().int().positive().nullish(),
    expectedStatusRevision: z.number().int().nonnegative().nullish(),
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
    before: z.number().int().positive().nullish(),
    after: z.number().int().positive().nullish(),
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
    name: "nanasa.foreman_request_cleanup",
    description:
      "Request scoped visibility cleanup without a delivery goal. Captures exact goal IDs/revisions or channel cutoff/conversation IDs for operator approval in the portal. This request grants no consent and changes no visibility; confirmation is not accepted. Data and pending effects are retained; no permanent purge.",
    inputSchema: RequestForemanCleanupCommandSchema,
    principals: ["foreman"],
    scope: "foreman:cleanup:request",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_read_cleanup_requests",
    description:
      "Read pending cleanup requests for this Foreman, or a durable approval receipt by exact id. Only an authenticated operator can approve the unchanged stored scope; request text and Human chat replies are not authorization.",
    inputSchema: McpCleanupRequestQuerySchema,
    principals: ["foreman"],
    scope: "foreman:cleanup:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_assign_outcome",
    description:
      "Assign an outcome to a real team owner using a stable requestId. Durably prepares an isolated workspace, waits for readiness, starts eligible members and delegates with fresh server-side revisions. workspace auto reuses a suitable owned linked checkout or creates one; existing requires a clean linked checkout; new creates a request-owned worktree. Human stops and dirty sources are held, not bypassed. Read preparation progress with foreman_get_goal.",
    inputSchema: AssignForemanOutcomeCommandSchema,
    principals: ["foreman"],
    scope: "foreman:goals:assign",
    authority: "scoped-peer-action",
  }),
  tool({
    name: "nanasa.foreman_prepare_workspace",
    description:
      "Prepare and bind an isolated team workspace using the same durable, policy-checked preparation owner as assign_outcome, without starting members or handing off work. Requires goalId, groupId, memberId, brief and stable requestId. Prefer assign_outcome for an execution request.",
    inputSchema: AssignForemanOutcomeCommandSchema,
    principals: ["foreman"],
    scope: "foreman:goals:prepare",
    authority: "scoped-peer-action",
  }),
  tool({
    name: "nanasa.foreman_accept_goal",
    description:
      "Accept an independently reviewed ready goal only under an operator-enabled autonomous coordination grant; rechecks candidate evidence and settled team state, and never overrides Human pause",
    inputSchema: McpAcceptGoalSchema,
    principals: ["foreman"],
    scope: "foreman:goals:accept",
    authority: "self-write",
  }),
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
      "Discover whether the repository Foreman is configured, enabled and running, and read only conversation requests addressed to your authenticated member and runtime; empty requests do not mean Foreman is absent",
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
      "Read bounded teams and member pages with role descriptions, team eligibility blockers and reservations. Continue with offset/revision or groupId/memberOffset. Goal authorization is not evaluated; discovery grants no authority",
    inputSchema: McpForemanDiscoverySchema,
    principals: ["foreman"],
    scope: "foreman:teams:discover",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_propose_goal",
    description:
      "Propose a high-level Human outcome without requiring an implementation plan. For channel requests, read the original message and set sourceMessageId to its stored Human message ID. sourceConversationIds contains only supporting member-question request IDs from foreman_ask_member/read_conversations, never channel message or thread IDs. Native TUI requests need no channel IDs; omit absent linkage (null is accepted as absent). Linkage is context, not authority. Starts within policy ceilings under autonomous approval; otherwise awaits Human approval. Inspect returned state and grant. On an explicit effect=none, retry=correct-input rejection, correct the indicated linkage and resubmit with the same requestId; never drop a real Human source to bypass verification. For unconfirmed effects or request conflicts inspect state first.",
    inputSchema: McpProposeGoalSchema,
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
      "Delegate an outcome to a real team and accountable member. Requires per-delegation Human approval or an existing autonomous goal grant under current policy; always rechecks readiness, checkout isolation and budgets",
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
    name: "nanasa.verify_browser_candidate",
    description:
      "Observe an exact static browser candidate without shell access or candidate writes. Agent-only: requires your team's current accepted, working or blocked approved delegation. candidatePath is checkout-root-relative, never cwd-relative; entry defaults to index.html. Defaults to fresh desktop 1440x900, fresh mobile 390x844 and desktop-to-mobile resize. Up to 10 exact click/select/fill/slider CSS actions; no code, commands, arbitrary URLs or file uploads. Returns bounded snapshots, controls, screenshots, rendered pixel samples, overflow and page/network errors with unchanged before/after candidate digests. External assets are blocked. Evidence is observation only, not review approval. Missing installed headless Chromium or host dependencies returns unavailable; this tool never installs anything.",
    inputSchema: BrowserCandidateVerificationSchema,
    principals: ["agent"],
    scope: "team:delegations:verify-browser",
    authority: "read",
  }),
  tool({
    name: "nanasa.report_delegation",
    description:
      "Report acceptance, plan, progress, blockers, review or readiness. kind:review requires reviewOutcome:approved or changes-required and evidence for the exact candidate; missing verdict has no effect, so correct and resubmit the same requestId. Notify the accountable member with a normal scoped peer reply after reporting. Latest independent approval of that candidate is required for ready. For progress omit both candidate fields or set both null. For uncommitted review/ready set candidatePath and candidateHead:null; for a clean commit set candidateHead and candidatePath:null. Never invent hashes or broaden scope to record findings. Only the accountable member can accept or finish",
    inputSchema: McpReportDelegationSchema,
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
      "Read bounded operator instructions and Foreman replies. For queued Human work pass its exact messageId, which retains access even after visibility cleanup; default reads hide cleared history",
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
    description:
      "Read bounded repository Foreman identity, effective policy, team and goal summaries before planning or delegation. Continue with teamOffset/goalOffset and revision; use foreman_discover_teams for member pages and foreman_get_goal for full constraints",
    inputSchema: McpForemanContextSchema,
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
    description:
      "Create a safe exact-target peer prompt action. Optional expectedRunId, expectedGeneration and expectedStatusRevision may be null to bind the current target server-side; never guess revisions. Dispatch still rechecks exact runtime and reporter readiness",
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
    description:
      "Read bounded message history visible to the caller. Use before or after, never both. Set both null for the latest page; null means no cursor",
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
