import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import { AgentStatusEventInputSchema } from "@nanasa/contracts";
import type { FastifyInstance } from "fastify";

import type { AgentActionAckService } from "./actions/agent-action-ack-service.js";
import type { AgentRuntimeProvisioner } from "./agent-runtime-provisioner.js";
import { AgentStatusService } from "./agent-status-service.js";
import { McpCredentialIssuer } from "./mcp-auth.js";
import { NativeSessionService } from "./native-session-service.js";
import { DomainError, NanasaStore } from "./store.js";

export interface AgentStatusRouteOptions {
  path: string;
  allowedHostnames: string[];
  credentials: McpCredentialIssuer;
  store: NanasaStore;
  statusService: AgentStatusService;
  nativeSessions?: NativeSessionService;
  runtimeProvisioner?: AgentRuntimeProvisioner;
  actionAcks?: AgentActionAckService;
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
    if (options.nativeSessions !== undefined && options.runtimeProvisioner !== undefined) {
      const run = options.store.getRun(principal.runId);
      if (event.event === "session.ready") {
        const reported =
          event.data.nativeSession ??
          (event.nativeSessionId === undefined
            ? undefined
            : { kind: "id" as const, value: event.nativeSessionId });
        if (reported !== undefined) {
          const profile = options.store.getAgentProfile(run.agentProfileId);
          const reporter = await options.runtimeProvisioner.reporterPolicy(run);
          if (
            event.source !== reporter.source ||
            event.reporterVersion !== reporter.reporterVersion
          ) {
            throw new Error("Native session report does not match the bound provider reporter");
          }
          const reference = await options.runtimeProvisioner.normalizeNativeSession(
            run,
            {
              source: event.source,
              referenceKind: reported.kind,
              referenceValue: reported.value,
            },
            await options.runtimeProvisioner.providerStateRoot(run),
          );
          options.nativeSessions.observe({
            memberId: run.memberId,
            integrationId: profile.agentType,
            runId: run.id,
            generation: run.generation,
            reference,
            event,
          });
        }
      }
      if (event.data.effectiveModel !== undefined) {
        options.store.updateRunProviderMetadata(run.id, {
          effectiveModel: event.data.effectiveModel,
        });
      }
    }
    return reply.status(202).send(result);
  });

  if (options.actionAcks !== undefined) {
    app.post<{ Params: { actionId: string } }>(
      "/api/v1/agent-status/action-acks/:actionId",
      { bodyLimit: 16 * 1024 },
      async (request, reply) => {
        if (!validateHost(request.raw, reply.raw) || !validateOrigin(request.raw, reply.raw)) {
          reply.hijack();
          return;
        }
        const principal = options.credentials.authenticate(request.headers.authorization);
        if (principal.kind !== "agent") {
          throw new DomainError(
            "agent_action_ack_reporter_required",
            "Only active agent runs may acknowledge actions",
            403,
          );
        }
        limiter.check(principal.runId);
        const action = options.actionAcks!.acknowledge(
          principal,
          request.params.actionId,
          request.body as never,
        );
        return reply.status(202).send(action);
      },
    );
  }
}
