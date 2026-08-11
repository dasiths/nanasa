import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  AddGroupMembershipCommandSchema,
  MAX_MESSAGE_REQUEST_BYTES,
  MAX_MESSAGE_TEXT_BYTES,
  OVERSIZED_MESSAGE_GUIDANCE,
  CreateAgentProfileCommandSchema,
  CreateGroupCommandSchema,
  DeleteGroupResultSchema,
  InterruptAgentRunCommandSchema,
  StartAgentRunCommandSchema,
  StartGroupRunsCommandSchema,
  StartGroupRunsResultSchema,
  StopAgentRunCommandSchema,
  TerminalEndpointStatusSchema,
  UpdateAgentProfileCommandSchema,
  UpdateGroupCommandSchema,
  UpdateGroupMembershipCommandSchema,
} from "@nanasa/contracts";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { AgentRuntimeProvisioner } from "./agent-runtime-provisioner.js";
import { registerAgentStatusRoutes } from "./agent-status-routes.js";
import { discoverAndLoadNanasaConfig, type LoadedNanasaConfig } from "./config.js";
import { ConfigRepository } from "./config-repository.js";
import { DeliveryDispatcher } from "./delivery-dispatcher.js";
import { resolveEffectiveAgentPrompt } from "./instruction-resolver.js";
import { McpCredentialIssuer } from "./mcp-auth.js";
import { validateMcpEndpointConfiguration } from "./mcp-config.js";
import { registerMcpRoutes } from "./mcp-server.js";
import { MessageCommandService } from "./message-command-service.js";
import { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
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
  dispatcher: DeliveryDispatcher;
  messageCommands: MessageCommandService;
  topology: TopologyService;
  loadedConfig: LoadedNanasaConfig;
  runtimePath: string;
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

export async function createDaemon(options: DaemonOptions): Promise<DaemonContext> {
  if (options.servePortal === true && options.portalAssetsPath === undefined) {
    throw new Error("portalAssetsPath is required when servePortal is enabled");
  }
  let loadedConfig =
    options.loadedConfig ?? discoverAndLoadNanasaConfig(options.repoRoot ?? process.cwd());
  const dataPath = options.dataPath ?? loadedConfig.dataPath;
  const runtimePath =
    options.runtimePath ??
    (options.dataPath !== undefined && options.dataPath !== ":memory:"
      ? join(dirname(options.dataPath), "runtime")
      : loadedConfig.runtimeDirectory);
  mkdirSync(runtimePath, { recursive: true });
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  const store = new NanasaStore(dataPath, {
    config: loadedConfig.config,
    configStatus: loadedConfig.status,
  });
  const configRepository = new ConfigRepository(loadedConfig.repoRoot);
  loadedConfig = configRepository.initializeTopology(store.getSnapshot());
  const mcpPath = options.mcp?.path ?? "/mcp";
  if (!/^\/[A-Za-z0-9/_-]*$/.test(mcpPath) || mcpPath.includes("//")) {
    throw new Error("MCP path must be an absolute URL path");
  }
  const mcpEndpointUrl = options.mcp?.endpointUrl ?? `http://127.0.0.1:3210${mcpPath}`;
  const statusEndpointUrl =
    options.statusEndpointUrl ?? "http://127.0.0.1:3210/api/agent-status/events";
  const statusEndpoint = new URL(statusEndpointUrl);
  if (
    statusEndpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(statusEndpoint.hostname) ||
    statusEndpoint.pathname !== "/api/agent-status/events" ||
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
    ...(options.tmuxServerName === undefined ? {} : { serverName: options.tmuxServerName }),
    ...(options.tmuxPath === undefined ? {} : { tmuxPath: options.tmuxPath }),
    ...(mcpCredentials === undefined
      ? {}
      : {
          runtimeProvisioner: new AgentRuntimeProvisioner({
            integrationsDirectory: loadedConfig.integrationsDirectory,
            agentConfigHomes: Object.fromEntries(
              Object.entries(loadedConfig.config.agentTypes).map(([key, agentType]) => [
                key,
                agentType.agentConfigHome,
              ]),
            ),
            mcpEndpointUrl,
            promptResolver: (membership, profile) => {
              const current = configRepository.load();
              return resolveEffectiveAgentPrompt({
                repoRoot: current.repoRoot,
                config: current.config,
                profileId: profile.id,
                groupId: membership.groupId,
                membershipId: membership.id,
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
    await coordinator.close();
  });

  app.addHook("onClose", async () => {
    store.close();
  });

  app.get("/health", async () => ({ status: "ok" }));
  if (mcpCredentials !== undefined) {
    registerAgentStatusRoutes(app, {
      path: "/api/agent-status/events",
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
  app.get("/api/config", async () => configRepository.load().config);
  app.get("/api/config/status", async () => configRepository.load().status);
  app.get("/api/snapshot", async () => ({
    ...store.getSnapshot(),
    messages: [],
    deliveryOutcomes: [],
  }));
  app.get<{ Params: { runId: string } }>("/api/runs/:runId/terminal", async (request) =>
    TerminalEndpointStatusSchema.parse(terminalEndpoints.status(request.params.runId)),
  );
  app.post<{ Params: { runId: string } }>("/api/runs/:runId/interrupt", async (request, reply) => {
    InterruptAgentRunCommandSchema.parse(request.body);
    await coordinator.interrupt(request.params.runId);
    return reply.status(204).send();
  });

  app.post("/api/groups", async (request, reply) => {
    const group = await topology.createGroup(
      CreateGroupCommandSchema.parse(request.body),
      idempotencyKey(request.headers),
    );
    return reply.status(201).send(group);
  });

  app.patch<{ Params: { groupId: string } }>("/api/groups/:groupId", async (request) =>
    topology.updateGroup(request.params.groupId, UpdateGroupCommandSchema.parse(request.body)),
  );

  app.delete<{ Params: { groupId: string } }>("/api/groups/:groupId", async (request) =>
    DeleteGroupResultSchema.parse(
      await topology.deleteGroup(request.params.groupId, idempotencyKey(request.headers)),
    ),
  );

  app.post("/api/agent-profiles", async (request, reply) => {
    const profile = await topology.createAgentProfile(
      CreateAgentProfileCommandSchema.parse(request.body),
      idempotencyKey(request.headers),
    );
    return reply.status(201).send(profile);
  });

  app.patch<{ Params: { profileId: string } }>("/api/agent-profiles/:profileId", async (request) =>
    topology.updateAgentProfile(
      request.params.profileId,
      UpdateAgentProfileCommandSchema.parse(request.body),
    ),
  );

  app.post<{ Params: { groupId: string } }>(
    "/api/groups/:groupId/memberships",
    async (request, reply) => {
      const membership = await topology.addMembership(
        request.params.groupId,
        AddGroupMembershipCommandSchema.parse(request.body),
        idempotencyKey(request.headers),
      );
      return reply.status(201).send(membership);
    },
  );

  app.delete<{ Params: { groupId: string; memberId: string } }>(
    "/api/groups/:groupId/memberships/:memberId",
    async (request) =>
      topology.removeMembership(
        request.params.groupId,
        request.params.memberId,
        idempotencyKey(request.headers),
      ),
  );

  app.patch<{ Params: { groupId: string; memberId: string } }>(
    "/api/groups/:groupId/memberships/:memberId",
    async (request) =>
      topology.updateMembership(
        request.params.groupId,
        request.params.memberId,
        UpdateGroupMembershipCommandSchema.parse(request.body),
      ),
  );

  app.post<{ Params: { groupId: string; memberId: string } }>(
    "/api/groups/:groupId/memberships/:memberId/run",
    async (request, reply) => {
      const command = StartAgentRunCommandSchema.parse(request.body ?? {});
      const run = await coordinator.startRun(
        request.params.groupId,
        request.params.memberId,
        command,
      );
      return reply.status(201).send(run);
    },
  );

  app.post<{ Params: { groupId: string } }>(
    "/api/groups/:groupId/runs/start-all",
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

  app.delete<{ Params: { groupId: string; memberId: string } }>(
    "/api/groups/:groupId/memberships/:memberId/run",
    async (request) => {
      StopAgentRunCommandSchema.parse(request.body ?? {});
      return coordinator.stopRun(request.params.groupId, request.params.memberId);
    },
  );

  app.post<{ Params: { groupId: string } }>(
    "/api/groups/:groupId/messages",
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
  }>("/api/groups/:groupId/messages", async (request) => {
    const parsePositive = (value: string, name: string): number => {
      if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw new DomainError(`invalid_message_${name}`, `${name} must be a positive integer`, 400);
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

  app.delete<{ Params: { groupId: string } }>("/api/groups/:groupId/messages", async (request) =>
    store.clearMessageHistory(request.params.groupId, idempotencyKey(request.headers)),
  );

  app.get<{ Params: { messageId: string } }>(
    "/api/messages/:messageId/deliveries",
    async (request) => store.listDeliveries(request.params.messageId),
  );

  app.get<{ Querystring: { after?: string } }>(
    "/api/events",
    { websocket: true },
    (socket, request) => {
      const afterSequence = parseAfterSequence(request.query.after);
      for (const event of store.listEvents(afterSequence)) {
        socket.send(JSON.stringify(event));
      }
      const unsubscribe = store.onEvent((event) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(event));
        }
      });
      socket.once("close", unsubscribe);
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
  return {
    app,
    store,
    runtime,
    coordinator,
    terminalEndpoints,
    ttydSupervisor,
    dispatcher,
    messageCommands,
    topology,
    loadedConfig,
    runtimePath,
  };
}
