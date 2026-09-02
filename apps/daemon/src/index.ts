import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertLoopbackControlHost } from "./authority-policy.js";
import { discoverAndLoadNanasaConfig, loadNanasaConfig } from "./config-loader.js";
import { isLoopbackHost, validateMcpEndpointConfiguration } from "./mcp-config.js";
import { createDaemon } from "./server.js";

export {
  ConfigLoadError,
  discoverAndLoadNanasaConfig,
  discoverRepositoryRoot,
  loadNanasaConfig,
  nanasaPaths,
} from "./config-loader.js";
export { createDaemon } from "./server.js";
export { DomainError, NanasaStore } from "./store.js";

function configuredPort(value: string | undefined): number {
  const port = value === undefined ? 3210 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("NANASA_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function configuredBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function configuredPath(name: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty filesystem path`);
  }
  return resolve(value);
}

function configuredRepositoryRoot(value: string | undefined): string | undefined {
  const path = configuredPath("NANASA_REPO_ROOT", value);
  if (path === undefined) {
    return undefined;
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error("NANASA_REPO_ROOT must reference an existing directory");
  }
  return realpathSync(path);
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function validateMcpStartupConfiguration(options: {
  enabled: boolean;
  listenHost: string;
  endpointUrl: string;
  operatorToken?: string;
}): void {
  if (!options.enabled) {
    return;
  }
  if (!isLoopbackHost(options.listenHost)) {
    throw new Error(
      "NANASA_HOST must remain loopback when MCP is enabled; expose only /mcp through a trusted reverse proxy",
    );
  }
  try {
    validateMcpEndpointConfiguration(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message
        .replace("External MCP endpoint URLs", "External NANASA_MCP_URL endpoints")
        .replace("An MCP operator token", "NANASA_MCP_OPERATOR_TOKEN")
        .replace("The MCP operator token", "NANASA_MCP_OPERATOR_TOKEN"),
      { cause: error },
    );
  }
}

async function start(): Promise<void> {
  const configuredRoot = configuredRepositoryRoot(process.env.NANASA_REPO_ROOT);
  const loadedConfig =
    configuredRoot === undefined
      ? discoverAndLoadNanasaConfig(process.cwd())
      : loadNanasaConfig(configuredRoot);
  const host = process.env.NANASA_HOST ?? "127.0.0.1";
  const port = configuredPort(process.env.NANASA_PORT);
  const dataPath = configuredPath("NANASA_DATA_PATH", process.env.NANASA_DATA_PATH);
  const runtimePath =
    configuredPath("NANASA_RUNTIME_PATH", process.env.NANASA_RUNTIME_PATH) ??
    loadedConfig.runtimeDirectory;
  const tmuxServerName = process.env.NANASA_TMUX_SERVER ?? "nanasa";
  const mcpEnabled = configuredBoolean("NANASA_MCP_ENABLED", process.env.NANASA_MCP_ENABLED, false);
  const mcpPath = process.env.NANASA_MCP_PATH ?? "/mcp";
  const mcpOperatorToken = process.env.NANASA_MCP_OPERATOR_TOKEN;
  const mcpEndpointUrl =
    process.env.NANASA_MCP_URL ?? `http://${hostForUrl(host)}:${port}${mcpPath}`;
  const statusEndpointUrl = `http://${hostForUrl(host)}:${port}/api/v1/agent-status/events`;
  assertLoopbackControlHost(host);
  validateMcpStartupConfiguration({
    enabled: mcpEnabled,
    listenHost: host,
    endpointUrl: mcpEndpointUrl,
    ...(mcpOperatorToken === undefined ? {} : { operatorToken: mcpOperatorToken }),
  });
  const servePortal = configuredBoolean(
    "NANASA_SERVE_PORTAL",
    process.env.NANASA_SERVE_PORTAL,
    process.env.NODE_ENV === "production",
  );
  const portalAssetsPath =
    process.env.NANASA_PORTAL_PATH ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../portal/dist");
  const packageRoot = configuredPath("NANASA_PACKAGE_ROOT", process.env.NANASA_PACKAGE_ROOT);
  const daemon = await createDaemon({
    ...(dataPath === undefined ? {} : { dataPath }),
    runtimePath,
    loadedConfig,
    logger: true,
    ...(process.env.NANASA_TMUX_SERVER === undefined ? {} : { tmuxServerName }),
    statusEndpointUrl,
    servePortal,
    portalAssetsPath,
    ...(packageRoot === undefined ? {} : { packageRoot }),
    mcp: {
      enabled: mcpEnabled,
      path: mcpPath,
      endpointUrl: mcpEndpointUrl,
      ...(mcpOperatorToken === undefined ? {} : { operatorToken: mcpOperatorToken }),
      allowedHostnames: [new URL(mcpEndpointUrl).hostname],
    },
  });

  const close = async () => {
    await daemon.app.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await daemon.app.listen({ host, port });
  } catch (error) {
    await daemon.app.close();
    throw error;
  }
  process.stdout.write(`Open http://${hostForUrl(host)}:${port}/#${daemon.bootstrapFragment}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
