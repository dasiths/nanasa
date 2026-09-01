import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { loadNanasaConfig } from "../apps/daemon/src/config-v2.js";
import { resolveProviderStateHome } from "../apps/daemon/src/provider-state-home.js";

const supportedProviders = new Set(["copilot", "claude-code", "pi", "opencode"]);
const providerId = process.argv[2];
const integrationId = process.argv[3] ?? providerId;
const agentFlagIndex = process.argv.indexOf("--agent");
const agentId = agentFlagIndex < 0 ? undefined : process.argv[agentFlagIndex + 1];
const certificationLevel = process.argv.includes("--full") ? "full" : "smoke";
if (providerId === undefined || !supportedProviders.has(providerId)) {
  throw new Error("Usage: pnpm certify:provider:local <provider-id> [integration-id]");
}
if (integrationId === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(integrationId)) {
  throw new Error("Local certification integration ID is invalid");
}
if (agentFlagIndex >= 0 && (agentId === undefined || agentId.startsWith("--"))) {
  throw new Error("--agent requires a stable configured agent ID");
}

const repositoryRoot = resolve(process.env.NANASA_REPO_ROOT ?? process.cwd());
const loaded = loadNanasaConfig(repositoryRoot);
const integration = loaded.config.integrations[integrationId];
if (integration === undefined) {
  throw new Error(`Unknown integration ${integrationId}; add it to .nanasa/config.yaml first`);
}
if (integration.kind !== providerId) {
  throw new Error(
    `Integration ${integrationId} uses ${integration.kind}, not requested provider ${providerId}`,
  );
}
if (integration.providerState.scope === "membership" && agentId === undefined) {
  throw new Error(
    `Integration ${integrationId} uses membership scope; pass --agent <configured-agent-id>`,
  );
}
if (integration.providerState.scope === "custom") {
  throw new Error(
    `Integration ${integrationId} uses a custom provider home; local certification supports integration or membership scope`,
  );
}
const providerHome = resolveProviderStateHome(
  loaded.integrationsDirectory,
  integrationId,
  integration.providerState,
  agentId,
);
if (!existsSync(providerHome)) {
  const agentArgument = agentId === undefined ? "" : ` --agent ${agentId}`;
  throw new Error(
    `Provider home is missing. Run "node bin/nanasa.js auth login ${integrationId}${agentArgument}" once, then retry`,
  );
}
const homeStatus = lstatSync(providerHome);
if (
  !homeStatus.isDirectory() ||
  homeStatus.isSymbolicLink() ||
  (homeStatus.mode & 0o077) !== 0 ||
  (typeof process.getuid === "function" && homeStatus.uid !== process.getuid())
) {
  throw new Error("Provider home must be a private owner-controlled directory");
}

process.stdout.write(
  `Using persisted authentication from ${providerHome}\n` +
    `Authenticate or refresh once with: node bin/nanasa.js auth login ${integrationId}${agentId === undefined ? "" : ` --agent ${agentId}`}\n` +
    `Certification profile: ${certificationLevel}\n`,
);
const result = spawnSync(
  process.execPath,
  [resolve(repositoryRoot, "scripts", "certify-external.mjs"), "provider", providerId],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NANASA_CERT_CANDIDATE_SHA: "ignore",
      NANASA_CERT_LOCAL: "true",
      NANASA_CERT_AUTH_MODE: "provider-home",
      NANASA_CERT_LEVEL: certificationLevel,
      NANASA_CERT_INTEGRATIONS_DIRECTORY: loaded.integrationsDirectory,
      NANASA_CERT_INTEGRATION_ID: integrationId,
      NANASA_CERT_PROVIDER_STATE_SCOPE: integration.providerState.scope,
      ...(agentId === undefined ? {} : { NANASA_CERT_AGENT_ID: agentId }),
      NANASA_CERT_PROVIDER_COMMAND_JSON: JSON.stringify(integration.command),
      NANASA_CERT_PROVIDER_CWD: integration.cwd,
      NANASA_CERT_MODEL_POLICY_JSON: JSON.stringify(integration.model),
    },
  },
);
if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Local ${providerId} certification failed with exit ${result.status ?? "unknown"}`,
  );
}
