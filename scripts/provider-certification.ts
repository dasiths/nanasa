import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKind, AgentStatusDetail, OpenWait } from "@nanasa/contracts";
import { loadNanasaConfig } from "../apps/daemon/src/config-v2.js";
import { ProviderAdapterRegistry } from "../apps/daemon/src/providers/provider-adapter-registry.js";
import { createDaemon } from "../apps/daemon/src/server.js";

const profiles = {
  copilot: { executable: "copilot", credential: "COPILOT_GITHUB_TOKEN" },
  "claude-code": { executable: "claude", credential: "ANTHROPIC_API_KEY" },
  opencode: { executable: "opencode", credential: "OPENAI_API_KEY" },
  pi: { executable: "pi", credential: "ANTHROPIC_API_KEY" },
} as const satisfies Record<AgentKind, { executable: string; credential: string }>;

const providerId = process.argv[2] as AgentKind;
const profile = profiles[providerId];
if (profile === undefined) throw new Error("Unknown built-in provider certification profile");
if (!process.env[profile.credential]) throw new Error("Provider credential is unavailable");
const adapter = ProviderAdapterRegistry.builtIn().get(providerId);
const claims = adapter.semantics;

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

const root = mkdtempSync(join(tmpdir(), `nanasa-provider-cert-${providerId}-`));
const repository = join(root, "repository");
const home = join(root, "home");
mkdirSync(repository, { recursive: true });
mkdirSync(join(repository, ".nanasa"), { recursive: true, mode: 0o700 });
mkdirSync(join(home, ".config", "nanasa"), { recursive: true, mode: 0o700 });
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
  certification:
    name: Provider certification
    kind: ${providerId}
    command: [${JSON.stringify(profile.executable)}]
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: broker-profile, profileId: certification }
    model: { resumePolicy: preserve-session }
    nativeRecovery: { mode: resume-only, confirmationTimeoutSeconds: 60 }
extensions: {}
roles: {}
groups: {}
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
  daemon = await createDaemon({
    loadedConfig: loadNanasaConfig(repository),
    dataPath: join(repository, ".nanasa", "state", "nanasa.sqlite"),
    runtimePath: join(repository, ".nanasa", "runtime"),
    repoRoot: repository,
    tmuxServerName: `nanasa-cert-${providerId}`,
    statusEndpointUrl: `http://127.0.0.1:${port}/api/v1/agent-status/events`,
    mcp: { enabled: true, endpointUrl: `http://127.0.0.1:${port}/mcp` },
  });
  await daemon.app.listen({ host: "127.0.0.1", port });
  const group = await daemon.topology.createGroup({ name: "Certification" });
  const membership = await daemon.topology.createAgent(group.id, {
    name: "Certified provider",
    integrationId: "certification",
  });
  const run = await daemon.coordinator.startRun(group.id, membership.memberId, {
    cols: 120,
    rows: 40,
  });
  const ready = await until<AgentStatusDetail>("reporter readiness", () => {
    const status = daemon!.store.getAgentStatus(group.id, membership.memberId);
    return status.runId === run.id && status.interactiveReady ? status : undefined;
  });
  if (
    claims.reporterReadiness &&
    (ready.authorityKind !== "reporter" || ready.processState !== "present")
  ) {
    throw new Error("Provider readiness was not backed by reporter and process identity");
  }
  const persistedRun = daemon.store.getRun(run.id);
  if (
    claims.modelObservation === "desired-launch" &&
    persistedRun.requestedModelSource !== "provider-default"
  ) {
    throw new Error("Provider launch did not preserve the declared desired-model source");
  }
  if (claims.modelObservation === "reporter-effective" && ready.effectiveModel === undefined) {
    throw new Error("Provider claimed reporter effective-model coverage without an observation");
  }
  const extension = daemon.extensions.inspect(`nanasa.${providerId}`);
  if (extension.catalog.health.state !== "current") {
    throw new Error("Built-in provider extension health is not current");
  }

  if (claims.waitCoverage) {
    const action = daemon.actions.create(
      { kind: "operator", operatorId: "provider-certification" },
      {
        kind: "prompt",
        groupId: group.id,
        memberId: membership.memberId,
        prompt:
          "Open one native provider question or permission wait for the operator. Do not answer it yourself.",
        allowWorking: false,
      },
      `provider-certification-${providerId}`,
    );
    await daemon.actionScheduler.tick();
    const wait = await until<OpenWait>("an exact provider wait", () =>
      daemon!.store.listOpenWaits(group.id).find((item) => item.state === "open"),
    );
    if (!claims.waitReplyChannels.includes(wait.replyChannel)) {
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
        reply: { kind: "text", text: "Certification reply" },
      },
    );
    if (replying.state !== "replying" || action.target.runId !== wait.runId) {
      throw new Error("Exact wait reply was not fenced to the certified run");
    }
    await until("provider acknowledgement of the exact reply", () => {
      const current = daemon!.store.getOpenWait(wait.id);
      return current.state === "answered" ? current : undefined;
    });
  }

  const reporter = daemon.store.getCurrentReporterSession(run.id, run.generation);
  if (reporter?.nativeSessionId === undefined) {
    throw new Error("Provider did not report a native session identity");
  }
  const nativeSession = daemon.store.latestNativeSession(membership.memberId, "certification");
  if (
    claims.modelObservation === "native-session-effective" &&
    nativeSession?.effectiveModel === undefined
  ) {
    throw new Error("Provider claimed native-session model coverage without an observation");
  }
  if (!claims.nativeResume) {
    throw new Error("EX-5 certification requires an explicit native-resume support decision");
  }
  execFileSync("tmux", ["-L", daemon.runtime.serverName, "kill-pane", "-t", run.terminal!.paneId]);
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
} finally {
  if (daemon !== undefined) await daemon.app.close().catch(() => undefined);
  try {
    execFileSync("tmux", ["-L", `nanasa-cert-${providerId}`, "kill-server"], { stdio: "ignore" });
  } catch {
    // The provider may have exited before a tmux server was established.
  }
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
