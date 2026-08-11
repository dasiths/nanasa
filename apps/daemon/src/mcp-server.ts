import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { type AuthInfo, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  AgentProgressReportCommandSchema,
  type MessageSubmissionResult,
  SubmitMessageCommandSchema,
} from "@nanasa/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { McpCredentialIssuer, type McpPrincipal } from "./mcp-auth.js";
import { MessageCommandService } from "./message-command-service.js";
import { DomainError, NanasaStore } from "./store.js";

const IdentifierSchema = z.string().trim().min(1).max(128);
const MessageFieldsSchema = z
  .object({
    groupId: IdentifierSchema.optional(),
    text: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 1_048_576, "Message is too large"),
    intent: z.enum(["inform", "request", "response"]).default("request"),
    contentType: z.enum(["text/plain", "text/markdown"]).default("text/markdown"),
    conversationId: IdentifierSchema.optional(),
    replyTo: IdentifierSchema.optional(),
  })
  .strict();
const DirectMessageSchema = MessageFieldsSchema.extend({ recipientMemberId: IdentifierSchema });
const MulticastMessageSchema = MessageFieldsSchema.extend({
  recipientMemberIds: z
    .array(IdentifierSchema)
    .min(2)
    .refine((ids) => new Set(ids).size === ids.length),
});
const ListMembersSchema = z.object({ groupId: IdentifierSchema.optional() }).strict();
const ListAgentStatusesSchema = z
  .object({
    groupId: IdentifierSchema.optional(),
    attentionOnly: z.boolean().default(false),
  })
  .strict();
const GetAgentStatusSchema = z
  .object({ groupId: IdentifierSchema.optional(), memberId: IdentifierSchema })
  .strict();

export interface McpRouteOptions {
  path: string;
  endpointUrl: string;
  allowedHostnames: string[];
  credentials: McpCredentialIssuer;
  store: NanasaStore;
  messages: MessageCommandService;
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
    delivery: { mode: "terminal" as const },
    replyTo: input.replyTo,
    hop: 0,
  };
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
        agentType: profile?.agentType ?? "unknown",
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
              `${member.alias} (${member.memberId}) · ${member.agentType} · ${member.runStatus}${member.isCaller ? " · you" : ""}`,
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
  const server = new McpServer({ name: "nanasa", version: "0.0.0" });
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
  server.registerTool(
    "nanasa.report_progress",
    {
      description:
        "Report the caller's current task stage, progress summary, next step, blocker, or final outcome",
      inputSchema: AgentProgressReportCommandSchema,
    },
    async (input) => {
      if (principal.kind !== "agent") {
        return {
          content: [{ type: "text" as const, text: "Only agents can report progress." }],
          isError: true,
        };
      }
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

  app.post(options.path, async (request, reply) => {
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
      scopes: ["messages:submit"],
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
