import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import { CreateUrlOpenRequestSchema } from "@nanasa/contracts";
import type { FastifyInstance } from "fastify";
import type { McpCredentialIssuer } from "./mcp-auth.js";
import { DomainError } from "./store.js";
import type { UrlOpenService } from "./url-open-service.js";

export function registerUrlOpenRoutes(
  app: FastifyInstance,
  options: {
    allowedHostnames: string[];
    credentials: McpCredentialIssuer;
    service: UrlOpenService;
  },
): void {
  const validateHost = hostHeaderValidation(options.allowedHostnames);
  const validateOrigin = originValidation(options.allowedHostnames);
  app.post("/api/v1/agent-url-requests", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!validateHost(request.raw, reply.raw) || !validateOrigin(request.raw, reply.raw)) {
      reply.hijack();
      return;
    }
    const principal = options.credentials.authenticate(request.headers.authorization);
    if (principal.kind !== "agent") {
      throw new DomainError(
        "url_request_agent_required",
        "Only active agent runs may request a browser",
        403,
      );
    }
    const body = CreateUrlOpenRequestSchema.safeParse(request.body);
    if (!body.success)
      throw new DomainError("invalid_browser_url", "Invalid browser URL request", 400);
    const result = options.service.create(principal, body.data.url);
    return reply.status(202).send({ requestId: result.id });
  });
}
