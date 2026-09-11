import {
  AgentActionStateSchema,
  AgentProgressReportCommandSchema,
  CreateMissionTaskCommandSchema,
  ForemanChannelQuerySchema,
  InterveneMissionTaskCommandSchema,
  ObserveMissionTaskCommandSchema,
  ProvisionMissionTeamCommandSchema,
  ReplyMissionWaitCommandSchema,
  SendForemanMessageCommandSchema,
  VerifyMissionTaskCommandSchema,
} from "@nanasa/contracts";
import { z } from "zod";
import type { McpPrincipal } from "../mcp-auth.js";
import { DomainError } from "../store.js";

export const McpIdentifierSchema = z.string().trim().min(1).max(128);
export const McpForemanBootstrapSchema = z.object({}).strict();
export const McpMissionReferenceSchema = z
  .object({ missionId: McpIdentifierSchema, expectedGrantRevision: z.number().int().positive() })
  .strict();
export const McpMissionTaskSchema = CreateMissionTaskCommandSchema.extend({
  missionId: McpIdentifierSchema,
}).strict();
export const McpMissionProvisionSchema = ProvisionMissionTeamCommandSchema.extend({
  missionId: McpIdentifierSchema,
}).strict();
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
    name: "nanasa.foreman_reply_wait",
    description:
      "Answer one exact routine worker wait under an explicit grant and fresh observation; privileged approvals remain forbidden",
    inputSchema: ReplyMissionWaitCommandSchema,
    principals: ["foreman"],
    scope: "foreman:tasks:reply-wait",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_observe_task",
    description:
      "Read bounded untrusted terminal evidence from the exact mission-owned task runtime",
    inputSchema: ObserveMissionTaskCommandSchema,
    principals: ["foreman"],
    scope: "foreman:tasks:observe",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_prompt_idle",
    description:
      "Submit one budgeted idle prompt using a fresh exact task observation; never approve privileged waits",
    inputSchema: InterveneMissionTaskCommandSchema,
    principals: ["foreman"],
    scope: "foreman:tasks:intervene",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_verify_task",
    description:
      "Run immutable operator-approved verification recipes at an exact clean candidate commit",
    inputSchema: VerifyMissionTaskCommandSchema,
    principals: ["foreman"],
    scope: "foreman:tasks:verify",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_provision_team",
    description:
      "Create a new mission-owned team and managed worktree from an approved template and pinned commit",
    inputSchema: McpMissionProvisionSchema,
    principals: ["foreman"],
    scope: "foreman:teams:provision",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_finish_review",
    description: "Settle the exact current mission review without claiming mission completion",
    inputSchema: McpMissionReferenceSchema,
    principals: ["foreman"],
    scope: "foreman:reviews:finish",
    authority: "self-write",
  }),
  tool({
    name: "nanasa.foreman_list_missions",
    description: "List missions owned by this repository Foreman",
    inputSchema: McpForemanBootstrapSchema,
    principals: ["foreman"],
    scope: "foreman:missions:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_get_mission",
    description: "Read current mission acceptance, grant, and tasks",
    inputSchema: McpMissionReferenceSchema,
    principals: ["foreman"],
    scope: "foreman:missions:read",
    authority: "read",
  }),
  tool({
    name: "nanasa.foreman_create_task",
    description: "Plan a bounded task under an existing operator-issued mission grant",
    inputSchema: McpMissionTaskSchema,
    principals: ["foreman"],
    scope: "foreman:tasks:plan",
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
    description:
      "Read repository Foreman identity, policy ceilings, approved templates, and team metadata",
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
