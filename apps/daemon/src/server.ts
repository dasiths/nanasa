import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  AgentAdapterStatusSchema,
  EffectiveDeliveryModesCommandSchema,
  EffectiveDeliveryModesSchema,
  InterruptAgentRunCommandSchema,
  StartAgentRunCommandSchema,
  StartGroupRunsCommandSchema,
  StartGroupRunsResultSchema,
  StopAgentRunCommandSchema,
  TerminalEndpointStatusSchema,
} from "@nanasa/contracts";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import { AgentRuntimeSupervisor, type AgentAdapterFactories } from "./agent-runtime-supervisor.js";
import { discoverAndLoadNanasaConfig, type LoadedNanasaConfig } from "./config.js";
import { CopilotCliAdapter } from "./copilot-cli-adapter.js";
import { copilotCliWorkerSocketPath } from "./copilot-cli-worker-protocol.js";
import { DeliveryDispatcher } from "./delivery-dispatcher.js";
import { PiRpcAdapter } from "./pi-rpc-adapter.js";
import { piSessionDirectory, piWorkerSocketPath } from "./pi-rpc-worker-protocol.js";
import { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
import { DomainError, NanasaStore } from "./store.js";
import { TerminalAdapter, TmuxTerminalDelivery } from "./terminal-adapter.js";
import { TerminalEndpointRegistry } from "./terminal-endpoint-registry.js";
import { registerTerminalProxy } from "./terminal-proxy.js";
import { TmuxRuntime } from "./tmux-runtime.js";
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
  servePortal?: boolean;
  portalAssetsPath?: string;
  adapterFactories?: AgentAdapterFactories;
}

export interface DaemonContext {
  app: FastifyInstance;
  store: NanasaStore;
  runtime: TmuxRuntime;
  coordinator: RunRuntimeCoordinator;
  terminalEndpoints: TerminalEndpointRegistry;
  ttydSupervisor: TtydSupervisor;
  agentSupervisor: AgentRuntimeSupervisor;
  dispatcher: DeliveryDispatcher;
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
  const loadedConfig =
    options.loadedConfig ?? discoverAndLoadNanasaConfig(options.repoRoot ?? process.cwd());
  const dataPath = options.dataPath ?? loadedConfig.dataPath;
  const runtimePath =
    options.runtimePath ??
    (options.dataPath !== undefined && options.dataPath !== ":memory:"
      ? join(dirname(options.dataPath), "runtime")
      : loadedConfig.runtimeDirectory);
  mkdirSync(runtimePath, { recursive: true });
  const app = Fastify({ logger: options.logger ?? false });
  const store = new NanasaStore(dataPath, {
    config: loadedConfig.config,
    configStatus: loadedConfig.status,
  });
  const compiledWorkerPath = fileURLToPath(new URL("./pi-rpc-worker.js", import.meta.url));
  const sourceWorkerPath = fileURLToPath(new URL("./pi-rpc-worker.ts", import.meta.url));
  const piWorkerCommand = existsSync(compiledWorkerPath)
    ? [process.execPath, compiledWorkerPath]
    : [process.execPath, ...process.execArgv, sourceWorkerPath];
  const compiledCopilotWorkerPath = fileURLToPath(
    new URL("./copilot-cli-worker.js", import.meta.url),
  );
  const sourceCopilotWorkerPath = fileURLToPath(
    new URL("./copilot-cli-worker.ts", import.meta.url),
  );
  const copilotCliWorkerCommand = existsSync(compiledCopilotWorkerPath)
    ? [process.execPath, compiledCopilotWorkerPath]
    : [process.execPath, ...process.execArgv, sourceCopilotWorkerPath];
  const runtime = new TmuxRuntime(store, {
    ...(options.tmuxServerName === undefined ? {} : { serverName: options.tmuxServerName }),
    ...(options.tmuxPath === undefined ? {} : { tmuxPath: options.tmuxPath }),
    runtimePath,
    statePath: loadedConfig.stateDirectory,
    piWorkerCommand,
    copilotCliWorkerCommand,
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
  const agentSupervisor = new AgentRuntimeSupervisor(
    {
      terminal: (context) => new TerminalAdapter(context, terminalDelivery),
      "pi-rpc": (context) => {
        const sessionDirectory = piSessionDirectory(
          loadedConfig.stateDirectory,
          context.run.memberId,
        );
        return new PiRpcAdapter(context, {
          socketPath: piWorkerSocketPath(runtimePath, context.run),
          sessionDirectory,
          persistSession: (session) => {
            store.updateRunAdapterSession(context.run.id, context.run.generation, session);
          },
          settleDeliveries: (adapterMessageIds) => {
            store.settleRunDeliveries(context.run.id, context.run.generation, adapterMessageIds);
          },
        });
      },
      "copilot-cli": (context) =>
        new CopilotCliAdapter(context, {
          socketPath: copilotCliWorkerSocketPath(runtimePath, context.run),
          persistSession: (adapterSessionId) => {
            store.updateRunAdapterSession(context.run.id, context.run.generation, {
              adapter: "copilot-cli",
              adapterSessionId,
            });
          },
          settleDeliveries: (adapterMessageIds, settlement) => {
            store.settleRunDeliveries(
              context.run.id,
              context.run.generation,
              adapterMessageIds,
              settlement,
            );
          },
        }),
      ...options.adapterFactories,
    },
    terminalDelivery,
  );
  const dispatcher = new DeliveryDispatcher(store, agentSupervisor);
  const coordinator = new RunRuntimeCoordinator(
    store,
    runtime,
    ttydSupervisor,
    agentSupervisor,
    dispatcher,
    {
      ...(options.reconcileIntervalMs === undefined
        ? {}
        : { reconcileIntervalMs: options.reconcileIntervalMs }),
    },
  );

  await app.register(websocket);
  await coordinator.reconcile(true);
  coordinator.start();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (isValidationError(error)) {
      return reply.status(400).send({
        code: "validation_error",
        message: "Request validation failed",
        issues: error.issues,
      });
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
  app.get("/api/config", async () => loadedConfig.config);
  app.get("/api/config/status", async () => loadedConfig.status);
  app.get("/api/snapshot", async () => store.getSnapshot());
  app.get<{ Params: { runId: string } }>("/api/runs/:runId/terminal", async (request) =>
    TerminalEndpointStatusSchema.parse(terminalEndpoints.status(request.params.runId)),
  );
  app.get<{ Params: { runId: string } }>("/api/runs/:runId/adapter", async (request) =>
    AgentAdapterStatusSchema.parse(coordinator.adapterStatus(request.params.runId)),
  );
  app.post<{ Params: { runId: string } }>("/api/runs/:runId/interrupt", async (request, reply) => {
    InterruptAgentRunCommandSchema.parse(request.body);
    await coordinator.interrupt(request.params.runId);
    return reply.status(204).send();
  });

  app.post("/api/groups", async (request, reply) => {
    const group = store.createGroup(request.body as never, idempotencyKey(request.headers));
    return reply.status(201).send(group);
  });

  app.post("/api/agent-profiles", async (request, reply) => {
    const profile = store.createAgentProfile(
      request.body as never,
      idempotencyKey(request.headers),
    );
    return reply.status(201).send(profile);
  });

  app.post<{ Params: { groupId: string } }>(
    "/api/groups/:groupId/memberships",
    async (request, reply) => {
      const membership = store.addMembership(
        request.params.groupId,
        request.body as never,
        idempotencyKey(request.headers),
      );
      return reply.status(201).send(membership);
    },
  );

  app.delete<{ Params: { groupId: string; memberId: string } }>(
    "/api/groups/:groupId/memberships/:memberId",
    async (request) =>
      coordinator.removeMembership(
        request.params.groupId,
        request.params.memberId,
        idempotencyKey(request.headers),
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
    async (request, reply) => {
      const result = store.submitMessage(
        request.params.groupId,
        request.body as never,
        idempotencyKey(request.headers),
      );
      return reply.status(201).send(result);
    },
  );

  app.post<{ Params: { groupId: string } }>(
    "/api/groups/:groupId/delivery-modes",
    async (request) => {
      const command = EffectiveDeliveryModesCommandSchema.parse(request.body);
      return EffectiveDeliveryModesSchema.parse(
        await coordinator.effectiveDeliveryModes(request.params.groupId, command.memberIds),
      );
    },
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
    agentSupervisor,
    dispatcher,
    loadedConfig,
    runtimePath,
  };
}
