import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { type AuthInfo, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type MessageSubmissionResult, SubmitMessageCommandSchema } from "@nanasa/contracts";
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

function createMcpServer(principal: McpPrincipal, options: McpRouteOptions): McpServer {
  const server = new McpServer({ name: "nanasa", version: "0.0.0" });
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
