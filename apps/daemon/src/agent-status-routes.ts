import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import { AgentStatusEventInputSchema } from "@nanasa/contracts";
import type { FastifyInstance } from "fastify";

import type { AgentActionAckService } from "./actions/agent-action-ack-service.js";
import type { AgentRuntimeProvisioner } from "./agent-runtime-provisioner.js";
import { AgentStatusService } from "./agent-status-service.js";
import type { ForemanRuntimeService } from "./foreman-runtime-service.js";
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
  foreman?: ForemanRuntimeService;
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
    if (principal.kind === "foreman") {
      limiter.check(principal.runId);
      const event = AgentStatusEventInputSchema.parse(request.body);
      const run = options.store.getActiveForemanRun(principal.foremanId);
      if (run === undefined || run.id !== principal.runId)
        throw new DomainError("status_generation_fenced", "Foreman run changed", 409);
      await options.foreman?.observeReporterProcess(run);
      try {
        const result = options.store.ingestForemanStatusEvent(principal, event);
        if (event.event === "session.ready" && options.runtimeProvisioner !== undefined) {
          const reported =
            event.data.nativeSession ??
            (event.nativeSessionId === undefined
              ? undefined
              : { kind: "id" as const, value: event.nativeSessionId });
          if (reported !== undefined) {
            const reference = await options.runtimeProvisioner.normalizeNativeSession(
              run,
              {
                source: event.source,
                referenceKind: reported.kind,
                referenceValue: reported.value,
              },
              await options.runtimeProvisioner.providerStateRoot(run),
            );
            const prior = options.store.database
              .prepare("SELECT reference_json FROM foreman_native_sessions WHERE foreman_id = ?")
              .get(run.foremanId);
            if (
              run.recoveryPhase === "resuming" &&
              (prior === undefined ||
                (JSON.parse(String(prior.reference_json)) as { dedupeHash: string }).dedupeHash !==
                  reference.dedupeHash)
            ) {
              options.store.revokeReporterAuthority(
                run.id,
                run.generation,
                "foreman_native_session_mismatch",
              );
              throw new DomainError(
                "foreman_native_session_mismatch",
                "The provider did not confirm the expected native session",
                409,
              );
            }
            options.store.database
              .prepare(`INSERT INTO foreman_native_sessions (foreman_id, run_id, generation, reference_json, updated_at)
              VALUES (?, ?, ?, ?, ?) ON CONFLICT(foreman_id) DO UPDATE SET run_id = excluded.run_id, generation = excluded.generation, reference_json = excluded.reference_json, updated_at = excluded.updated_at`)
              .run(
                run.foremanId,
                run.id,
                run.generation,
                JSON.stringify(reference),
                new Date().toISOString(),
              );
            if (["resuming", "restarting"].includes(run.recoveryPhase))
              options.store.database
                .prepare(
                  "UPDATE runs SET recovery_phase = 'recovered', recovery_outcome = ? WHERE id = ?",
                )
                .run(run.recoveryPhase === "resuming" ? "resumed" : "restarted", run.id);
          }
        }
        if (event.data.effectiveModel !== undefined)
          options.store.updateRuntimeRunProviderMetadata(run.id, {
            effectiveModel: event.data.effectiveModel,
          });
        return reply.status(202).send(result);
      } catch (error) {
        options.store.recordReporterRejection(
          event,
          error instanceof DomainError ? error.code : "status_reporter_rejected",
        );
        throw error;
      }
    }
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
