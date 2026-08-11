import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTypeConfig } from "@nanasa/contracts";
import { agentConfigHomeEnvironment, resolveAgentConfigHome } from "./agent-config-home.js";
import { loadNanasaConfig } from "./config.js";

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

function selectedAgentType(repositoryRoot: string, agentTypeKey: string): AgentTypeConfig {
  const agentType = loadNanasaConfig(repositoryRoot).config.agentTypes[agentTypeKey];
  if (agentType === undefined) throw new Error(`Unknown agent type: ${agentTypeKey}`);
  return agentType;
}

function selectedHome(
  repositoryRoot: string,
  agentType: AgentTypeConfig,
  membershipId?: string,
): string {
  if (
    (agentType.agentConfigHome.scope === "member" ||
      (agentType.agentConfigHome.scope === "custom" &&
        agentType.agentConfigHome.path.includes("{membershipId}"))) &&
    membershipId === undefined
  ) {
    throw new Error(`${agentType.key} requires --member <membership-id>`);
  }
  return resolveAgentConfigHome(
    loadNanasaConfig(repositoryRoot).integrationsDirectory,
    agentType.key,
    agentType.agentConfigHome,
    membershipId,
  );
}

function hasSharedHome(agentType: AgentTypeConfig): boolean {
  return !(
    agentType.agentConfigHome.scope === "member" ||
    (agentType.agentConfigHome.scope === "custom" &&
      agentType.agentConfigHome.path.includes("{membershipId}"))
  );
}

export function setupIntegrations(repositoryRoot: string): void {
  const loaded = loadNanasaConfig(repositoryRoot);
  ensurePrivateTree(loaded.integrationsDirectory, loaded.integrationsDirectory);
  for (const agentType of Object.values(loaded.config.agentTypes)) {
    if (!hasSharedHome(agentType)) continue;
    ensurePrivateTree(loaded.integrationsDirectory, selectedHome(repositoryRoot, agentType));
  }
  process.stdout.write(`Prepared isolated integrations at ${loaded.integrationsDirectory}\n`);
}

export function doctorIntegrations(repositoryRoot: string): void {
  const loaded = loadNanasaConfig(repositoryRoot);
  const problems: string[] = [];
  inspectPrivateDirectory(loaded.integrationsDirectory, problems, true);
  for (const agentType of Object.values(loaded.config.agentTypes)) {
    const command = agentType.command[0] as string;
    if (executablePath(command, process.env, agentType.cwd) === undefined) {
      problems.push(`${agentType.key}: command not found: ${command}`);
    }
    if (hasSharedHome(agentType)) {
      inspectPrivateDirectory(selectedHome(repositoryRoot, agentType), problems, true);
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
    `Nanasa doctor passed for ${Object.keys(loaded.config.agentTypes).length} agent types\n`,
  );
}

export function authenticateAgent(
  repositoryRoot: string,
  agentTypeKey: string,
  membershipId?: string,
): void {
  const loaded = loadNanasaConfig(repositoryRoot);
  const agentType = selectedAgentType(repositoryRoot, agentTypeKey);
  const configHome = selectedHome(repositoryRoot, agentType, membershipId);
  ensurePrivateTree(loaded.integrationsDirectory, configHome);
  const command = agentType.command[0] as string;
  if (executablePath(command, process.env, agentType.cwd) === undefined) {
    throw new Error(`Agent command not found: ${command}`);
  }
  process.stdout.write(`Launching ${agentType.name} with isolated home ${configHome}\n`);
  const result = spawnSync(command, agentType.command.slice(1), {
    cwd: agentType.cwd,
    env: {
      ...process.env,
      ...agentType.environment,
      ...agentConfigHomeEnvironment(agentType.kind, configHome),
    },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}
