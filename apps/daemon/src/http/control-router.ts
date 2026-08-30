import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  AdHocConsoleSessionSchema,
  type AgentActionPrincipal,
  AgentActionSchema,
  AgentActionWorkspaceSchema,
  AgentRunSchema,
  AgentStatusDetailSchema,
  AgentStatusSummarySchema,
  AssignAgentCheckoutCommandSchema,
  BrowserRestartFrameSchema,
  CheckoutSchema,
  type ControlMetadata,
  CreateAgentActionCommandSchema,
  CreateGroupAgentCommandSchema,
  CreateGroupCommandSchema,
  CreateWorktreeCommandSchema,
  DeleteGroupResultSchema,
  EventServerFrameSchema,
  ExtensionLifecycleCommandSchema,
  InstallProviderExtensionCommandSchema,
  InterruptAgentRunCommandSchema,
  MAX_MESSAGE_TEXT_BYTES,
  OpenCheckoutCommandSchema,
  OpenWaitSchema,
  OVERSIZED_MESSAGE_GUIDANCE,
  ProviderStateBindingSchema,
  type RemoteDescriptor,
  RemoteDescriptorSchema,
  RemoveGroupAgentResultSchema,
  RemoveWorktreeCommandSchema,
  ReorderGroupAgentsCommandSchema,
  ReorderGroupAgentsResultSchema,
  ReorderGroupsCommandSchema,
  ReorderGroupsResultSchema,
  RepairProviderExtensionCommandSchema,
  ReparentGroupAgentCommandSchema,
  ReparentGroupAgentResultSchema,
  ReplyOpenWaitCommandSchema,
  RepositorySchema,
  RoleDefinitionSchema,
  type ServiceDescriptor,
  StartAgentRunCommandSchema,
  StartGroupRunsCommandSchema,
  StartGroupRunsResultSchema,
  StopAgentRunCommandSchema,
  SubmitMessageCommandSchema,
  TerminalCheckpointCaptureSchema,
  TerminalCheckpointContentSchema,
  TerminalCheckpointSchema,
  TerminalEndpointStatusSchema,
  TerminalReadRequestSchema,
  TerminalReadResultSchema,
  TrustProviderExtensionCommandSchema,
  UpdateGroupAgentCommandSchema,
  UpdateGroupCommandSchema,
  UpdateRolePresentationCommandSchema,
  WaitForAgentActionCommandSchema,
  WorktreeOperationResultSchema,
  WorktreeSchema,
} from "@nanasa/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentActionScheduler } from "../actions/agent-action-scheduler.js";
import type { AgentActionService } from "../actions/agent-action-service.js";
import type { AgentOpenWaitService } from "../actions/agent-open-wait-service.js";
import type { AgentWaitService } from "../actions/agent-wait-service.js";
import type { AdHocConsoleManager } from "../ad-hoc-console-manager.js";
import type { AgentStatusQueryService } from "../agent-status-query-service.js";
import type { ConfigRepository } from "../config-repository.js";
import type { DeliveryRepository } from "../delivery-repository.js";
import type { EventLog } from "../event-log.js";
import { EventStreamSession } from "../event-stream-session.js";
import type { ProviderExtensionService } from "../extensions/provider-extension-service.js";
import type { ProviderHealthService } from "../extensions/provider-health-service.js";
import type { CheckoutService } from "../git/checkout-service.js";
import type { WorktreeService } from "../git/worktree-service.js";
import type { MessageCommandService } from "../message-command-service.js";
import type { MessageRepository } from "../message-repository.js";
import type { OperatorAuth } from "../operator-auth.js";
import type { ProviderStateRepository } from "../provider-state-repository.js";
import type { RunRuntimeCoordinator } from "../run-runtime-coordinator.js";
import type { SnapshotReadModel } from "../snapshot-read-model.js";
import { DomainError, type NanasaStore } from "../store.js";
import type { ArtifactPreviewService } from "../terminal/artifact-preview-service.js";
import type { TerminalGateway } from "../terminal/terminal-gateway.js";
import type { TerminalReadService } from "../terminal/terminal-read-service.js";
import type { TopologyOrderService } from "../topology-order-service.js";
import type { TopologyService } from "../topology-service.js";
import {
  type ControlRouteDeclaration,
  controlRoute,
  generateControlOpenApi,
} from "./route-registry.js";

export interface ControlRouterServices {
  metadata(): ControlMetadata;
  service(): ServiceDescriptor;
  remote(): RemoteDescriptor;
  config: ConfigRepository;
  snapshot: SnapshotReadModel;
  store: NanasaStore;
  auth: OperatorAuth;
  providerStates: ProviderStateRepository;
  extensions: ProviderExtensionService;
  extensionHealth: ProviderHealthService;
  topology: TopologyService;
  topologyOrder: TopologyOrderService;
  coordinator: RunRuntimeCoordinator;
  statuses: AgentStatusQueryService;
  messages: MessageRepository;
  messageCommands: MessageCommandService;
  deliveries: DeliveryRepository;
  actions: AgentActionService;
  actionScheduler: AgentActionScheduler;
  actionWaits: AgentWaitService;
  openWaits: AgentOpenWaitService;
  terminalGateway: TerminalGateway;
  terminalReads: TerminalReadService;
  consoles: AdHocConsoleManager;
  checkouts: CheckoutService;
  worktrees: WorktreeService;
  artifactPreviews: ArtifactPreviewService;
  eventLog: EventLog;
  eventSessions: Set<EventStreamSession>;
  instanceId: string;
  daemonEpoch: number;
}

type RouteHandler = (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>;

export const STABLE_IDEMPOTENCY_DOMAIN_ERROR_CODES = new Set([
  "artifact_path_required",
  "group_id_required",
  "invalid_worktree_branch",
  "tmux_invalidation_invalid",
]);

function deterministicError(error: unknown): { statusCode: number; response: unknown } | undefined {
  if (
    error instanceof DomainError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    STABLE_IDEMPOTENCY_DOMAIN_ERROR_CODES.has(error.code)
  ) {
    return { statusCode: error.statusCode, response: { code: error.code, message: error.message } };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    const oversized = error.issues.some(
      (issue) =>
        typeof issue === "object" &&
        issue !== null &&
        "message" in issue &&
        String(issue.message).includes(`${MAX_MESSAGE_TEXT_BYTES}-byte UTF-8 limit`),
    );
    return oversized
      ? {
          statusCode: 413,
          response: {
            code: "message_body_too_large",
            message: `Message text exceeds the ${MAX_MESSAGE_TEXT_BYTES}-byte UTF-8 limit. ${OVERSIZED_MESSAGE_GUIDANCE}`,
          },
        }
      : {
          statusCode: 400,
          response: {
            code: "validation_error",
            message: "Request validation failed",
            issues: error.issues,
          },
        };
  }
  return undefined;
}

function record(value: unknown): Record<string, string | undefined> {
  return value as Record<string, string | undefined>;
}

function routeBody(declaration: ControlRouteDeclaration, request: FastifyRequest): unknown {
  return declaration.schemas.body.parse(request.body ?? {});
}

function requestIdempotencyKey(
  declaration: ControlRouteDeclaration,
  request: FastifyRequest,
): string | undefined {
  const value = request.headers["idempotency-key"];
  if (declaration.idempotency === "forbidden") {
    if (value !== undefined) {
      throw new DomainError(
        "idempotency_not_supported",
        "This route does not accept Idempotency-Key",
        400,
      );
    }
    return undefined;
  }
  if (value === undefined) {
    if (declaration.idempotency === "required") {
      throw new DomainError(
        "idempotency_key_required",
        "This route requires an Idempotency-Key",
        400,
      );
    }
    return undefined;
  }
  if (Array.isArray(value) || value.trim().length === 0 || value.length > 128) {
    throw new DomainError(
      "invalid_idempotency_key",
      "Idempotency-Key must contain between 1 and 128 characters",
      400,
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestDigest(request: FastifyRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        params: request.params ?? {},
        query: request.query ?? {},
        body: request.body ?? {},
      }),
    )
    .digest("hex");
}

function operatorPrincipal(services: ControlRouterServices, request: FastifyRequest) {
  return services.auth.authenticate(request);
}

function actionPrincipal(
  services: ControlRouterServices,
  request: FastifyRequest,
): AgentActionPrincipal {
  return { kind: "operator", operatorId: operatorPrincipal(services, request).operatorId };
}

function parsePositive(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new DomainError(`invalid_${name}`, `${name} must be a positive integer`, 400);
  }
  return Number(value);
}

function parseAfterSequence(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) {
    throw new DomainError("invalid_event_sequence", "after must be a nonnegative integer", 400);
  }
  return Number(value);
}

export function registerControlRouter(app: FastifyInstance, services: ControlRouterServices): void {
  const register = (id: string, handler: RouteHandler): void => {
    const declaration = controlRoute(id);
    if (declaration.transport === "websocket") {
      throw new Error(`WebSocket route ${id} requires its dedicated binding`);
    }
    app.route({
      method: declaration.method,
      url: declaration.path,
      bodyLimit: declaration.bodyLimit,
      handler: async (request, reply) => {
        if (declaration.method === "GET") return handler(request, reply);
        const key = requestIdempotencyKey(declaration, request);
        if (key === undefined) return handler(request, reply);
        const reservation = {
          principalId: operatorPrincipal(services, request).operatorId,
          routeId: declaration.id,
          key,
          requestDigest: requestDigest(request),
        };
        const outcome = services.store.executeHttpIdempotency(reservation, () => {
          try {
            const response = handler(request, reply);
            if (response instanceof Promise || response === reply) {
              throw new Error(
                `Idempotent route ${declaration.id} must return a synchronous response value`,
              );
            }
            return { statusCode: reply.statusCode, response };
          } catch (error) {
            const retained = deterministicError(error);
            if (retained !== undefined) return retained;
            throw error;
          }
        });
        if (outcome.kind === "replay") {
          reply.header("Idempotency-Replayed", "true");
        }
        return reply.status(outcome.statusCode).send(outcome.response);
      },
    });
  };

  register("meta.get", () => services.metadata());
  register("schema.openapi", () => generateControlOpenApi());
  register("schema.extensions", () => services.extensions.generatedReference());
  register("auth.bootstrap", (request, reply) => services.auth.bootstrap(request.body, reply));
  register("auth.session", (request) => services.auth.session(request));
  register("auth.revoke", (request, reply) => {
    services.auth.revoke(request, reply);
    return reply.status(204).send();
  });
  register("config.get", () => services.config.load().config);
  register("config.status", () => services.config.load().status);
  register("snapshot.get", () => ({
    ...services.snapshot.read(),
    messages: [],
    deliveryOutcomes: [],
  }));
  register("service.status", () => services.service());
  register("service.planRestart", (request) => {
    const reason = z
      .object({ reason: z.enum(["upgrade", "rollback", "operator-restart"]) })
      .strict()
      .parse(routeBody(controlRoute("service.planRestart"), request)).reason;
    return BrowserRestartFrameSchema.parse({
      version: 1,
      type: "service.restart",
      reason,
      instanceId: services.instanceId,
      retryAfterMs: 1_000,
      resnapshotRequired: true,
      terminalHandoff: false,
    });
  });
  register("remote.status", () => RemoteDescriptorSchema.parse(services.remote()));

  register("state.list", () =>
    services.providerStates.list().map((item) => ProviderStateBindingSchema.parse(item)),
  );
  register("state.get", (request) => {
    const binding = services.providerStates.get(record(request.params).bindingId ?? "");
    if (binding === undefined)
      throw new DomainError("provider_state_not_found", "Provider state not found", 404);
    return ProviderStateBindingSchema.parse(binding);
  });
  register("state.retain", (request) =>
    ProviderStateBindingSchema.parse(
      services.providerStates.retain(record(request.params).bindingId ?? ""),
    ),
  );
  register("state.delete", (request) =>
    ProviderStateBindingSchema.parse(
      services.providerStates.markDeleted(record(request.params).bindingId ?? ""),
    ),
  );
  register("trust.list", () => services.store.listRepositoryTrust());
  register("extensions.catalog", () => services.extensions.list());
  register("extensions.list", () => services.extensions.list());
  register("extensions.inspect", (request) =>
    services.extensions.inspect(record(request.params).extensionId ?? ""),
  );
  register("extensions.plan", (request) =>
    services.extensions.plan(record(request.params).extensionId ?? ""),
  );
  register("extensions.health", (request) =>
    services.extensionHealth.inspect(record(request.params).extensionId ?? ""),
  );
  register("extensions.trust", (request) =>
    services.extensions.trust(
      record(request.params).extensionId ?? "",
      operatorPrincipal(services, request).operatorId,
      TrustProviderExtensionCommandSchema.parse(
        routeBody(controlRoute("extensions.trust"), request),
      ),
    ),
  );
  register("extensions.install", (request) => {
    return services.extensions.install(
      record(request.params).extensionId ?? "",
      InstallProviderExtensionCommandSchema.parse(
        routeBody(controlRoute("extensions.install"), request),
      ),
    );
  });
  register("extensions.repair", (request) => {
    return services.extensions.repair(
      record(request.params).extensionId ?? "",
      RepairProviderExtensionCommandSchema.parse(
        routeBody(controlRoute("extensions.repair"), request),
      ),
    );
  });
  for (const [id, operation] of [
    ["extensions.disable", "disable"],
    ["extensions.rollback", "rollback"],
  ] as const) {
    register(id, (request) => {
      return services.extensions[operation](
        record(request.params).extensionId ?? "",
        ExtensionLifecycleCommandSchema.parse(routeBody(controlRoute(id), request)),
      );
    });
  }
  register("extensions.remove", (request) => {
    return services.extensions.remove(
      record(request.params).extensionId ?? "",
      ExtensionLifecycleCommandSchema.parse(routeBody(controlRoute("extensions.remove"), request)),
    );
  });

  register("groups.list", () => services.store.getSnapshot().groups);
  register("groups.get", (request) =>
    services.store.getGroup(record(request.params).groupId ?? ""),
  );
  register("groups.create", async (request, reply) => {
    const declaration = controlRoute("groups.create");
    const group = await services.topology.createGroup(
      CreateGroupCommandSchema.parse(routeBody(declaration, request)),
    );
    return reply.status(201).send(group);
  });
  register("groups.update", (request) =>
    services.topology.updateGroup(
      record(request.params).groupId ?? "",
      UpdateGroupCommandSchema.parse(routeBody(controlRoute("groups.update"), request)),
    ),
  );
  register("groups.delete", async (request) =>
    DeleteGroupResultSchema.parse(
      await services.topology.deleteGroup(record(request.params).groupId ?? ""),
    ),
  );
  register("groups.reorder", async (request) =>
    ReorderGroupsResultSchema.parse(
      await services.topologyOrder.reorderGroups(
        ReorderGroupsCommandSchema.parse(routeBody(controlRoute("groups.reorder"), request)),
      ),
    ),
  );

  register("agents.list", (request) =>
    services.store
      .getSnapshot()
      .memberships.filter(
        (membership) =>
          membership.groupId === record(request.params).groupId && membership.state === "active",
      ),
  );
  register("agents.get", (request) =>
    services.topology.getAgentMembership(
      record(request.params).groupId ?? "",
      record(request.params).agentId ?? "",
    ),
  );
  register("agents.create", async (request, reply) => {
    const declaration = controlRoute("agents.create");
    const membership = await services.topology.createAgent(
      record(request.params).groupId ?? "",
      CreateGroupAgentCommandSchema.parse(routeBody(declaration, request)),
    );
    return reply.status(201).send(membership);
  });
  register("agents.update", (request) =>
    services.topology.updateAgent(
      record(request.params).groupId ?? "",
      record(request.params).agentId ?? "",
      UpdateGroupAgentCommandSchema.parse(routeBody(controlRoute("agents.update"), request)),
    ),
  );
  register("agents.delete", async (request) =>
    RemoveGroupAgentResultSchema.parse(
      await services.topology.removeAgent(
        record(request.params).groupId ?? "",
        record(request.params).agentId ?? "",
      ),
    ),
  );
  register("agents.reorder", async (request) =>
    ReorderGroupAgentsResultSchema.parse(
      await services.topologyOrder.reorderAgents(
        record(request.params).groupId ?? "",
        ReorderGroupAgentsCommandSchema.parse(routeBody(controlRoute("agents.reorder"), request)),
      ),
    ),
  );
  register("agents.reparent", async (request) =>
    ReparentGroupAgentResultSchema.parse(
      await services.topologyOrder.reparentAgent(
        record(request.params).groupId ?? "",
        record(request.params).agentId ?? "",
        ReparentGroupAgentCommandSchema.parse(routeBody(controlRoute("agents.reparent"), request)),
      ),
    ),
  );
  register("agents.assignCheckout", async (request, reply) => {
    const command = AssignAgentCheckoutCommandSchema.parse(
      routeBody(controlRoute("agents.assignCheckout"), request),
    );
    await services.topologyOrder.assignCheckout(
      record(request.params).groupId ?? "",
      record(request.params).agentId ?? "",
      command.checkoutId,
    );
    return reply.status(204).send();
  });

  register("roles.list", () => services.config.load().config.roles);
  register("roles.get", (request) => {
    const role = services.config.load().config.roles[record(request.params).roleId ?? ""];
    if (role === undefined) throw new DomainError("role_not_found", "Role not found", 404);
    return RoleDefinitionSchema.parse(role);
  });
  register("roles.updatePresentation", async (request) =>
    RoleDefinitionSchema.parse(
      await services.topology.updateRolePresentation(
        record(request.params).roleId ?? "",
        UpdateRolePresentationCommandSchema.parse(
          routeBody(controlRoute("roles.updatePresentation"), request),
        ),
      ),
    ),
  );

  register("runs.list", (request) => {
    const query = record(request.query);
    return services.store
      .getSnapshot()
      .runs.filter(
        (run) =>
          (query.groupId === undefined || run.groupId === query.groupId) &&
          (query.memberId === undefined || run.memberId === query.memberId) &&
          (query.status === undefined || run.status === query.status) &&
          (query.active === undefined ||
            ["starting", "running", "stopping"].includes(run.status) === (query.active === "true")),
      );
  });
  register("runs.get", (request) => services.store.getRun(record(request.params).runId ?? ""));
  register("runs.start", async (request, reply) => {
    const command = StartAgentRunCommandSchema.parse(
      routeBody(controlRoute("runs.start"), request),
    );
    const params = record(request.params);
    const membership = services.topology.getAgentMembership(
      params.groupId ?? "",
      params.agentId ?? "",
    );
    const run = await services.coordinator.startRun(
      params.groupId ?? "",
      membership.memberId,
      command,
    );
    return reply.status(201).send(run);
  });
  register("runs.stop", async (request) => {
    StopAgentRunCommandSchema.parse(routeBody(controlRoute("runs.stop"), request));
    const params = record(request.params);
    const membership = services.topology.getAgentMembership(
      params.groupId ?? "",
      params.agentId ?? "",
    );
    return services.coordinator.stopRun(params.groupId ?? "", membership.memberId);
  });
  register("runs.restart", async (request, reply) => {
    const command = StartAgentRunCommandSchema.parse(
      routeBody(controlRoute("runs.restart"), request),
    );
    return reply
      .status(201)
      .send(await services.coordinator.restartRun(record(request.params).runId ?? "", command));
  });
  register("runs.startAll", async (request) => {
    const declaration = controlRoute("runs.startAll");
    return StartGroupRunsResultSchema.parse(
      await services.coordinator.startAll(
        record(request.params).groupId ?? "",
        StartGroupRunsCommandSchema.parse(routeBody(declaration, request)),
      ),
    );
  });
  register("runs.stopAll", async (request) => {
    StopAgentRunCommandSchema.parse(routeBody(controlRoute("runs.stopAll"), request));
    return AgentRunSchema.array().parse(
      await services.coordinator.stopAll(record(request.params).groupId ?? ""),
    );
  });
  register("runs.restartAll", async (request) => {
    const command = StartGroupRunsCommandSchema.parse(
      routeBody(controlRoute("runs.restartAll"), request),
    );
    return AgentRunSchema.array().parse(
      await services.coordinator.restartAll(record(request.params).groupId ?? "", command),
    );
  });
  register("runs.interrupt", async (request, reply) => {
    const principal = operatorPrincipal(services, request);
    InterruptAgentRunCommandSchema.parse({
      ...record(routeBody(controlRoute("runs.interrupt"), request)),
      operatorId: principal.operatorId,
    });
    await services.coordinator.interrupt(record(request.params).runId ?? "");
    return reply.status(204).send();
  });

  register("statuses.list", (request) => {
    const principal = operatorPrincipal(services, request);
    const groupId = record(request.query).groupId;
    const groups =
      groupId === undefined
        ? services.store.getSnapshot().groups.map((group) => group.id)
        : [groupId];
    return AgentStatusSummarySchema.array().parse(
      groups.flatMap((id) => services.statuses.list(id, principal.operatorId)),
    );
  });
  register("statuses.get", (request) => {
    const principal = operatorPrincipal(services, request);
    const params = record(request.params);
    return AgentStatusDetailSchema.parse(
      services.statuses.get(params.groupId ?? "", params.memberId ?? "", principal.operatorId),
    );
  });
  register("statuses.acknowledge", (request) => {
    const principal = operatorPrincipal(services, request);
    const params = record(request.params);
    return AgentStatusDetailSchema.parse(
      services.statuses.acknowledgeCompletion(
        params.groupId ?? "",
        params.memberId ?? "",
        principal.operatorId,
      ),
    );
  });

  register("messages.submit", (request, reply) => {
    const declaration = controlRoute("messages.submit");
    const principal = operatorPrincipal(services, request);
    const parsed = SubmitMessageCommandSchema.parse(routeBody(declaration, request));
    const result = services.messageCommands.submit(record(request.params).groupId ?? "", {
      ...parsed,
      sender: { kind: "operator", operatorId: principal.operatorId },
    });
    reply.status(201);
    return result;
  });
  register("messages.list", (request) => {
    const query = record(request.query);
    const limit = parsePositive(query.limit, "message_limit");
    const before = parsePositive(query.before, "message_cursor");
    const after = parsePositive(query.after, "message_cursor");
    return services.messages.page(record(request.params).groupId ?? "", {
      ...(limit === undefined ? {} : { limit }),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
  });
  register("messages.clear", (request) =>
    services.messages.clear(record(request.params).groupId ?? ""),
  );
  register("messages.deliveries", (request) =>
    services.deliveries.list(record(request.params).messageId ?? ""),
  );

  register("actions.create", (request, reply) => {
    const declaration = controlRoute("actions.create");
    const action = services.actions.create(
      actionPrincipal(services, request),
      CreateAgentActionCommandSchema.parse(routeBody(declaration, request)),
      request.id,
    );
    setImmediate(() => void services.actionScheduler.tick());
    reply.status(201);
    return AgentActionSchema.parse(action);
  });
  register("actions.get", (request) =>
    AgentActionSchema.parse(
      services.actions.get(
        actionPrincipal(services, request),
        record(request.params).actionId ?? "",
      ),
    ),
  );
  register("actions.workspace", (request) =>
    AgentActionWorkspaceSchema.parse(
      services.actions.listWorkspace(record(request.params).groupId ?? ""),
    ),
  );
  register("actions.cancel", (request) =>
    AgentActionSchema.parse(
      services.actions.cancel(
        actionPrincipal(services, request),
        record(request.params).actionId ?? "",
      ),
    ),
  );
  register("actions.wait", (request) =>
    services.actionWaits.wait(
      actionPrincipal(services, request),
      record(request.params).actionId ?? "",
      WaitForAgentActionCommandSchema.parse(routeBody(controlRoute("actions.wait"), request)),
    ),
  );
  register("waits.list", (request) => {
    const groupId = record(request.query).groupId;
    if (groupId === undefined)
      throw new DomainError("group_id_required", "groupId is required", 400);
    return OpenWaitSchema.array().parse(
      services.openWaits.list(
        actionPrincipal(services, request),
        groupId,
        record(request.query).memberId,
      ),
    );
  });
  register("waits.reply", (request) =>
    services.openWaits.reply(
      actionPrincipal(services, request),
      record(request.params).waitId ?? "",
      ReplyOpenWaitCommandSchema.parse(routeBody(controlRoute("waits.reply"), request)),
    ),
  );

  register("terminal.status", (request) =>
    TerminalEndpointStatusSchema.parse(
      services.terminalGateway.status(record(request.params).runId ?? ""),
    ),
  );
  register("terminal.read", async (request) => {
    const query = record(request.query);
    return TerminalReadResultSchema.parse(
      await services.terminalReads.read(
        TerminalReadRequestSchema.parse({
          runId: record(request.params).runId,
          generation: Number(query.generation),
          source: query.source ?? "history",
          maxLines: query.maxLines === undefined ? 200 : Number(query.maxLines),
          maxBytes: query.maxBytes === undefined ? 65_536 : Number(query.maxBytes),
        }),
      ),
    );
  });
  register("terminal.checkpoints.list", (request) =>
    services.terminalReads
      .list(operatorPrincipal(services, request).operatorId)
      .map((item) => TerminalCheckpointSchema.parse(item)),
  );
  register("terminal.checkpoints.create", async (request, reply) => {
    const principal = operatorPrincipal(services, request);
    const command = TerminalCheckpointCaptureSchema.parse(
      routeBody(controlRoute("terminal.checkpoints.create"), request),
    );
    const result = await services.terminalReads.captureCheckpoint(
      principal.operatorId,
      record(request.params).runId ?? "",
      command.generation,
      command.source,
    );
    return reply.status(201).send(TerminalCheckpointSchema.parse(result));
  });
  register("terminal.checkpoints.get", (request) =>
    TerminalCheckpointContentSchema.parse(
      services.terminalReads.retrieve(
        operatorPrincipal(services, request).operatorId,
        record(request.params).checkpointId ?? "",
      ),
    ),
  );
  register("terminal.checkpoints.delete", (request, reply) => {
    const deleted = services.terminalReads.delete(
      operatorPrincipal(services, request).operatorId,
      record(request.params).checkpointId ?? "",
    );
    if (!deleted)
      throw new DomainError("terminal_checkpoint_not_found", "Terminal checkpoint not found", 404);
    return reply.status(204).send();
  });

  register("consoles.list", () =>
    services.consoles.list().map((item) => AdHocConsoleSessionSchema.parse(item)),
  );
  register("consoles.get", (request) =>
    AdHocConsoleSessionSchema.parse(services.consoles.get(record(request.params).consoleId ?? "")),
  );
  register("consoles.create", async (_request, reply) =>
    reply.status(201).send(AdHocConsoleSessionSchema.parse(await services.consoles.create())),
  );
  register("consoles.delete", async (request, reply) => {
    await services.consoles.remove(record(request.params).consoleId ?? "");
    return reply.status(204).send();
  });

  register("repositories.list", () =>
    services.store.listRepositories().map((item) => RepositorySchema.parse(item)),
  );
  register("checkouts.list", (request) =>
    services.checkouts
      .list(record(request.params).repositoryId)
      .map((item) => CheckoutSchema.parse(item)),
  );
  register("checkouts.open", async (request) =>
    WorktreeOperationResultSchema.parse(
      await services.worktrees.open(
        OpenCheckoutCommandSchema.parse(routeBody(controlRoute("checkouts.open"), request)),
      ),
    ),
  );
  register("worktrees.list", (request) =>
    services.worktrees
      .list(record(request.params).repositoryId ?? "")
      .map((item) => WorktreeSchema.parse(item)),
  );
  register("worktrees.create", async (request, reply) => {
    const command = CreateWorktreeCommandSchema.parse(
      routeBody(controlRoute("worktrees.create"), request),
    );
    const assignments = services.topologyOrder.assertAgentsStopped(command.assignAgentIds);
    const result = await services.worktrees.create(command);
    if (result.checkout !== undefined && assignments.length > 0) {
      await services.topologyOrder.assignCheckoutToAgents(assignments, result.checkout.id);
    }
    return reply.status(201).send(WorktreeOperationResultSchema.parse(result));
  });
  register("worktrees.delete", async (request) =>
    WorktreeOperationResultSchema.parse(
      await services.worktrees.remove(
        record(request.params).worktreeId ?? "",
        RemoveWorktreeCommandSchema.parse(routeBody(controlRoute("worktrees.delete"), request)),
      ),
    ),
  );

  app.get<{ Querystring: { after?: string; instance?: string } }>(
    controlRoute("events.subscribe").path,
    { websocket: true },
    (socket, request) => {
      const session = new EventStreamSession(socket, services.eventLog, {
        afterSequence: parseAfterSequence(request.query.after),
        ...(request.query.instance === undefined
          ? {}
          : { requestedInstanceId: request.query.instance }),
        instanceId: services.instanceId,
        daemonEpoch: services.daemonEpoch,
      });
      services.eventSessions.add(session);
      socket.once("close", () => services.eventSessions.delete(session));
      session.start();
    },
  );

  register("artifact.preview", (request, reply) => {
    const path = record(request.query).path;
    if (path === undefined)
      throw new DomainError("artifact_path_required", "Artifact path is required", 400);
    const preview = services.artifactPreviews.inspect(path);
    reply.header("Content-Disposition", "inline");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.type(preview.mediaType).send(createReadStream(preview.absolutePath));
  });

  register("schema.events", () =>
    z.toJSONSchema(EventServerFrameSchema, { unrepresentable: "any" }),
  );
}
