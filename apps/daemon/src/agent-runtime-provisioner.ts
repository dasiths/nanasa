import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfigHome, AgentProfile, GroupMembership } from "@nanasa/contracts";
import { agentConfigHomeEnvironment, resolveAgentConfigHome } from "./agent-config-home.js";
import {
  HOOK_STATUS_REPORTER_SOURCE,
  OPENCODE_STATUS_REPORTER_SOURCE,
  PI_STATUS_REPORTER_SOURCE,
} from "./status-reporter-assets.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface AgentRuntimeConfiguration {
  command: string[];
  environment: Record<string, string>;
}

export interface AgentRuntimeProvisionerOptions {
  integrationsDirectory: string;
  agentConfigHomes: Readonly<Record<string, AgentConfigHome>>;
  mcpEndpointUrl: string;
  piExtensionPath?: string;
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Agent runtime path must be a regular directory: ${path}`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`Agent runtime path must be owned by the current user: ${path}`);
  }
  chmodSync(path, DIRECTORY_MODE);
}

function ensurePrivateTree(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const relativePath = relative(resolvedRoot, resolve(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Agent runtime path must remain beneath integrations: ${path}`);
  }
  ensurePrivateDirectory(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    ensurePrivateDirectory(current);
  }
}

function writePrivateJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  renameSync(temporaryPath, path);
  chmodSync(path, FILE_MODE);
}

function writePrivateText(path: string, value: string): void {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, value.endsWith("\n") ? value : `${value}\n`, {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  renameSync(temporaryPath, path);
  chmodSync(path, FILE_MODE);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandHook(scriptPath: string, source: "claude-code" | "copilot", eventName: string) {
  return {
    type: "command",
    command: process.execPath,
    args: [scriptPath, source, eventName],
    timeout: 2,
  };
}

export class AgentRuntimeProvisioner {
  readonly #options: AgentRuntimeProvisionerOptions;

  public constructor(options: AgentRuntimeProvisionerOptions) {
    this.#options = options;
    ensurePrivateDirectory(options.integrationsDirectory);
  }

  public provision(membership: GroupMembership, profile: AgentProfile): AgentRuntimeConfiguration {
    if (!/^membership_[A-Za-z0-9-]+$/.test(membership.id)) {
      throw new Error(`Membership ID is not safe for agent persistence: ${membership.id}`);
    }
    const policy = this.#options.agentConfigHomes[profile.agentType];
    if (policy === undefined) {
      throw new Error(`Agent configuration home is missing for ${profile.agentType}`);
    }
    const configHome = resolveAgentConfigHome(
      this.#options.integrationsDirectory,
      profile.agentType,
      policy,
      membership.id,
    );
    const memberDirectory = join(
      this.#options.integrationsDirectory,
      "members",
      membership.id,
      profile.agentType,
    );
    ensurePrivateTree(this.#options.integrationsDirectory, configHome);
    ensurePrivateTree(this.#options.integrationsDirectory, memberDirectory);
    const command = [profile.command, ...profile.args];

    switch (profile.kind) {
      case "copilot": {
        const hooksDirectory = join(configHome, "hooks");
        const reporterPath = join(hooksDirectory, "nanasa-status-hook-v1.mjs");
        writePrivateText(reporterPath, HOOK_STATUS_REPORTER_SOURCE);
        const configPath = join(memberDirectory, "mcp-config.json");
        writePrivateJson(configPath, {
          mcpServers: {
            nanasa: {
              type: "http",
              url: this.#options.mcpEndpointUrl,
              headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
              tools: ["*"],
            },
          },
        });
        const hook = (eventName: string, matcher?: string) => ({
          type: "command",
          ...(matcher === undefined ? {} : { matcher }),
          bash: `${shellQuote(process.execPath)} ${shellQuote(reporterPath)} copilot ${shellQuote(eventName)}`,
          timeoutSec: 2,
        });
        writePrivateJson(join(hooksDirectory, "nanasa-status-v1.json"), {
          version: 1,
          hooks: {
            sessionStart: [hook("sessionStart")],
            userPromptSubmitted: [hook("userPromptSubmitted")],
            preToolUse: [hook("preToolUse", ".*")],
            permissionRequest: [hook("permissionRequest", ".*")],
            postToolUse: [hook("postToolUse", ".*")],
            postToolUseFailure: [hook("postToolUseFailure", ".*")],
            agentStop: [hook("agentStop")],
            errorOccurred: [hook("errorOccurred")],
            preCompact: [hook("preCompact")],
            sessionEnd: [hook("sessionEnd")],
          },
        });
        const cacheDirectory = join(configHome, "cache");
        ensurePrivateTree(this.#options.integrationsDirectory, cacheDirectory);
        return {
          command: [...command, "--additional-mcp-config", `@${configPath}`],
          environment: agentConfigHomeEnvironment(profile.kind, configHome),
        };
      }
      case "claude-code": {
        const configDirectory = configHome;
        ensurePrivateDirectory(configDirectory);
        const reporterPath = join(configDirectory, "nanasa-status-hook.mjs");
        writePrivateText(reporterPath, HOOK_STATUS_REPORTER_SOURCE);
        writePrivateJson(join(configDirectory, ".claude.json"), {
          mcpServers: {
            nanasa: {
              type: "http",
              url: this.#options.mcpEndpointUrl,
              headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
              alwaysLoad: true,
            },
          },
        });
        const hook = (eventName: string, matcher?: string) => ({
          ...(matcher === undefined ? {} : { matcher }),
          hooks: [commandHook(reporterPath, "claude-code", eventName)],
        });
        writePrivateJson(join(configDirectory, "settings.json"), {
          hooks: {
            SessionStart: [hook("SessionStart")],
            UserPromptSubmit: [hook("UserPromptSubmit")],
            PreToolUse: [hook("PreToolUse", "*")],
            PermissionRequest: [hook("PermissionRequest", "*")],
            PostToolUse: [hook("PostToolUse", "*")],
            PostToolUseFailure: [hook("PostToolUseFailure", "*")],
            Stop: [hook("Stop")],
            StopFailure: [hook("StopFailure")],
            PreCompact: [hook("PreCompact")],
            PostCompact: [hook("PostCompact")],
            Elicitation: [hook("Elicitation")],
            ElicitationResult: [hook("ElicitationResult")],
            SessionEnd: [hook("SessionEnd")],
          },
        });
        return {
          command,
          environment: agentConfigHomeEnvironment(profile.kind, configHome),
        };
      }
      case "pi": {
        const agentDirectory = configHome;
        ensurePrivateDirectory(agentDirectory);
        writePrivateJson(join(agentDirectory, "mcp.json"), {
          settings: {
            directTools: true,
            hostConfigDiscovery: "off",
          },
          mcpServers: {
            nanasa: {
              url: this.#options.mcpEndpointUrl,
              headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
              protocolVersion: "auto",
              lifecycle: "eager",
            },
          },
        });
        const extensionPath =
          this.#options.piExtensionPath ?? fileURLToPath(import.meta.resolve("pi-mcp-adapter"));
        const statusExtensionPath = join(agentDirectory, "nanasa-status-extension.mjs");
        writePrivateText(statusExtensionPath, PI_STATUS_REPORTER_SOURCE);
        return {
          command: [...command, "--extension", extensionPath, "--extension", statusExtensionPath],
          environment: agentConfigHomeEnvironment(profile.kind, configHome),
        };
      }
      case "opencode": {
        const opencodeDirectory = configHome;
        const configPath = join(opencodeDirectory, "opencode.json");
        const configDirectory = join(opencodeDirectory, "nanasa-config");
        writePrivateText(
          join(configDirectory, "plugins", "nanasa-status.mjs"),
          OPENCODE_STATUS_REPORTER_SOURCE,
        );
        writePrivateJson(configPath, {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            nanasa: {
              type: "remote",
              url: this.#options.mcpEndpointUrl,
              enabled: true,
              oauth: false,
              headers: { Authorization: "Bearer {env:NANASA_MCP_TOKEN}" },
            },
          },
        });
        return {
          command,
          environment: {
            ...agentConfigHomeEnvironment(profile.kind, configHome),
            OPENCODE_CONFIG: configPath,
            OPENCODE_CONFIG_DIR: configDirectory,
          },
        };
      }
    }
  }
}
