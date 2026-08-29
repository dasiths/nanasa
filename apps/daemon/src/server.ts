import { dirname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  AdHocConsoleSessionSchema,
  CreateGroupAgentCommandSchema,
  CreateGroupCommandSchema,
  DeleteGroupResultSchema,
  InterruptAgentRunCommandSchema,
  MAX_MESSAGE_REQUEST_BYTES,
  MAX_MESSAGE_TEXT_BYTES,
  OVERSIZED_MESSAGE_GUIDANCE,
  RemoveGroupAgentResultSchema,
  ReorderGroupAgentsCommandSchema,
  ReorderGroupAgentsResultSchema,
  RoleDefinitionSchema,
  StartAgentRunCommandSchema,
  StartGroupRunsCommandSchema,
  StartGroupRunsResultSchema,
  StopAgentRunCommandSchema,
  TerminalEndpointStatusSchema,
  UpdateGroupAgentCommandSchema,
  UpdateGroupCommandSchema,
  UpdateRolePresentationCommandSchema,
} from "@nanasa/contracts";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { AdHocConsoleManager } from "./ad-hoc-console-manager.js";
import { AgentRuntimeProvisioner } from "./agent-runtime-provisioner.js";
import { registerAgentStatusRoutes } from "./agent-status-routes.js";
import { AuthorityPolicy } from "./authority-policy.js";
import { discoverAndLoadNanasaConfig, type LoadedNanasaConfig } from "./config-v2.js";
import { ConfigRepository } from "./config-repository.js";
import { DaemonInstanceGuard } from "./daemon-instance-guard.js";
import { DaemonLifecycle } from "./daemon-lifecycle.js";
import { DeliveryDispatcher } from "./delivery-dispatcher.js";
import { EventLog } from "./event-log.js";
import { EventStreamSession } from "./event-stream-session.js";
import { resolveEffectiveAgentPrompt } from "./instruction-resolver.js";
import { McpCredentialIssuer } from "./mcp-auth.js";
import { validateMcpEndpointConfiguration } from "./mcp-config.js";
import { registerMcpRoutes } from "./mcp-server.js";
import { MessageCommandService } from "./message-command-service.js";
import { OperatorAuth } from "./operator-auth.js";
import { controlMetadata, repositoryTmuxNamespace } from "./protocol-metadata.js";
import { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
import { SnapshotReadModel } from "./snapshot-read-model.js";
import { DomainError, NanasaStore } from "./store.js";
import { TmuxTerminalDelivery } from "./terminal-delivery.js";
import { TerminalEndpointRegistry } from "./terminal-endpoint-registry.js";
import { registerTerminalProxy } from "./terminal-proxy.js";
import { TmuxRuntime } from "./tmux-runtime.js";
import { TopologyService } from "./topology-service.js";
import { TtydSupervisor } from "./ttyd-supervisor.js";

export interface DaemonOptions {
  dataPath?: string;
  runtimePath?: string;
  repoRoot?: string;
  loadedConfig?: LoadedNanasaConfig;
  logger?: boolean | FastifyBaseLogger;
  tmuxServerName?: string;
  tmuxPath?: string;
  ttydPath?: string;
  reconcileIntervalMs?: number;
  statusEndpointUrl?: string;
  servePortal?: boolean;
  portalAssetsPath?: string;
  authority?: {
    allowedHostnames?: string[];
    trustedProxyAddresses?: string[];
    secureCookies?: boolean;
  };
  mcp?: {
    enabled: boolean;
    path?: string;
    endpointUrl?: string;
    operatorToken?: string;
    allowedHostnames?: string[];
    secretPath?: string;
  };
}

export interface DaemonContext {
  app: FastifyInstance;
  store: NanasaStore;
  runtime: TmuxRuntime;
  coordinator: RunRuntimeCoordinator;
  terminalEndpoints: TerminalEndpointRegistry;
  ttydSupervisor: TtydSupervisor;
  consoles: AdHocConsoleManager;
  dispatcher: DeliveryDispatcher;
  messageCommands: MessageCommandService;
  topology: TopologyService;
  loadedConfig: LoadedNanasaConfig;
  runtimePath: string;
  guard: DaemonInstanceGuard;
  lifecycle: DaemonLifecycle;
  daemonEpoch: number;
  operatorAuth: OperatorAuth;
  bootstrapFragment: string;
}

interface ErrorWithIssues {
  issues: unknown[];
}

function isValidationError(error: unknown): error is ErrorWithIssues {
  return (
    typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues)
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function idempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers["idempotency-key"];
  if (value === undefined) {
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

function parseAfterSequence(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new DomainError("invalid_event_sequence", "after must be a nonnegative integer", 400);
  }
  return Number(value);
}

function requestPath(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

export async function createDaemon(options: DaemonOptions): Promise<DaemonContext> {
  if (options.servePortal === true && options.portalAssetsPath === undefined) {
    throw new Error("portalAssetsPath is required when servePortal is enabled");
  }
  const loadedConfig =
    options.loadedConfig ?? discoverAndLoadNanasaConfig(options.repoRoot ?? process.cwd());
  const dataPath = options.dataPath ?? loadedConfig.dataPath;
  const runtimePath =
    options.runtimePath ??
    (options.dataPath !== undefined && options.dataPath !== ":memory:"
      ? join(dirname(options.dataPath), "runtime")
      : loadedConfig.runtimeDirectory);
  const guard = DaemonInstanceGuard.acquire(loadedConfig.repoRoot, loadedConfig.runtimeDirectory);
  const lifecycle = new DaemonLifecycle();
  let appForCleanup: FastifyInstance | undefined;
  let storeForCleanup: NanasaStore | undefined;
  try {
    const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
    appForCleanup = app;
    const store = new NanasaStore(dataPath, {
      config: loadedConfig.config,
      configStatus: loadedConfig.status,
    });
    storeForCleanup = store;
    const daemonEpoch = store.beginDaemonEpoch({
      instanceId: guard.instanceId,
      processId: guard.processId,
      processStartedAt: guard.processStartedAt,
    });
    const authorityPolicy = new AuthorityPolicy(options.authority);
    const operatorAuth = new OperatorAuth({
      secretPath: join(runtimePath, "operator-secret"),
      secureCookies: options.authority?.secureCookies ?? false,
    });
    const bootstrapFragment = `nanasa-bootstrap=${operatorAuth.createBootstrapToken()}`;
    const metadata = () =>
      controlMetadata({
        repositoryRoot: loadedConfig.repoRoot,
        guard,
        daemonEpoch,
        lifecycle,
      });
    const snapshotReadModel = new SnapshotReadModel(store, {
      instanceId: guard.instanceId,
      daemonEpoch,
    });
    const eventLog = new EventLog(store);
    const eventSessions = new Set<EventStreamSession>();
    const configRepository = new ConfigRepository(loadedConfig.repoRoot);
    const mcpPath = options.mcp?.path ?? "/mcp";
    if (!/^\/[A-Za-z0-9/_-]*$/.test(mcpPath) || mcpPath.includes("//")) {
      throw new Error("MCP path must be an absolute URL path");
    }
    const mcpEndpointUrl = options.mcp?.endpointUrl ?? `http://127.0.0.1:3210${mcpPath}`;
    const statusEndpointUrl =
      options.statusEndpointUrl ?? "http://127.0.0.1:3210/api/v1/agent-status/events";
    const statusEndpoint = new URL(statusEndpointUrl);
    if (
      statusEndpoint.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(statusEndpoint.hostname) ||
      statusEndpoint.pathname !== "/api/v1/agent-status/events" ||
      statusEndpoint.search.length > 0 ||
      statusEndpoint.hash.length > 0
    ) {
      throw new Error("The agent status endpoint must be the exact loopback ingestion URL");
    }
    const mcpEndpoint = validateMcpEndpointConfiguration({
      enabled: options.mcp?.enabled === true,
      endpointUrl: mcpEndpointUrl,
      ...(options.mcp?.operatorToken === undefined
        ? {}
        : { operatorToken: options.mcp.operatorToken }),
    });
    if (options.mcp?.enabled === true && mcpEndpoint.pathname !== mcpPath) {
      throw new Error("The MCP endpoint URL path must match the configured MCP path");
    }
    const mcpCredentials =
      options.mcp?.enabled === true
        ? new McpCredentialIssuer(store, {
            secretPath:
              options.mcp.secretPath ??
              join(dataPath === ":memory:" ? runtimePath : dirname(dataPath), "mcp-secret"),
            ...(options.mcp.operatorToken === undefined
              ? {}
              : { operatorToken: options.mcp.operatorToken }),
          })
        : undefined;
    const runtime = new TmuxRuntime(store, {
      serverName: options.tmuxServerName ?? repositoryTmuxNamespace(loadedConfig.repoRoot),
      ...(options.tmuxPath === undefined ? {} : { tmuxPath: options.tmuxPath }),
      ...(mcpCredentials === undefined
        ? {}
        : {
            runtimeProvisioner: new AgentRuntimeProvisioner({
              integrationsDirectory: loadedConfig.integrationsDirectory,
              providerStates: Object.fromEntries(
                Object.entries(loadedConfig.config.integrations).map(([key, integration]) => [
                  key,
                  integration.providerState,
                ]),
              ),
              mcpEndpointUrl,
              promptResolver: (membership) => {
                const current = configRepository.load();
                return resolveEffectiveAgentPrompt({
                  repoRoot: current.repoRoot,
                  config: current.config,
                  groupId: membership.groupId,
                  agentId: membership.id,
                });
              },
            }),
            runtimeEnvironment: (run) => ({
              NANASA_MCP_URL: mcpEndpointUrl,
              NANASA_MCP_TOKEN: mcpCredentials.issueAgent(run),
              NANASA_STATUS_URL: statusEndpointUrl,
            }),
          }),
    });
    const terminalEndpoints = new TerminalEndpointRegistry(store);
    const terminalDelivery = new TmuxTerminalDelivery(runtime, terminalEndpoints);
    const ttydSupervisor = new TtydSupervisor(terminalEndpoints, {
      ...(options.ttydPath === undefined ? {} : { ttydPath: options.ttydPath }),
      ...(options.tmuxPath === undefined ? {} : { tmuxPath: options.tmuxPath }),
      manifestDirectory: join(runtimePath, "ttyd"),
      onLifecycleEvent: (type, runId, payload) => {
        store.recordRuntimeEvent(type, "run", runId, payload);
      },
    });
    const consoles = new AdHocConsoleManager(
      runtime,
      ttydSupervisor,
      terminalEndpoints,
      loadedConfig.repoRoot,
    );
    const dispatcher = new DeliveryDispatcher(store, terminalDelivery);
    const messageCommands = new MessageCommandService(store);
    const coordinator = new RunRuntimeCoordinator(store, runtime, ttydSupervisor, dispatcher, {
      ...(options.reconcileIntervalMs === undefined
        ? {}
        : { reconcileIntervalMs: options.reconcileIntervalMs }),
    });
    const topology = new TopologyService(configRepository, store, coordinator);
    await topology.reconcile();

    await app.register(websocket);
    await coordinator.reconcile(true);
    coordinator.start();

    app.addHook("onRequest", async (request, reply) => {
      const path = requestPath(request.url);
      if (!path.startsWith("/api/v1") && !path.startsWith("/terminals/")) return;
      authorityPolicy.validate(request);
      if (path.startsWith("/api/v1")) {
        reply.header("X-Nanasa-API-Version", "1");
        reply.header("X-Request-Id", request.id);
      }
    });

    app.addHook("preHandler", async (request) => {
      const path = requestPath(request.url);
      if (path.startsWith("/terminals/")) {
        operatorAuth.authorize(request);
        return;
      }
      if (
        !path.startsWith("/api/v1/") ||
        path === "/api/v1/meta" ||
        path === "/api/v1/auth/bootstrap" ||
        path === "/api/v1/agent-status/events"
      ) {
        return;
      }
      operatorAuth.authorize(request);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        lifecycle.assertMutationAllowed();
      }
    });

    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ code: error.code, message: error.message });
      }
      if (isValidationError(error)) {
        const oversized = error.issues.some(
          (issue) =>
            typeof issue === "object" &&
            issue !== null &&
            "message" in issue &&
            String(issue.message).includes(`${MAX_MESSAGE_TEXT_BYTES}-byte UTF-8 limit`),
        );
        if (oversized) {
          return reply.status(413).send({
            code: "message_body_too_large",
            message: `Message text exceeds the ${MAX_MESSAGE_TEXT_BYTES}-byte UTF-8 limit. ${OVERSIZED_MESSAGE_GUIDANCE}`,
          });
        }
        return reply.status(400).send({
          code: "validation_error",
          message: "Request validation failed",
          issues: error.issues,
        });
      }
      if (hasErrorCode(error, "FST_ERR_CTP_BODY_TOO_LARGE")) {
        const payload = {
          code: "request_too_large",
          message: `Request exceeds the ${MAX_MESSAGE_REQUEST_BYTES}-byte message request limit. Message text is limited to ${MAX_MESSAGE_TEXT_BYTES} UTF-8 bytes. ${OVERSIZED_MESSAGE_GUIDANCE}`,
        };
        if (request.url === mcpPath) {
          return reply.status(413).send({
            jsonrpc: "2.0",
            error: { code: -32_000, message: payload.message },
            id: null,
          });
        }
        return reply.status(413).send(payload);
      }
      request.log.error(error);
      return reply.status(500).send({ code: "internal_error", message: "Internal server error" });
    });

    app.addHook("preClose", async () => {
      lifecycle.beginDraining();
      for (const session of eventSessions) session.plannedRestart();
      await consoles.close();
      await coordinator.close();
    });

    app.addHook("onClose", async () => {
      store.releaseDaemonEpoch(guard.instanceId);
      store.close();
      lifecycle.markStopped();
      guard.release();
    });

    app.get("/health", async () => ({ status: "ok" }));
    app.get("/api/v1/meta", async () => metadata());
    operatorAuth.registerRoutes(app);
    if (mcpCredentials !== undefined) {
      registerAgentStatusRoutes(app, {
        path: "/api/v1/agent-status/events",
        allowedHostnames: [statusEndpoint.hostname],
        credentials: mcpCredentials,
        store,
      });
      registerMcpRoutes(app, {
        path: mcpPath,
        endpointUrl: mcpEndpointUrl,
        allowedHostnames: options.mcp?.allowedHostnames ?? [mcpEndpoint.hostname],
        credentials: mcpCredentials,
        store,
        messages: messageCommands,
      });
    }
    app.get("/api/v1/config", async () => configRepository.load().config);
    app.get("/api/v1/config/status", async () => configRepository.load().status);
    app.get("/api/v1/snapshot", async () => ({
      ...snapshotReadModel.read(),
      messages: [],
      deliveryOutcomes: [],
    }));
    app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/terminal", async (request) =>
      TerminalEndpointStatusSchema.parse(terminalEndpoints.status(request.params.runId)),
    );
    app.post("/api/v1/consoles", async (_request, reply) =>
      reply.status(201).send(AdHocConsoleSessionSchema.parse(await consoles.create())),
    );
    app.delete<{ Params: { consoleId: string } }>(
      "/api/v1/consoles/:consoleId",
      async (request, reply) => {
        await consoles.remove(request.params.consoleId);
        return reply.status(204).send();
      },
    );
    app.post<{ Params: { runId: string } }>(
      "/api/v1/runs/:runId/interrupt",
      async (request, reply) => {
        InterruptAgentRunCommandSchema.parse(request.body);
        await coordinator.interrupt(request.params.runId);
        return reply.status(204).send();
      },
    );

    app.post("/api/v1/groups", async (request, reply) => {
      const group = await topology.createGroup(
        CreateGroupCommandSchema.parse(request.body),
        idempotencyKey(request.headers),
      );
      return reply.status(201).send(group);
    });

    app.patch<{ Params: { groupId: string } }>("/api/v1/groups/:groupId", async (request) =>
      topology.updateGroup(request.params.groupId, UpdateGroupCommandSchema.parse(request.body)),
    );

    app.delete<{ Params: { groupId: string } }>("/api/v1/groups/:groupId", async (request) =>
      DeleteGroupResultSchema.parse(
        await topology.deleteGroup(request.params.groupId, idempotencyKey(request.headers)),
      ),
    );

    app.patch<{ Params: { roleId: string } }>(
      "/api/v1/roles/:roleId/presentation",
      async (request) =>
        RoleDefinitionSchema.parse(
          await topology.updateRolePresentation(
            request.params.roleId,
            UpdateRolePresentationCommandSchema.parse(request.body),
          ),
        ),
    );

    app.post<{ Params: { groupId: string } }>(
      "/api/v1/groups/:groupId/agents",
      async (request, reply) => {
        const membership = await topology.createAgent(
          request.params.groupId,
          CreateGroupAgentCommandSchema.parse(request.body),
          idempotencyKey(request.headers),
        );
        return reply.status(201).send(membership);
      },
    );

    app.delete<{ Params: { groupId: string; agentId: string } }>(
      "/api/v1/groups/:groupId/agents/:agentId",
      async (request) =>
        RemoveGroupAgentResultSchema.parse(
          await topology.removeAgent(
            request.params.groupId,
            request.params.agentId,
            idempotencyKey(request.headers),
          ),
        ),
    );

    app.patch<{ Params: { groupId: string; agentId: string } }>(
      "/api/v1/groups/:groupId/agents/:agentId",
      async (request) =>
        topology.updateAgent(
          request.params.groupId,
          request.params.agentId,
          UpdateGroupAgentCommandSchema.parse(request.body),
        ),
    );

    app.put<{ Params: { groupId: string } }>(
      "/api/v1/groups/:groupId/agent-order",
      async (request) =>
        ReorderGroupAgentsResultSchema.parse(
          await topology.reorderAgents(
            request.params.groupId,
            ReorderGroupAgentsCommandSchema.parse(request.body),
          ),
        ),
    );

    app.post<{ Params: { groupId: string; agentId: string } }>(
      "/api/v1/groups/:groupId/agents/:agentId/run",
      async (request, reply) => {
        const command = StartAgentRunCommandSchema.parse(request.body ?? {});
        const membership = topology.getAgentMembership(
          request.params.groupId,
          request.params.agentId,
        );
        const run = await coordinator.startRun(
          request.params.groupId,
          membership.memberId,
          command,
        );
        return reply.status(201).send(run);
      },
    );

    app.post<{ Params: { groupId: string } }>(
      "/api/v1/groups/:groupId/runs/start-all",
      async (request) => {
        const command = StartGroupRunsCommandSchema.parse(request.body ?? {});
        return StartGroupRunsResultSchema.parse(
          await coordinator.startAll(
            request.params.groupId,
            command,
            idempotencyKey(request.headers),
          ),
        );
      },
    );

    app.delete<{ Params: { groupId: string; agentId: string } }>(
      "/api/v1/groups/:groupId/agents/:agentId/run",
      async (request) => {
        StopAgentRunCommandSchema.parse(request.body ?? {});
        const membership = topology.getAgentMembership(
          request.params.groupId,
          request.params.agentId,
        );
        return coordinator.stopRun(request.params.groupId, membership.memberId);
      },
    );

    app.post<{ Params: { groupId: string } }>(
      "/api/v1/groups/:groupId/messages",
      { bodyLimit: MAX_MESSAGE_REQUEST_BYTES },
      async (request, reply) => {
        const result = messageCommands.submit(
          request.params.groupId,
          request.body as never,
          idempotencyKey(request.headers),
        );
        return reply.status(201).send(result);
      },
    );

    app.get<{
      Params: { groupId: string };
      Querystring: { limit?: string; before?: string; after?: string };
    }>("/api/v1/groups/:groupId/messages", async (request) => {
      const parsePositive = (value: string, name: string): number => {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          throw new DomainError(
            `invalid_message_${name}`,
            `${name} must be a positive integer`,
            400,
          );
        }
        return Number(value);
      };
      return store.listMessagePage(request.params.groupId, {
        ...(request.query.limit === undefined
          ? {}
          : { limit: parsePositive(request.query.limit, "limit") }),
        ...(request.query.before === undefined
          ? {}
          : { before: parsePositive(request.query.before, "cursor") }),
        ...(request.query.after === undefined
          ? {}
          : { after: parsePositive(request.query.after, "cursor") }),
      });
    });

    app.delete<{ Params: { groupId: string } }>(
      "/api/v1/groups/:groupId/messages",
      async (request) =>
        store.clearMessageHistory(request.params.groupId, idempotencyKey(request.headers)),
    );

    app.get<{ Params: { messageId: string } }>(
      "/api/v1/messages/:messageId/deliveries",
      async (request) => store.listDeliveries(request.params.messageId),
    );

    app.get<{ Querystring: { after?: string; instance?: string } }>(
      "/api/v1/events",
      { websocket: true },
      (socket, request) => {
        const afterSequence = parseAfterSequence(request.query.after);
        const session = new EventStreamSession(socket, eventLog, {
          afterSequence,
          ...(request.query.instance === undefined
            ? {}
            : { requestedInstanceId: request.query.instance }),
          instanceId: guard.instanceId,
          daemonEpoch,
        });
        eventSessions.add(session);
        socket.once("close", () => eventSessions.delete(session));
        session.start();
      },
    );

    await registerTerminalProxy(app, terminalEndpoints);

    if (options.servePortal === true) {
      await app.register(fastifyStatic, {
        root: options.portalAssetsPath as string,
        wildcard: true,
      });
      app.setNotFoundHandler((request, reply) => {
        const path = request.url.split("?", 1)[0] ?? request.url;
        const acceptsHtml = request.headers.accept
          ?.split(",")
          .some((value) => ["text/html", "*/*"].includes(value.split(";", 1)[0]?.trim() ?? ""));
        if (
          (request.method === "GET" || request.method === "HEAD") &&
          path !== "/api" &&
          !path.startsWith("/api/") &&
          !path.split("/").at(-1)?.includes(".") &&
          acceptsHtml === true
        ) {
          return reply.sendFile("index.html", { cacheControl: false });
        }
        return reply.status(404).send({ code: "not_found", message: "Route not found" });
      });
    }

    await app.ready();
    lifecycle.markReady();
    return {
      app,
      store,
      runtime,
      coordinator,
      terminalEndpoints,
      ttydSupervisor,
      consoles,
      dispatcher,
      messageCommands,
      topology,
      loadedConfig,
      runtimePath,
      guard,
      lifecycle,
      daemonEpoch,
      operatorAuth,
      bootstrapFragment,
    };
  } catch (error) {
    if (appForCleanup !== undefined) {
      try {
        await appForCleanup.close();
      } catch {
        // Preserve the startup failure while completing direct ownership cleanup below.
      }
    }
    if (lifecycle.state !== "stopped") {
      if (storeForCleanup !== undefined) {
        try {
          storeForCleanup.releaseDaemonEpoch(guard.instanceId);
        } finally {
          storeForCleanup.close();
        }
      }
      lifecycle.markStopped();
      guard.release();
    }
    throw error;
  }
}
