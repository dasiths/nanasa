import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import { AgentStatusEventInputSchema } from "@nanasa/contracts";
import type { FastifyInstance } from "fastify";

import { McpCredentialIssuer } from "./mcp-auth.js";
import { DomainError, NanasaStore } from "./store.js";

export interface AgentStatusRouteOptions {
  path: string;
  allowedHostnames: string[];
  credentials: McpCredentialIssuer;
  store: NanasaStore;
}

class AgentStatusRateLimiter {
  readonly #calls = new Map<string, number[]>();

  public check(runId: string): void {
    const now = Date.now();
    const recent = (this.#calls.get(runId) ?? []).filter((timestamp) => now - timestamp < 60_000);
    if (recent.length >= 600) {
      throw new DomainError("status_rate_limited", "Agent status event rate limit exceeded", 429);
    }
    recent.push(now);
    this.#calls.set(runId, recent);
  }
}

export function registerAgentStatusRoutes(
  app: FastifyInstance,
  options: AgentStatusRouteOptions,
): void {
  const validateHost = hostHeaderValidation(options.allowedHostnames);
  const validateOrigin = originValidation(options.allowedHostnames);
  const limiter = new AgentStatusRateLimiter();

  app.post(options.path, { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!validateHost(request.raw, reply.raw) || !validateOrigin(request.raw, reply.raw)) {
      reply.hijack();
      return;
    }
    const principal = options.credentials.authenticate(request.headers.authorization);
    if (principal.kind !== "agent") {
      throw new DomainError(
        "status_agent_required",
        "Only active agent runs may submit status events",
        403,
      );
    }
    limiter.check(principal.runId);
    const result = options.store.ingestAgentStatusEvent(
      principal,
      AgentStatusEventInputSchema.parse(request.body),
    );
    return reply.status(202).send(result);
  });
}
