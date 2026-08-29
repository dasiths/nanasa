import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { IntegrationConfig } from "@nanasa/contracts";
import { loadNanasaConfig } from "./config-v2.js";
import { ProviderStateRepository } from "./provider-state-repository.js";
import { ProviderAdapterRegistry } from "./providers/provider-adapter-registry.js";
import { UserCredentialBroker } from "./user-credential-broker.js";
import {
  formatRedactedResetInventory,
  inventoryAlphaResources,
  resetFromAlpha,
} from "./persistence/reset-service.js";

const DIRECTORY_MODE = 0o700;

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Integration path must be a regular directory: ${path}`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`Integration path must be owned by the current user: ${path}`);
  }
  chmodSync(path, DIRECTORY_MODE);
}

function ensurePrivateTree(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const relativePath = relative(resolvedRoot, resolve(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Integration path must remain beneath ${resolvedRoot}`);
  }
  ensurePrivateDirectory(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    ensurePrivateDirectory(current);
  }
}

function inspectPrivateDirectory(path: string, problems: string[], required = false): void {
  if (!existsSync(path)) {
    if (required) problems.push(`Integration path is missing; run nanasa setup: ${path}`);
    return;
  }
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    problems.push(`Integration path is not a regular directory: ${path}`);
  } else if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    problems.push(`Integration path is not owned by the current user: ${path}`);
  } else if ((status.mode & 0o077) !== 0) {
    problems.push(`Integration path must not be accessible by group or other users: ${path}`);
  }
}

function executablePath(
  command: string,
  environment: NodeJS.ProcessEnv,
  workingDirectory = process.cwd(),
): string | undefined {
  const candidates =
    command.includes("/") || command.includes("\\")
      ? [resolve(workingDirectory, command)]
      : (environment.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, command));
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function selectedIntegration(repositoryRoot: string, integrationId: string): IntegrationConfig {
  const integration = loadNanasaConfig(repositoryRoot).config.integrations[integrationId];
  if (integration === undefined) throw new Error(`Unknown integration: ${integrationId}`);
  return integration;
}

function selectedHome(
  repositoryRoot: string,
  integration: IntegrationConfig,
  agentId?: string,
): string {
  if (
    (integration.providerState.scope === "membership" ||
      (integration.providerState.scope === "custom" &&
        integration.providerState.path.includes("{agentId}"))) &&
    agentId === undefined
  ) {
    throw new Error(`${integration.id} requires --agent <agent-id>`);
  }
  return new ProviderStateRepository(
    loadNanasaConfig(repositoryRoot).integrationsDirectory,
  ).resolve({
    membershipId: agentId ?? "shared",
    integrationId: integration.id,
    policy: integration.providerState,
    credentialReference: integration.credentials,
  }).storageReference;
}

function hasSharedHome(integration: IntegrationConfig): boolean {
  return !(
    integration.providerState.scope === "membership" ||
    (integration.providerState.scope === "custom" &&
      integration.providerState.path.includes("{agentId}"))
  );
}

export function setupIntegrations(repositoryRoot: string): void {
  const loaded = loadNanasaConfig(repositoryRoot);
  ensurePrivateTree(loaded.integrationsDirectory, loaded.integrationsDirectory);
  for (const integration of Object.values(loaded.config.integrations)) {
    if (!hasSharedHome(integration)) continue;
    ensurePrivateTree(loaded.integrationsDirectory, selectedHome(repositoryRoot, integration));
  }
  process.stdout.write(`Prepared isolated integrations at ${loaded.integrationsDirectory}\n`);
}

export function doctorIntegrations(repositoryRoot: string): void {
  const loaded = loadNanasaConfig(repositoryRoot);
  const problems: string[] = [];
  inspectPrivateDirectory(loaded.integrationsDirectory, problems, true);
  for (const integration of Object.values(loaded.config.integrations)) {
    const command = integration.command[0] as string;
    if (executablePath(command, process.env, integration.cwd) === undefined) {
      problems.push(`${integration.id}: command not found: ${command}`);
    }
    if (hasSharedHome(integration)) {
      inspectPrivateDirectory(selectedHome(repositoryRoot, integration), problems, true);
    }
  }
  const ttydCommand = process.env.NANASA_TTYD_PATH ?? "ttyd";
  if (executablePath(ttydCommand, process.env) === undefined) {
    problems.push(`ttyd command not found: ${ttydCommand}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`ERROR ${problem}\n`);
    throw new Error(
      `Nanasa doctor found ${problems.length} problem${problems.length === 1 ? "" : "s"}`,
    );
  }
  process.stdout.write(
    `Nanasa doctor passed for ${Object.keys(loaded.config.integrations).length} integrations\n`,
  );
}

export function authenticateAgent(
  repositoryRoot: string,
  integrationId: string,
  agentId?: string,
): void {
  const loaded = loadNanasaConfig(repositoryRoot);
  const integration = selectedIntegration(repositoryRoot, integrationId);
  const configHome = selectedHome(repositoryRoot, integration, agentId);
  ensurePrivateTree(loaded.integrationsDirectory, configHome);
  const command = integration.command[0] as string;
  const adapter = ProviderAdapterRegistry.builtIn().get(integration.kind);
  const credentials = new UserCredentialBroker().resolve(
    integration.credentials,
    integration.kind,
    adapter.credentialEnvironmentNames(),
  );
  if (credentials.health === "missing") {
    throw new Error(`Credential profile ${credentials.profileId} is unavailable`);
  }
  if (executablePath(command, process.env, integration.cwd) === undefined) {
    throw new Error(`Agent command not found: ${command}`);
  }
  process.stdout.write(`Launching ${integration.name} with isolated home ${configHome}\n`);
  const result = spawnSync(command, integration.command.slice(1), {
    cwd: integration.cwd,
    env: {
      ...process.env,
      ...integration.environment,
      ...adapter.stateEnvironment(configHome),
      ...credentials.environment,
    },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

export async function resetAlphaRepository(
  repositoryRoot: string,
  confirmation: string,
  configTemplate: string,
): Promise<void> {
  const inventory = inventoryAlphaResources(repositoryRoot);
  process.stdout.write(
    `Nanasa alpha reset inventory (content redacted):\n${formatRedactedResetInventory(inventory)}\n`,
  );
  const result = await resetFromAlpha({
    repositoryRoot,
    confirmation,
    configTemplate,
  });
  process.stdout.write(
    `Reset complete. Verified backup: ${result.backupDirectory}. Removed ${result.removedOwnedTmuxPanes} owned tmux pane(s).\n`,
  );
}
