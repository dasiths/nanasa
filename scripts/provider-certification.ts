import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadNanasaConfig } from "../apps/daemon/src/config-loader.js";
import { ProviderAdapterRegistry } from "../apps/daemon/src/providers/provider-adapter-registry.js";
import { createDaemon } from "../apps/daemon/src/server.js";
import {
  type AgentKind,
  type AgentStatusDetail,
  type OpenWait,
  OpenWaitReplySchema,
} from "../packages/contracts/src/index.js";

const profiles = {
  copilot: { executable: "copilot", credential: "COPILOT_GITHUB_TOKEN" },
  "claude-code": { executable: "claude", credential: "ANTHROPIC_API_KEY" },
  opencode: { executable: "opencode", credential: "OPENAI_API_KEY" },
  pi: { executable: "pi", credential: "ANTHROPIC_API_KEY" },
} as const satisfies Record<AgentKind, { executable: string; credential: string }>;

const providerId = process.argv[2] as AgentKind;
const profile = profiles[providerId];
if (profile === undefined) throw new Error("Unknown built-in provider certification profile");
const authMode = process.env.NANASA_CERT_AUTH_MODE ?? "environment";
const usesProviderHome = authMode === "provider-home";
if (!usesProviderHome && !process.env[profile.credential]) {
  throw new Error("Provider credential is unavailable");
}
const integrationId = usesProviderHome ? process.env.NANASA_CERT_INTEGRATION_ID : "certification";
if (integrationId === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(integrationId)) {
  throw new Error("Local certification integration ID is missing or invalid");
}
const providerStateScope = usesProviderHome
  ? process.env.NANASA_CERT_PROVIDER_STATE_SCOPE
  : "membership";
const certificationAgentId = usesProviderHome
  ? (process.env.NANASA_CERT_AGENT_ID ?? "certification-agent")
  : undefined;
if (providerStateScope !== "integration" && providerStateScope !== "membership") {
  throw new Error("Local certification provider state scope is missing or unsupported");
}
if (
  certificationAgentId !== undefined &&
  !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(certificationAgentId)
) {
  throw new Error("Local certification agent ID is invalid");
}
const persistentIntegrationsDirectory = usesProviderHome
  ? process.env.NANASA_CERT_INTEGRATIONS_DIRECTORY
  : undefined;
const configuredCommand = usesProviderHome
  ? JSON.parse(process.env.NANASA_CERT_PROVIDER_COMMAND_JSON ?? "null")
  : [profile.executable];
const configuredCwd = usesProviderHome ? process.env.NANASA_CERT_PROVIDER_CWD : undefined;
const configuredModel = usesProviderHome
  ? JSON.parse(process.env.NANASA_CERT_MODEL_POLICY_JSON ?? "null")
  : { resumePolicy: "preserve-session" };
if (
  !Array.isArray(configuredCommand) ||
  configuredCommand.length === 0 ||
  configuredCommand.some(
    (part) => typeof part !== "string" || part.length === 0 || part.length > 4_096,
  )
) {
  throw new Error("Local certification provider command is missing or invalid");
}
if (
  usesProviderHome &&
  (configuredCwd === undefined ||
    !isAbsolute(configuredCwd) ||
    !existsSync(configuredCwd) ||
    !lstatSync(configuredCwd).isDirectory())
) {
  throw new Error("Local certification provider working directory is missing or invalid");
}
if (
  configuredModel === null ||
  typeof configuredModel !== "object" ||
  Array.isArray(configuredModel)
) {
  throw new Error("Local certification model policy is missing or invalid");
}
const configuredGroups = usesProviderHome
  ? `
  certification:
    name: Certification
    instructions: []
    agents:
      ${certificationAgentId}:
        memberId: certification.agent
        name: Certified provider
        integrationId: ${integrationId}
        instructions: []`
  : "{}";
if (usesProviderHome) {
  if (
    persistentIntegrationsDirectory === undefined ||
    !isAbsolute(persistentIntegrationsDirectory) ||
    !existsSync(persistentIntegrationsDirectory)
  ) {
    throw new Error("Local certification integrations directory is unavailable");
  }
  const status = lstatSync(persistentIntegrationsDirectory);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw new Error(
      "Local certification integrations directory must be private and owner-controlled",
    );
  }
}
const adapter = ProviderAdapterRegistry.builtIn().get(providerId);
const reporterEvents = new Set(adapter.reporter.events);
const certificationLevel = process.env.NANASA_CERT_LEVEL ?? "full";
if (certificationLevel !== "smoke" && certificationLevel !== "full") {
  throw new Error("Provider certification level must be smoke or full");
}
const certifiesWaits =
  certificationLevel === "full" &&
  reporterEvents.has("wait.opened") &&
  reporterEvents.has("wait.closed");

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate provider certification port"));
        return;
      }
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const root = mkdtempSync(join(tmpdir(), `nanasa-provider-cert-${providerId}-`));
const repository = join(root, "repository");
const home = join(root, "home");
mkdirSync(repository, { recursive: true });
mkdirSync(join(repository, ".nanasa"), { recursive: true, mode: 0o700 });
mkdirSync(join(home, ".config", "nanasa"), { recursive: true, mode: 0o700 });
const launcherDirectory = join(root, "bin");
const usesPathCwdShim =
  usesProviderHome &&
  configuredCommand[0] !== profile.executable &&
  !configuredCommand[0]!.includes("/") &&
  !configuredCommand[0]!.includes("\\");
const previousPath = process.env.PATH;
if (usesPathCwdShim) {
  mkdirSync(launcherDirectory, { recursive: true, mode: 0o700 });
  const executable = execFileSync("which", [configuredCommand[0]!], { encoding: "utf8" }).trim();
  writeFileSync(
    join(launcherDirectory, configuredCommand[0]!),
    `#!/bin/sh
cd ${shellQuote(configuredCwd!)} || exit 1
exec ${shellQuote(executable)} "$@"
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${launcherDirectory}:${previousPath ?? ""}`;
}
execFileSync("git", ["init", "--quiet", repository]);
execFileSync(
  "git",
  [
    "-C",
    repository,
    "-c",
    "user.name=Nanasa Certification",
    "-c",
    "user.email=certification@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "certification fixture",
  ],
  { stdio: "ignore" },
);
const brokerPath = join(home, ".config", "nanasa", "credentials.json");
if (!usesProviderHome) {
  writeFileSync(
    brokerPath,
    `${JSON.stringify({
      version: 1,
      profiles: {
        certification: {
          provider: providerId,
          source: "environment",
          sourceEnvironment: profile.credential,
          targetEnvironment: profile.credential,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(brokerPath, 0o600);
}
writeFileSync(
  join(repository, ".nanasa", "config.yaml"),
  `version: 2
repository:
  path: .
  checkout: { kind: current }
terminal:
  checkpoints: { enabled: false, maxLines: 500, maxBytes: 65536, retentionSeconds: 300, sensitivity: repository-private }
instructions: []
integrations:
  ${integrationId}:
    name: Provider certification
    kind: ${providerId}
    command: ${JSON.stringify(configuredCommand)}
    cwd: .
    providerState: { scope: ${providerStateScope} }
    credentials: ${usesProviderHome ? "{ kind: provider-managed }" : "{ kind: broker-profile, profileId: certification }"}
    model: ${JSON.stringify(configuredModel)}
    nativeRecovery: { mode: resume-only, confirmationTimeoutSeconds: 60 }
extensions: {}
roles: {}
groups: ${configuredGroups}
messages: { retentionPerGroup: 100 }
`,
  { mode: 0o600 },
);

const previousHome = process.env.HOME;
process.env.HOME = home;
const deadline = Date.now() + 180_000;
async function until<T>(description: string, read: () => T | undefined): Promise<T> {
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Provider certification timed out waiting for ${description}`);
}

let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
try {
  const port = await reserveLoopbackPort();
  const loaded = loadNanasaConfig(repository);
  daemon = await createDaemon({
    loadedConfig: loaded,
    ...(persistentIntegrationsDirectory === undefined
      ? {}
      : { providerStateRoot: realpathSync(persistentIntegrationsDirectory) }),
    dataPath: join(repository, ".nanasa", "state", "nanasa.sqlite"),
    runtimePath: join(repository, ".nanasa", "runtime"),
    repoRoot: repository,
    tmuxServerName: `nanasa-cert-${providerId}`,
    statusEndpointUrl: `http://127.0.0.1:${port}/api/v1/agent-status/events`,
    mcp: { enabled: true, endpointUrl: `http://127.0.0.1:${port}/mcp` },
  });
  await daemon.app.listen({ host: "127.0.0.1", port });
  const group = usesProviderHome
    ? daemon.store.getGroup("certification")
    : await daemon.topology.createGroup({ name: "Certification" });
  const membership = usesProviderHome
    ? daemon.store
        .listActiveMemberships(group.id)
        .find((candidate) => candidate.id === certificationAgentId)!
    : await daemon.topology.createAgent(group.id, {
        name: "Certified provider",
        integrationId,
      });
  const run = await daemon.coordinator.startRun(group.id, membership.memberId, {
    cols: 120,
    rows: 40,
  });
  if (usesProviderHome && (providerId === "copilot" || providerId === "opencode")) {
    await until(`${providerId} process readiness`, () => {
      const status = daemon!.store.getAgentStatus(group.id, membership.memberId);
      return status.runId === run.id && status.processState === "present" ? status : undefined;
    });
    if (providerId === "copilot") {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
      execFileSync(
        "tmux",
        ["-L", daemon.runtime.serverName, "send-keys", "-t", run.terminal!.paneId, "Escape"],
        { stdio: "ignore" },
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    } else {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 6_000));
    }
    await daemon.runtime.pasteToRun(
      run,
      "Reply with READY so Nanasa can certify reporter startup.",
    );
  }
  let latestReadinessStatus: AgentStatusDetail | undefined;
  const readReadyStatus = () => {
    const status = daemon!.store.getAgentStatus(group.id, membership.memberId);
    latestReadinessStatus = status;
    return status.runId === run.id &&
      status.interactiveReady &&
      status.authorityKind === "reporter" &&
      status.processState === "present"
      ? status
      : undefined;
  };
  try {
    await until<AgentStatusDetail>("reporter readiness", readReadyStatus);
  } catch (error) {
    if (!usesProviderHome || latestReadinessStatus === undefined) throw error;
    const status = latestReadinessStatus;
    throw new Error(
      `Provider reporter readiness failed: ${JSON.stringify({
        runStatus: status.runStatus,
        state: status.state,
        phase: status.phase,
        interactiveReady: status.interactiveReady,
        authorityKind: status.authorityKind,
        processState: status.processState,
        readinessCoverage: status.readinessCoverage,
      })}`,
      { cause: error },
    );
  }
  const activeReporter = daemon.store.getCurrentReporterSession(run.id, run.generation);
  if (
    activeReporter?.reporterId !== adapter.reporter.id ||
    activeReporter.source !== adapter.reporter.source ||
    activeReporter.reporterVersion !== adapter.reporter.version
  ) {
    throw new Error("Provider readiness did not use the certified reporter descriptor");
  }
  const extension = daemon.extensions.inspect(`nanasa.${providerId}`);
  if (!["current", "unavailable"].includes(extension.catalog.health.state)) {
    throw new Error(
      `Built-in provider extension health is ${extension.catalog.health.state}, expected current or unavailable`,
    );
  }

  if (certifiesWaits) {
    const waitPrompt = {
      copilot:
        "Call the ask_user tool exactly once now. Ask: 'Continue provider certification?' Do not answer the question yourself and do not use plain text instead of the tool.",
      "claude-code":
        "Call the AskUserQuestion tool exactly once now. Ask: 'Continue provider certification?' Do not answer the question yourself and do not use plain text instead of the tool.",
      opencode:
        "Call the native question tool exactly once now. Ask: 'Continue provider certification?' Do not answer the question yourself and do not use plain text instead of the tool.",
      pi: "Open one native provider question exactly once now. Ask: 'Continue provider certification?' Do not answer it yourself.",
    }[providerId];
    const action = daemon.actions.create(
      { kind: "operator", operatorId: "provider-certification" },
      {
        kind: "prompt",
        groupId: group.id,
        memberId: membership.memberId,
        prompt: waitPrompt,
        allowWorking: false,
      },
      `provider-certification-${providerId}`,
    );
    const wait = await until<OpenWait>("an exact provider wait", () =>
      daemon!.store.listOpenWaits(group.id).find((item) => item.state === "open"),
    );
    if (!adapter.control.waitReplyChannels.includes(wait.replyChannel)) {
      throw new Error("Provider opened a wait on an unclaimed reply channel");
    }
    const replying = await daemon.openWaits.reply(
      { kind: "operator", operatorId: "provider-certification" },
      wait.id,
      {
        expectedRunId: wait.runId,
        expectedGeneration: wait.generation,
        expectedReporterEpoch: wait.reporterEpoch,
        expectedStatusRevision: wait.openedStatusRevision,
        reply: OpenWaitReplySchema.parse({ kind: "answer", text: "Certification reply" }),
      },
    );
    if (replying.state !== "replying" || action.target.runId !== wait.runId) {
      throw new Error("Exact wait reply was not fenced to the certified run");
    }
    await until("provider acknowledgement of the exact reply", () => {
      const current = daemon!.store.getOpenWait(wait.id);
      return current.state === "answered" ? current : undefined;
    });
    if (adapter.reporter.coverage.actionCorrelation && wait.actionId !== action.id) {
      throw new Error("Provider claimed action correlation without linking the exact wait");
    }
  }

  const reporter = daemon.store.getCurrentReporterSession(run.id, run.generation);
  if (reporter?.nativeSessionId === undefined) {
    throw new Error("Provider did not report a native session identity");
  }
  const nativeSession = daemon.store.latestNativeSession(membership.memberId, integrationId);
  if (adapter.reporter.coverage.effectiveModel && nativeSession?.effectiveModel === undefined)
    throw new Error("Provider claimed effective-model coverage without an observation");
  if (certificationLevel === "full") {
    execFileSync("tmux", [
      "-L",
      daemon.runtime.serverName,
      "kill-pane",
      "-t",
      run.terminal!.paneId,
    ]);
    await daemon.coordinator.reconcile();
    const resumed = await until("confirmed native resume", () => {
      const candidate = daemon!.store.getActiveRun(group.id, membership.memberId);
      return candidate !== undefined &&
        candidate.generation > run.generation &&
        candidate.nativeSessionId === reporter.nativeSessionId &&
        candidate.recoveryOutcome === "resumed"
        ? candidate
        : undefined;
    });
    if (resumed.launchKind !== "resuming") throw new Error("Recovery did not use native resume");
  }
} finally {
  if (daemon !== undefined) await daemon.app.close().catch(() => undefined);
  try {
    execFileSync("tmux", ["-L", `nanasa-cert-${providerId}`, "kill-server"], { stdio: "ignore" });
  } catch {
    // The provider may have exited before a tmux server was established.
  }
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(root, { recursive: true, force: true });
}
