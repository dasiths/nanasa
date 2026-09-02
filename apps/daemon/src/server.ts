import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  MAX_MESSAGE_REQUEST_BYTES,
  MAX_MESSAGE_TEXT_BYTES,
  OVERSIZED_MESSAGE_GUIDANCE,
} from "@nanasa/contracts";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { AgentActionAckService } from "./actions/agent-action-ack-service.js";
import { AgentActionScheduler } from "./actions/agent-action-scheduler.js";
import { AgentActionService } from "./actions/agent-action-service.js";
import { AgentOpenWaitService } from "./actions/agent-open-wait-service.js";
import { AgentWaitService } from "./actions/agent-wait-service.js";
import { AdHocConsoleManager } from "./ad-hoc-console-manager.js";
import { AgentRuntimeProvisioner } from "./agent-runtime-provisioner.js";
import { AgentStatusQueryService } from "./agent-status-query-service.js";
import { registerAgentStatusRoutes } from "./agent-status-routes.js";
import { AgentStatusService } from "./agent-status-service.js";
import { AuthorityPolicy } from "./authority-policy.js";
import { ConfigRepository } from "./config-repository.js";
import { discoverAndLoadNanasaConfig, type LoadedNanasaConfig } from "./config-loader.js";
import { DaemonInstanceGuard } from "./daemon-instance-guard.js";
import { DaemonLifecycle } from "./daemon-lifecycle.js";
import { DeliveryDispatcher } from "./delivery-dispatcher.js";
import { DeliveryRepository } from "./delivery-repository.js";
import { EventLog } from "./event-log.js";
import { EventStreamSession } from "./event-stream-session.js";
import { ExtensionLockRepository } from "./extensions/extension-lock-repository.js";
import { ExtensionPackageError } from "./extensions/extension-package-loader.js";
import { ProviderCatalogService } from "./extensions/provider-catalog-service.js";
import { ProviderExtensionPlanner } from "./extensions/provider-extension-planner.js";
import { ProviderExtensionService } from "./extensions/provider-extension-service.js";
import { ProviderHealthService } from "./extensions/provider-health-service.js";
import { GeneratedOverlayTransaction } from "./generated-overlay-transaction.js";
import { CheckoutService } from "./git/checkout-service.js";
import { GitCommandAdapter } from "./git/git-command-adapter.js";
import { GitStatusService } from "./git/git-status-service.js";
import { RepositoryDiscoveryService } from "./git/repository-discovery-service.js";
import { WorktreeService } from "./git/worktree-service.js";
import { registerControlRouter } from "./http/control-router.js";
import { matchControlRoute } from "./http/route-registry.js";
import { resolveEffectiveAgentPrompt } from "./instruction-resolver.js";
import { McpCredentialIssuer } from "./mcp-auth.js";
import { validateMcpEndpointConfiguration } from "./mcp-config.js";
import { registerMcpRoutes } from "./mcp-server.js";
import { MessageCommandService } from "./message-command-service.js";
import { MessageRepository } from "./message-repository.js";
import { NativeSessionService } from "./native-session-service.js";
import { OperatorAuth } from "./operator-auth.js";
import { controlMetadata, PRODUCT_VERSION, repositoryTmuxNamespace } from "./protocol-metadata.js";
import { ProviderStateRepository } from "./provider-state-repository.js";
import {
  buildTrustedBuiltinClaudeCodePackage,
  buildTrustedBuiltinCopilotPackage,
  buildTrustedBuiltinOpenCodePackage,
  buildTrustedBuiltinPiPackage,
} from "./providers/builtin-provider-packages.js";
import { ProviderBoundRuntimePlanner } from "./providers/provider-bound-runtime-planner.js";
import { ProviderOverlayRepository } from "./providers/provider-overlay-repository.js";
import { ProviderRunBindingRepository } from "./providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "./providers/provider-runtime-index.js";
import { resolveBuiltInProviderEvaluatorOptions } from "./providers/provider-runtime-assets.js";
import { ProviderSnapshotRepository } from "./providers/provider-snapshot-repository.js";
import { ActivationService } from "./release/activation-service.js";
import { createRemoteDescriptorFromMetadata } from "./remote/remote-descriptor.js";
import { ReporterRegistry } from "./reporter-registry.js";
import { RepositoryTrustService } from "./repository-trust-service.js";
import { RunRuntimeCoordinator } from "./run-runtime-coordinator.js";
import { SystemdUserService } from "./service/systemd-user-service.js";
import { SnapshotReadModel } from "./snapshot-read-model.js";
import { DomainError, NanasaStore } from "./store.js";
import { ArtifactPreviewService } from "./terminal/artifact-preview-service.js";
import { TerminalControlService } from "./terminal/terminal-control-service.js";
import { TerminalGateway } from "./terminal/terminal-gateway.js";
import { TerminalInputArbiter } from "./terminal/terminal-input-arbiter.js";
import { TerminalReadService } from "./terminal/terminal-read-service.js";
import { TmuxTerminalDelivery } from "./terminal-delivery.js";
import { TmuxEventObserver, type TmuxInvalidationKind } from "./tmux-event-observer.js";
import { TmuxRuntime } from "./tmux-runtime.js";
import { TopologyOrderService } from "./topology-order-service.js";
import { TopologyService } from "./topology-service.js";
import { UserCredentialBroker } from "./user-credential-broker.js";

export interface DaemonOptions {
  dataPath?: string;
  runtimePath?: string;
  repoRoot?: string;
  loadedConfig?: LoadedNanasaConfig;
  providerStateRoot?: string;
  logger?: boolean | FastifyBaseLogger;
  tmuxServerName?: string;
  tmuxPath?: string;
  gitPath?: string;
  reconcileIntervalMs?: number;
  statusEndpointUrl?: string;
  servePortal?: boolean;
  portalAssetsPath?: string;
  packageRoot?: string;
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
  terminalGateway: TerminalGateway;
  terminalReads: TerminalReadService;
  consoles: AdHocConsoleManager;
  dispatcher: DeliveryDispatcher;
  messageCommands: MessageCommandService;
  actions: AgentActionService;
  actionScheduler: AgentActionScheduler;
  actionWaits: AgentWaitService;
  openWaits: AgentOpenWaitService;
  topology: TopologyService;
  topologyOrder: TopologyOrderService;
  checkouts: CheckoutService;
  worktrees: WorktreeService;
  loadedConfig: LoadedNanasaConfig;
  runtimePath: string;
  guard: DaemonInstanceGuard;
  lifecycle: DaemonLifecycle;
  daemonEpoch: number;
  operatorAuth: OperatorAuth;
  bootstrapFragment: string;
  providerStates: ProviderStateRepository;
  nativeSessions: NativeSessionService;
  extensions: ProviderExtensionService;
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
    new ActivationService().recoverIncomplete(runtimePath, [loadedConfig.repoRoot]);
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
    const git = new GitCommandAdapter(options.gitPath);
    const repositoryDiscovery = new RepositoryDiscoveryService(git);
    const gitStatuses = new GitStatusService(git);
    const checkouts = new CheckoutService(store, repositoryDiscovery, gitStatuses);
    const repositoryCheckout = await checkouts.initialize(loadedConfig.config.repository.path);
    const worktrees = new WorktreeService(
      store,
      git,
      checkouts,
      join(dirname(loadedConfig.repoRoot), ".nanasa-worktrees"),
    );
    await worktrees.recover();
    const bootstrapFragment = `nanasa-bootstrap=${operatorAuth.createBootstrapToken()}`;
    const metadata = () =>
      controlMetadata({
        repositoryRoot: loadedConfig.repoRoot,
        repositoryId: repositoryCheckout.repository.id,
        guard,
        daemonEpoch,
        lifecycle,
      });
    const systemdService = new SystemdUserService({
      repositoryRoot: loadedConfig.repoRoot,
      packageRoot: options.packageRoot ?? process.env.NANASA_PACKAGE_ROOT ?? loadedConfig.repoRoot,
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
    const tmuxInvalidationUrl = new URL("/api/v1/internal/tmux-invalidation", statusEndpoint);
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
    const mcpCredentials = new McpCredentialIssuer(store, {
      secretPath:
        options.mcp?.secretPath ??
        join(dataPath === ":memory:" ? runtimePath : dirname(dataPath), "mcp-secret"),
      ...(options.mcp?.operatorToken === undefined
        ? {}
        : { operatorToken: options.mcp.operatorToken }),
    });
    const extensionLocks = new ExtensionLockRepository(loadedConfig.repoRoot);
    const providerCatalog = new ProviderCatalogService();
    const extensionPlanner = new ProviderExtensionPlanner();
    const extensionConfig = () => {
      const current = configRepository.load();
      if (current.status.revision === undefined) {
        throw new ExtensionPackageError(
          "extension_config_unavailable",
          "A valid configuration revision is required for extension operations",
        );
      }
      return { config: current.config, revision: current.status.revision };
    };
    const providerHealth = new ProviderHealthService(
      extensionLocks,
      extensionConfig,
      PRODUCT_VERSION,
    );
    const repositoryIdentity = createHash("sha256").update(loadedConfig.repoRoot).digest("hex");
    const extensions = new ProviderExtensionService(
      extensionLocks,
      providerCatalog,
      extensionPlanner,
      providerHealth,
      extensionConfig,
      store,
      repositoryIdentity,
    );
    extensions.initializeBuiltIns();
    const providerSnapshots = new ProviderSnapshotRepository(store.database);
    const providerRuntimeIndex = new ProviderRuntimeIndex(store.database, providerSnapshots);
    const builtInProviderPackages = await Promise.all([
      buildTrustedBuiltinCopilotPackage(),
      buildTrustedBuiltinPiPackage(),
      buildTrustedBuiltinOpenCodePackage(),
      buildTrustedBuiltinClaudeCodePackage(),
    ]);
    for (const builtInProviderPackage of builtInProviderPackages) {
      await providerRuntimeIndex.registerTrustedBuiltin(builtInProviderPackage);
    }
    const evaluatorOptions = resolveBuiltInProviderEvaluatorOptions(builtInProviderPackages);
    const providerBindings = new ProviderRunBindingRepository(
      store.database,
      providerRuntimeIndex,
      providerSnapshots,
    );
    const providerStates = new ProviderStateRepository(
      options.providerStateRoot ?? loadedConfig.integrationsDirectory,
      store,
    );
    const generatedOverlays = new GeneratedOverlayTransaction(loadedConfig.integrationsDirectory);
    const providerOverlays = new ProviderOverlayRepository(store.database, generatedOverlays);
    const providerRuntimePlanner = new ProviderBoundRuntimePlanner(
      providerBindings,
      providerOverlays,
      evaluatorOptions,
    );
    const credentialBroker = new UserCredentialBroker();
    const repositoryTrust = new RepositoryTrustService(store);
    const nativeSessions = new NativeSessionService(store);
    const statusQueries = new AgentStatusQueryService(store);
    const coordinatorReference: { current?: RunRuntimeCoordinator } = {};
    const tmuxServerName = options.tmuxServerName ?? repositoryTmuxNamespace(loadedConfig.repoRoot);
    const tmuxEvents = new TmuxEventObserver(tmuxServerName, () => {
      void coordinatorReference.current?.reconcile().catch(() => undefined);
    });
    const runtimeProvisioner = new AgentRuntimeProvisioner({
      integrationsDirectory: loadedConfig.integrationsDirectory,
      integrations: Object.fromEntries(
        Object.entries(loadedConfig.config.integrations).map(([key, integration]) => [
          key,
          {
            providerState: integration.providerState,
            credentials: integration.credentials,
            model: integration.model,
            nativeRecovery: integration.nativeRecovery,
          },
        ]),
      ),
      statusEndpointUrl,
      ...(options.mcp?.enabled === true ? { mcpEndpointUrl } : {}),
      repositoryIdentity,
      planner: providerRuntimePlanner,
      bindings: providerBindings,
      evaluatorOptions,
      stateRepository: providerStates,
      credentialBroker,
      trustService: repositoryTrust,
      assertProviderExtension: (kind) => extensions.assertProviderKind(kind),
      promptResolver: (membership) => {
        const current = configRepository.load();
        return resolveEffectiveAgentPrompt({
          repoRoot: current.repoRoot,
          config: current.config,
          groupId: membership.groupId,
          agentId: membership.id,
        });
      },
      desiredModelResolver: (membership) => {
        const current = configRepository.load();
        return current.config.groups[membership.groupId]?.agents[membership.id]?.desiredModel;
      },
    });
    const reporterRegistry = new ReporterRegistry(store, {
      runtimeDirectory: runtimePath,
      authority: runtimeProvisioner,
    });
    const statusService = new AgentStatusService(store, reporterRegistry);
    const runtime = new TmuxRuntime(store, {
      serverName: tmuxServerName,
      ...(options.tmuxPath === undefined ? {} : { tmuxPath: options.tmuxPath }),
      runtimeProvisioner,
      invalidationHooks: {
        "pane-died": tmuxEvents.hookCommand(tmuxInvalidationUrl.toString(), "pane_died"),
        "pane-exited": tmuxEvents.hookCommand(tmuxInvalidationUrl.toString(), "pane_exited"),
        "after-select-pane": tmuxEvents.hookCommand(
          tmuxInvalidationUrl.toString(),
          "pane_mode_changed",
        ),
        "alert-bell": tmuxEvents.hookCommand(tmuxInvalidationUrl.toString(), "bell"),
      },
      runtimeEnvironment: async (run) => ({
        ...(options.mcp?.enabled === true ? { NANASA_MCP_URL: mcpEndpointUrl } : {}),
        NANASA_MCP_TOKEN: mcpCredentials.issueAgent(run),
        NANASA_STATUS_URL: statusEndpointUrl,
        ...(await reporterRegistry.environment(run)),
      }),
    });
    const terminalControl = new TerminalControlService(store);
    const terminalInput = new TerminalInputArbiter(terminalControl);
    const terminalReads = new TerminalReadService(
      store,
      runtime,
      join(runtimePath, "terminal-checkpoints"),
      loadedConfig.config.terminal.checkpoints,
    );
    const terminalGateway = new TerminalGateway(
      terminalControl,
      terminalReads,
      daemonEpoch,
      options.tmuxPath ?? "tmux",
      terminalInput,
    );
    const artifactPreviews = new ArtifactPreviewService(loadedConfig.repoRoot);
    const terminalDelivery = new TmuxTerminalDelivery(runtime, terminalInput);
    const consoles = new AdHocConsoleManager(runtime, terminalGateway, loadedConfig.repoRoot);
    const deliveries = new DeliveryRepository(store);
    const messages = new MessageRepository(store);
    const dispatcher = new DeliveryDispatcher(store, deliveries, terminalDelivery);
    const messageCommands = new MessageCommandService(messages);
    const actions = new AgentActionService(store, daemonEpoch);
    const actionScheduler = new AgentActionScheduler(store, runtime, terminalInput);
    const actionAcks = new AgentActionAckService(store);
    const actionWaits = new AgentWaitService(store);
    const openWaits = new AgentOpenWaitService(store, runtime, terminalInput, runtimeProvisioner);
    const coordinator = new RunRuntimeCoordinator(store, runtime, terminalGateway, dispatcher, {
      ...(options.reconcileIntervalMs === undefined
        ? {}
        : { reconcileIntervalMs: options.reconcileIntervalMs }),
      nativeSessions,
      onRuntimeObservation: (observation) => statusService.observeRuntime(observation),
      nativeRecoveryPolicy: (run) => {
        const profile = store.getAgentProfile(run.agentProfileId);
        const integration = loadedConfig.config.integrations[profile.agentType];
        if (integration === undefined) throw new Error(`Missing integration ${profile.agentType}`);
        return { integrationId: profile.agentType, policy: integration.nativeRecovery };
      },
    });
    coordinatorReference.current = coordinator;
    const topology = new TopologyService(configRepository, store, coordinator);
    const topologyOrder = new TopologyOrderService(configRepository, store);
    await topology.reconcile();

    await app.register(websocket);
    await coordinator.reconcile(true);
    coordinator.start();
    actionScheduler.start();

    app.addHook("onRequest", async (request, reply) => {
      const path = requestPath(request.url);
      if (!path.startsWith("/api/v1")) return;
      authorityPolicy.validate(request);
      if (path.startsWith("/api/v1")) {
        reply.header("X-Nanasa-API-Version", "1");
        reply.header("X-Request-Id", request.id);
      }
    });

    app.addHook("preHandler", async (request) => {
      const path = requestPath(request.url);
      const declaration = matchControlRoute(request.method, path);
      if (declaration === undefined || declaration.principal === "public") return;
      operatorAuth.authorize(request);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        lifecycle.assertMutationAllowed();
      }
    });

    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ code: error.code, message: error.message });
      }
      if (error instanceof ExtensionPackageError) {
        const statusCode = error.code.includes("not_found")
          ? 404
          : error.code.includes("trust_required") || error.code.includes("signature_untrusted")
            ? 403
            : error.code.includes("stale") ||
                error.code.includes("busy") ||
                error.code.includes("active_runs") ||
                error.code.includes("referenced")
              ? 409
              : 400;
        return reply.status(statusCode).send({ code: error.code, message: error.message });
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
      await actionScheduler.close();
      await coordinator.close();
    });

    app.addHook("onClose", async () => {
      store.releaseDaemonEpoch(guard.instanceId);
      store.close();
      lifecycle.markStopped();
      guard.release();
    });

    app.get("/health", async () => ({ status: "ok" }));
    app.get("/health/live", async () => ({ status: "live" }));
    app.get("/health/ready", async (_request, reply) => {
      if (lifecycle.state !== "ready") return reply.status(503).send({ status: lifecycle.state });
      return {
        status: "ready",
        repositoryId: metadata().repositoryId,
        instanceId: guard.instanceId,
        daemonEpoch,
        databaseSchemaVersion: metadata().databaseSchemaVersion,
        productVersion: PRODUCT_VERSION,
      };
    });
    app.post(
      "/api/v1/internal/tmux-invalidation",
      { bodyLimit: 2 * 1024 },
      async (request, reply) => {
        const authorization = request.headers.authorization;
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
        const body = request.body as Partial<{
          serverName: string;
          kind: TmuxInvalidationKind;
          paneId: string;
          windowId: string;
          sessionId: string;
        }>;
        if (body.serverName !== tmuxServerName || body.kind === undefined) {
          throw new DomainError("tmux_invalidation_invalid", "Tmux invalidation is invalid", 400);
        }
        try {
          tmuxEvents.notify(token, {
            serverName: body.serverName,
            kind: body.kind,
            ...(body.paneId === undefined ? {} : { paneId: body.paneId }),
            ...(body.windowId === undefined ? {} : { windowId: body.windowId }),
            ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
          });
        } catch {
          throw new DomainError(
            "tmux_invalidation_unauthorized",
            "Tmux invalidation is unauthorized",
            401,
          );
        }
        return reply.status(204).send();
      },
    );
    registerAgentStatusRoutes(app, {
      path: "/api/v1/agent-status/events",
      allowedHostnames: [statusEndpoint.hostname],
      credentials: mcpCredentials,
      store,
      statusService,
      nativeSessions,
      runtimeProvisioner,
      actionAcks,
    });
    if (options.mcp?.enabled === true) {
      registerMcpRoutes(app, {
        path: mcpPath,
        endpointUrl: mcpEndpointUrl,
        allowedHostnames: options.mcp?.allowedHostnames ?? [mcpEndpoint.hostname],
        credentials: mcpCredentials,
        store,
        messages: messageCommands,
        messageHistory: messages,
        deliveries,
        actions,
        actionWaits,
        openWaits,
      });
    }
    registerControlRouter(app, {
      service: () => systemdService.status(),
      remote: () => createRemoteDescriptorFromMetadata(metadata(), systemdService.status()),
      metadata,
      config: configRepository,
      snapshot: snapshotReadModel,
      store,
      auth: operatorAuth,
      providerStates,
      extensions,
      extensionHealth: providerHealth,
      topology,
      topologyOrder,
      coordinator,
      statuses: statusQueries,
      messages,
      messageCommands,
      deliveries,
      actions,
      actionScheduler,
      actionWaits,
      openWaits,
      terminalGateway,
      terminalReads,
      consoles,
      checkouts,
      worktrees,
      artifactPreviews,
      eventLog,
      eventSessions,
      instanceId: guard.instanceId,
      daemonEpoch,
    });

    terminalGateway.register(app);

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
      terminalGateway,
      terminalReads,
      consoles,
      dispatcher,
      messageCommands,
      actions,
      actionScheduler,
      actionWaits,
      openWaits,
      topology,
      topologyOrder,
      checkouts,
      worktrees,
      loadedConfig,
      runtimePath,
      guard,
      lifecycle,
      daemonEpoch,
      operatorAuth,
      bootstrapFragment,
      providerStates,
      nativeSessions,
      extensions,
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
