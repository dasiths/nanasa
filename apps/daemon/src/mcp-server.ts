import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { type AuthInfo, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  AgentProgressReportCommandSchema,
  CreateAgentActionCommandSchema,
  MAX_MESSAGE_REQUEST_BYTES,
  type MessageSubmissionResult,
  SubmitMessageCommandSchema,
  WaitForAgentActionCommandSchema,
} from "@nanasa/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanasaMcpServerInstructions } from "./coordination-instructions.js";
import type { AgentActionService } from "./actions/agent-action-service.js";
import type { AgentOpenWaitService } from "./actions/agent-open-wait-service.js";
import type { AgentWaitService } from "./actions/agent-wait-service.js";
import { McpCredentialIssuer, type McpPrincipal } from "./mcp-auth.js";
import { MessageCommandService } from "./message-command-service.js";
import { MessageRepository } from "./message-repository.js";
import { DeliveryRepository } from "./delivery-repository.js";
import { DomainError, NanasaStore } from "./store.js";
import {
  MCP_TOOL_REGISTRY,
  McpActionReferenceSchema as ActionReferenceSchema,
  McpDeliverySchema,
  McpDirectMessageSchema as DirectMessageSchema,
  McpGetAgentStatusSchema as GetAgentStatusSchema,
  McpListAgentStatusesSchema as ListAgentStatusesSchema,
  McpListMembersSchema as ListMembersSchema,
  McpMessageFieldsSchema as MessageFieldsSchema,
  McpMulticastMessageSchema as MulticastMessageSchema,
  McpOwnWaitsSchema,
  McpPromptPeerSchema as PromptPeerSchema,
  McpVisibleHistorySchema,
  McpWaitActionSchema as WaitActionSchema,
  assertMcpToolPrincipal,
  mcpTool,
} from "./mcp/tool-registry.js";

export interface McpRouteOptions {
  path: string;
  endpointUrl: string;
  allowedHostnames: string[];
  credentials: McpCredentialIssuer;
  store: NanasaStore;
  messages: MessageCommandService;
  messageHistory: MessageRepository;
  deliveries: DeliveryRepository;
  actions: AgentActionService;
  actionWaits: AgentWaitService;
  openWaits: AgentOpenWaitService;
}

class McpRateLimiter {
  readonly #calls = new Map<string, number[]>();

  public check(principal: McpPrincipal): void {
    const now = Date.now();
    const key =
      principal.kind === "agent"
        ? `agent:${principal.runId}:${principal.generation}`
        : `operator:${principal.operatorId}`;
    const recent = (this.#calls.get(key) ?? []).filter((timestamp) => now - timestamp < 60_000);
    if (recent.length >= 30) {
      throw new DomainError("mcp_rate_limited", "MCP request rate limit exceeded", 429);
    }
    recent.push(now);
    this.#calls.set(key, recent);
  }
}

function targetGroup(principal: McpPrincipal, requestedGroupId: string | undefined): string {
  if (principal.kind === "agent") {
    if (requestedGroupId !== undefined && requestedGroupId !== principal.groupId) {
      throw new DomainError(
        "mcp_group_forbidden",
        "Agent credentials cannot select another group",
        403,
      );
    }
    return principal.groupId;
  }
  if (requestedGroupId === undefined) {
    throw new DomainError("mcp_group_required", "Remote operators must provide groupId", 400);
  }
  return requestedGroupId;
}

function toolResult(operation: () => MessageSubmissionResult) {
  try {
    const result = operation();
    return {
      content: [
        {
          type: "text" as const,
          text: `Submitted ${result.message.id} to ${result.deliveryOutcomes.length} terminal recipient(s).`,
        },
      ],
      structuredContent: result,
    };
  } catch (error) {
    const message =
      error instanceof DomainError || error instanceof z.ZodError
        ? error.message
        : "Message submission failed";
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

function commandBase(principal: McpPrincipal, input: z.infer<typeof MessageFieldsSchema>) {
  return {
    conversationId: input.conversationId,
    intent: input.intent,
    sender:
      principal.kind === "agent"
        ? { kind: "agent" as const, memberId: principal.memberId, runId: principal.runId }
        : { kind: "operator" as const, operatorId: principal.operatorId },
    body: { contentType: input.contentType, text: input.text },
    delivery: {},
    replyTo: input.replyTo,
  };
}

function actionPrincipal(principal: McpPrincipal) {
  return principal.kind === "agent"
    ? {
        kind: "agent" as const,
        groupId: principal.groupId,
        memberId: principal.memberId,
        runId: principal.runId,
        generation: principal.generation,
      }
    : { kind: "operator" as const, operatorId: principal.operatorId };
}

function actionToolResult(operation: () => unknown) {
  try {
    const result = operation();
    return {
      content: [{ type: "text" as const, text: "Durable action state returned." }],
      structuredContent: { result },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "Agent action failed",
        },
      ],
      isError: true,
    };
  }
}

function messageVisibleTo(
  principal: McpPrincipal,
  message: ReturnType<NanasaStore["getMessage"]>,
): boolean {
  if (principal.kind === "operator") return true;
  if (message.groupId !== principal.groupId) return false;
  if (message.sender.kind === "agent" && message.sender.memberId === principal.memberId)
    return true;
  if (message.audience.kind === "group") return true;
  if (message.audience.kind === "dm") return message.audience.memberId === principal.memberId;
  return message.audience.memberIds.includes(principal.memberId);
}

function visibleDeliveries(
  principal: McpPrincipal,
  options: McpRouteOptions,
  messageId: string,
  recipientMemberId?: string,
) {
  const message = options.store.getMessage(messageId);
  if (!messageVisibleTo(principal, message)) {
    throw new DomainError(
      "mcp_message_forbidden",
      "The message is not visible to this principal",
      403,
    );
  }
  const ownsSubmission =
    principal.kind === "operator" ||
    (message.sender.kind === "agent" && message.sender.memberId === principal.memberId);
  return options.deliveries
    .list(messageId)
    .filter(
      (delivery) =>
        recipientMemberId === undefined || delivery.recipientMemberId === recipientMemberId,
    )
    .filter(
      (delivery) =>
        ownsSubmission ||
        (principal.kind === "agent" && delivery.recipientMemberId === principal.memberId),
    );
}

function listMembersResult(
  principal: McpPrincipal,
  options: McpRouteOptions,
  input: z.infer<typeof ListMembersSchema>,
) {
  const groupId = targetGroup(principal, input.groupId);
  const snapshot = options.store.getSnapshot();
  const members = snapshot.memberships
    .filter((membership) => membership.groupId === groupId && membership.state === "active")
    .sort((left, right) => left.memberId.localeCompare(right.memberId))
    .map((membership) => {
      const integrationId = snapshot.config?.groups[groupId]?.agents[membership.id]?.integrationId;
      const profile = snapshot.agentProfiles.find(
        (candidate) => candidate.id === membership.agentProfileId,
      );
      const run = snapshot.runs
        .filter(
          (candidate) =>
            candidate.groupId === groupId && candidate.memberId === membership.memberId,
        )
        .sort((left, right) => right.generation - left.generation)[0];
      return {
        memberId: membership.memberId,
        alias: membership.alias,
        agentType: integrationId ?? profile?.agentType ?? "unknown",
        roleId: membership.roleId,
        roleName:
          membership.roleId === undefined
            ? undefined
            : snapshot.config?.roles[membership.roleId]?.name,
        runStatus:
          run !== undefined && ["starting", "running", "stopping"].includes(run.status)
            ? run.status
            : "offline",
        isCaller: principal.kind === "agent" && principal.memberId === membership.memberId,
      };
    });
  return {
    content: [
      {
        type: "text" as const,
        text: members
          .map(
            (member) =>
              `${member.alias} (${member.memberId}) · ${member.roleName ?? member.roleId ?? "unassigned"} · ${member.agentType} · ${member.runStatus}${member.isCaller ? " · you" : ""}`,
          )
          .join("\n"),
      },
    ],
    structuredContent: { groupId, members },
  };
}

function listAgentStatusesResult(
  principal: McpPrincipal,
  options: McpRouteOptions,
  input: z.infer<typeof ListAgentStatusesSchema>,
) {
  const groupId = targetGroup(principal, input.groupId);
  const statuses = options.store
    .listAgentStatuses(groupId)
    .filter((status) => !input.attentionOnly || status.attention !== "none");
  return {
    content: [
      {
        type: "text" as const,
        text:
          statuses.length === 0
            ? "No matching agent statuses."
            : statuses
                .map(
                  (status) =>
                    `${status.alias} (${status.memberId}) · ${status.state}/${status.phase} · ${status.attention}`,
                )
                .join("\n"),
      },
    ],
    structuredContent: { groupId, statuses },
  };
}

function getAgentStatusResult(
  principal: McpPrincipal,
  options: McpRouteOptions,
  input: z.infer<typeof GetAgentStatusSchema>,
) {
  const groupId = targetGroup(principal, input.groupId);
  const status = options.store.getAgentStatus(groupId, input.memberId);
  return {
    content: [
      {
        type: "text" as const,
        text: `${status.alias} is ${status.state}/${status.phase} with ${status.attention} attention.${status.lastProgressSummary === undefined ? "" : ` Last progress: ${status.lastProgressSummary}`}`,
      },
    ],
    structuredContent: { groupId, status },
  };
}

function createMcpServer(principal: McpPrincipal, options: McpRouteOptions): McpServer {
  const server = new McpServer(
    { name: "nanasa", version: "0.0.0" },
    { instructions: nanasaMcpServerInstructions() },
  );
  server.registerTool(
    "nanasa.list_members",
    {
      description:
        "List active members in the caller's group with recipient IDs, aliases, agent types, and run status",
      inputSchema: ListMembersSchema,
    },
    async (input) => listMembersResult(principal, options, input),
  );
  server.registerTool(
    "nanasa.list_agent_statuses",
    {
      description:
        "List current semantic and process status for active group agents, optionally limited to agents needing attention",
      inputSchema: ListAgentStatusesSchema,
    },
    async (input) => listAgentStatusesResult(principal, options, input),
  );
  server.registerTool(
    "nanasa.get_agent_status",
    {
      description:
        "Inspect one active group agent's status, current wait, progress, evidence, and recent transitions",
      inputSchema: GetAgentStatusSchema,
    },
    async (input) => {
      try {
        return getAgentStatusResult(principal, options, input);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : "Agent status lookup failed",
            },
          ],
          isError: true,
        };
      }
    },
  );
  if (principal.kind === "agent") {
    server.registerTool(
      "nanasa.report_progress",
      {
        description:
          "Report the caller's current task stage, progress summary, next step, blocker, or final outcome",
        inputSchema: AgentProgressReportCommandSchema,
      },
      async (input) => {
        try {
          const status = options.store.reportAgentProgress(principal, input);
          return {
            content: [
              {
                type: "text" as const,
                text: `Progress recorded for ${status.alias} at ${status.progressStage}.`,
              },
            ],
            structuredContent: { status },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : "Progress report failed",
              },
            ],
            isError: true,
          };
        }
      },
    );
  }
  server.registerTool(
    "nanasa.send_dm",
    {
      description: "Send a direct message to one active group member",
      inputSchema: DirectMessageSchema,
    },
    async (input) =>
      toolResult(() =>
        options.messages.submit(
          targetGroup(principal, input.groupId),
          SubmitMessageCommandSchema.parse({
            ...commandBase(principal, input),
            audience: { kind: "dm", memberId: input.recipientMemberId },
          }),
        ),
      ),
  );
  server.registerTool(
    "nanasa.send_multicast",
    {
      description: "Send one message to two or more active group members",
      inputSchema: MulticastMessageSchema,
    },
    async (input) =>
      toolResult(() =>
        options.messages.submit(
          targetGroup(principal, input.groupId),
          SubmitMessageCommandSchema.parse({
            ...commandBase(principal, input),
            audience: { kind: "multicast", memberIds: input.recipientMemberIds },
          }),
        ),
      ),
  );
  server.registerTool(
    "nanasa.broadcast_group",
    {
      description: "Broadcast to active group members, excluding the authenticated agent sender",
      inputSchema: MessageFieldsSchema,
    },
    async (input) =>
      toolResult(() => {
        const groupId = targetGroup(principal, input.groupId);
        return options.messages.submit(
          groupId,
          SubmitMessageCommandSchema.parse({
            ...commandBase(principal, input),
            audience: {
              kind: "group",
              membershipRevision: options.store.getGroup(groupId).membershipRevision,
            },
          }),
        );
      }),
  );
  server.registerTool(
    "nanasa.prompt_peer",
    {
      description:
        "Create a durable prompt action for one exact current peer; dispatch waits for safe readiness",
      inputSchema: PromptPeerSchema,
    },
    async (input) =>
      actionToolResult(() =>
        options.actions.create(
          actionPrincipal(principal),
          CreateAgentActionCommandSchema.parse({
            kind: "prompt",
            groupId: targetGroup(principal, input.groupId),
            memberId: input.memberId,
            prompt: input.prompt,
            allowWorking: false,
            expectedRunId: input.expectedRunId,
            expectedGeneration: input.expectedGeneration,
            expectedStatusRevision: input.expectedStatusRevision,
          }),
          input.idempotencyKey,
        ),
      ),
  );
  server.registerTool(
    "nanasa.get_action_result",
    {
      description:
        "Read the exact durable state and correlated result for an action created by the caller",
      inputSchema: ActionReferenceSchema,
    },
    async (input) =>
      actionToolResult(() => options.actions.get(actionPrincipal(principal), input.actionId)),
  );
  server.registerTool(
    "nanasa.wait_action",
    {
      description: "Wait for one exact durable action to enter any requested lifecycle state",
      inputSchema: WaitActionSchema,
    },
    async (input) => {
      try {
        const result = await options.actionWaits.wait(
          actionPrincipal(principal),
          input.actionId,
          WaitForAgentActionCommandSchema.parse({
            states: input.states,
            timeoutMs: input.timeoutMs,
          }),
        );
        return {
          content: [{ type: "text" as const, text: `Action is ${result.action.state}.` }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : "Action wait failed",
            },
          ],
          isError: true,
        };
      }
    },
  );
  server.registerTool(
    "nanasa.cancel_action",
    {
      description: "Cancel the caller's own action before provider submission",
      inputSchema: ActionReferenceSchema,
    },
    async (input) =>
      actionToolResult(() => options.actions.cancel(actionPrincipal(principal), input.actionId)),
  );
  server.registerTool(
    "nanasa.get_delivery",
    {
      description: mcpTool("nanasa.get_delivery").description,
      inputSchema: McpDeliverySchema,
    },
    async (input) =>
      actionToolResult(() => {
        assertMcpToolPrincipal("nanasa.get_delivery", principal);
        return visibleDeliveries(principal, options, input.messageId, input.recipientMemberId);
      }),
  );
  server.registerTool(
    "nanasa.list_visible_history",
    {
      description: mcpTool("nanasa.list_visible_history").description,
      inputSchema: McpVisibleHistorySchema,
    },
    async (input) =>
      actionToolResult(() => {
        assertMcpToolPrincipal("nanasa.list_visible_history", principal);
        const groupId = targetGroup(principal, input.groupId);
        const page = options.messageHistory.page(groupId, {
          limit: input.limit,
          ...(input.before === undefined ? {} : { before: input.before }),
          ...(input.after === undefined ? {} : { after: input.after }),
        });
        const messages = page.messages.filter((message) => messageVisibleTo(principal, message));
        const visibleIds = new Set(messages.map((message) => message.id));
        const deliveryOutcomes = page.deliveryOutcomes.filter(
          (delivery) =>
            visibleIds.has(delivery.messageId) &&
            (principal.kind === "operator" || delivery.recipientMemberId === principal.memberId),
        );
        return { ...page, messages, deliveryOutcomes };
      }),
  );
  if (principal.kind === "agent") {
    server.registerTool(
      "nanasa.list_own_waits",
      {
        description: "List only the authenticated agent runtime's exact open provider waits",
        inputSchema: McpOwnWaitsSchema,
      },
      async (input) =>
        actionToolResult(() =>
          options.openWaits.list(
            actionPrincipal(principal),
            targetGroup(principal, input.groupId),
            principal.memberId,
          ),
        ),
    );
  }
  return server;
}

export function registerMcpRoutes(app: FastifyInstance, options: McpRouteOptions): void {
  const validateHost = hostHeaderValidation(options.allowedHostnames);
  const validateOrigin = originValidation(options.allowedHostnames);
  const rateLimiter = new McpRateLimiter();
  const handler = createMcpHandler(
    (context) => {
      if (context.authInfo === undefined) {
        throw new DomainError("mcp_unauthorized", "A bearer credential is required", 401);
      }
      const principal = options.credentials.authenticate(`Bearer ${context.authInfo.token}`);
      return createMcpServer(principal, options);
    },
    { responseMode: "json", legacy: "stateless" },
  );
  const nodeHandler = toNodeHandler(handler);

  app.post(options.path, { bodyLimit: MAX_MESSAGE_REQUEST_BYTES }, async (request, reply) => {
    if (!validateHost(request.raw, reply.raw) || !validateOrigin(request.raw, reply.raw)) {
      reply.hijack();
      return;
    }
    const principal = options.credentials.authenticate(request.headers.authorization);
    rateLimiter.check(principal);
    const token = request.headers.authorization!.slice("Bearer ".length);
    (request.raw as typeof request.raw & { auth?: AuthInfo }).auth = {
      token,
      clientId: "nanasa-bearer-client",
      scopes: MCP_TOOL_REGISTRY.filter((tool) => tool.principals.includes(principal.kind)).map(
        (tool) => tool.scope,
      ),
    };
    reply.hijack();
    await nodeHandler(request.raw as Parameters<typeof nodeHandler>[0], reply.raw, request.body);
  });
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: options.path,
      handler: async (_request, reply) =>
        reply.status(405).send({
          jsonrpc: "2.0",
          error: { code: -32_000, message: "Method not allowed for stateless MCP" },
          id: null,
        }),
    });
  }
  app.addHook("preClose", async () => {
    await handler.close();
  });
}
