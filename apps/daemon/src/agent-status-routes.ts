import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import { AgentStatusEventInputSchema, type AgentProfile } from "@nanasa/contracts";
import type { FastifyInstance } from "fastify";

import { AgentStatusService } from "./agent-status-service.js";
import { McpCredentialIssuer } from "./mcp-auth.js";
import { NativeSessionService } from "./native-session-service.js";
import { ProviderAdapterRegistry } from "./providers/provider-adapter-registry.js";
import { DomainError, NanasaStore } from "./store.js";

export interface AgentStatusRouteOptions {
  path: string;
  allowedHostnames: string[];
  credentials: McpCredentialIssuer;
  store: NanasaStore;
  statusService: AgentStatusService;
  nativeSessions?: NativeSessionService;
  adapters?: ProviderAdapterRegistry;
  providerStateRoot?: (profile: AgentProfile) => string;
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
    const event = AgentStatusEventInputSchema.parse(request.body);
    const result = options.statusService.ingestReporter(principal, event);
    if (
      options.nativeSessions !== undefined &&
      options.adapters !== undefined &&
      options.providerStateRoot !== undefined
    ) {
      const run = options.store.getRun(principal.runId);
      const profile = options.store.getAgentProfile(run.agentProfileId);
      options.nativeSessions.observe({
        memberId: run.memberId,
        integrationId: profile.agentType,
        runId: run.id,
        generation: run.generation,
        adapter: options.adapters.get(profile.kind),
        stateRoot: options.providerStateRoot(profile),
        event,
      });
      if (event.data.effectiveModel !== undefined) {
        options.store.updateRunProviderMetadata(run.id, {
          effectiveModel: event.data.effectiveModel,
        });
      }
    }
    return reply.status(202).send(result);
  });
}
