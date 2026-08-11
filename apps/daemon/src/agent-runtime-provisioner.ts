import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfigHome, AgentProfile, GroupMembership } from "@nanasa/contracts";
import { agentConfigHomeEnvironment, resolveAgentConfigHome } from "./agent-config-home.js";
import type { EffectiveAgentPrompt } from "./instruction-resolver.js";
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
  promptResolver?: (membership: GroupMembership, profile: AgentProfile) => EffectiveAgentPrompt;
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

function readPrivateJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Agent runtime file must be a regular file: ${path}`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`Agent runtime file must be owned by the current user: ${path}`);
  }
  if (status.size > 2 * 1024 * 1024) {
    throw new Error(`Agent runtime JSON exceeds the supported size: ${path}`);
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Agent runtime JSON must contain an object: ${path}`);
  }
  return value as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isNanasaClaudeHook(value: unknown): boolean {
  return JSON.stringify(value).includes("nanasa-status-hook.mjs");
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

function generatedAgentName(membershipId: string): string {
  return `nanasa-${createHash("sha256").update(membershipId).digest("hex").slice(0, 16)}`;
}

function appendProviderArguments(command: string[], providerArguments: string[]): string[] {
  if (command[0] === "make" && command[1] === "claude-copilot") {
    return [...command, `CLAUDE_ARGS=${providerArguments.map(shellQuote).join(" ")}`];
  }
  return [...command, ...providerArguments];
}

const PI_READ_ONLY_POLICY_SOURCE = `export default function (pi) {
  const blocked = new Set(["bash", "edit", "write"]);
  pi.on("tool_call", (event) => {
    if (blocked.has(event.toolName)) {
      return { block: true, reason: "The active Nanasa role is read-only", terminate: true };
    }
  });
}
`;

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
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(membership.id)) {
      throw new Error(`Agent ID is not safe for agent persistence: ${membership.id}`);
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
    let command = [profile.command, ...profile.args];
    const effectivePrompt = this.#options.promptResolver?.(membership, profile);
    const generatedName = generatedAgentName(membership.id);
    let promptPath: string | undefined;
    if (effectivePrompt !== undefined) {
      const instructionsDirectory = join(memberDirectory, "instructions");
      promptPath = join(instructionsDirectory, "system-prompt-suffix.md");
      writePrivateText(promptPath, effectivePrompt.text);
      writePrivateJson(join(instructionsDirectory, "manifest.json"), {
        version: 1,
        artifact: "system-prompt-suffix",
        revision: effectivePrompt.revision,
        roleId: effectivePrompt.roleId ?? null,
        permissionPolicy: effectivePrompt.role?.permissionPolicy ?? "inherit",
        sources: effectivePrompt.sources,
      });
    }
    const readOnly = effectivePrompt?.role?.permissionPolicy === "read-only";

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
        if (promptPath !== undefined && effectivePrompt !== undefined) {
          const agentsDirectory = join(configHome, "agents");
          writePrivateText(
            join(agentsDirectory, `${generatedName}.agent.md`),
            `---\nname: ${JSON.stringify(`Nanasa ${membership.alias}`)}\ndescription: ${JSON.stringify(`Nanasa-managed ${effectivePrompt.role?.name ?? "agent"}`)}\ninfer: false\n---\n\n${effectivePrompt.text}`,
          );
          command = [...command, "--agent", generatedName];
          if (readOnly) command.push("--deny-tool=write", "--deny-tool=shell");
        }
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
        const claudeStatePath = join(configDirectory, ".claude.json");
        const claudeState = readPrivateJsonObject(claudeStatePath);
        writePrivateJson(claudeStatePath, {
          ...claudeState,
          mcpServers: {
            ...objectValue(claudeState.mcpServers),
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
        const settingsPath = join(configDirectory, "settings.json");
        const settings = readPrivateJsonObject(settingsPath);
        const existingHooks = objectValue(settings.hooks);
        const generatedHooks = {
          SessionStart: hook("SessionStart"),
          UserPromptSubmit: hook("UserPromptSubmit"),
          PreToolUse: hook("PreToolUse", "*"),
          PermissionRequest: hook("PermissionRequest", "*"),
          PostToolUse: hook("PostToolUse", "*"),
          PostToolUseFailure: hook("PostToolUseFailure", "*"),
          Stop: hook("Stop"),
          StopFailure: hook("StopFailure"),
          PreCompact: hook("PreCompact"),
          PostCompact: hook("PostCompact"),
          Elicitation: hook("Elicitation"),
          ElicitationResult: hook("ElicitationResult"),
          SessionEnd: hook("SessionEnd"),
        };
        const mergedHooks: Record<string, unknown> = Object.fromEntries(
          Object.entries(generatedHooks).map(([eventName, generatedHook]) => [
            eventName,
            [
              ...(Array.isArray(existingHooks[eventName])
                ? existingHooks[eventName].filter((entry) => !isNanasaClaudeHook(entry))
                : []),
              generatedHook,
            ],
          ]),
        );
        for (const [eventName, entries] of Object.entries(existingHooks)) {
          if (mergedHooks[eventName] === undefined) mergedHooks[eventName] = entries;
        }
        writePrivateJson(settingsPath, {
          ...settings,
          hooks: mergedHooks,
        });
        if (promptPath !== undefined) {
          const providerArguments = ["--append-system-prompt-file", promptPath];
          if (readOnly) {
            providerArguments.push(
              "--disallowedTools",
              "Edit",
              "--disallowedTools",
              "Write",
              "--disallowedTools",
              "Bash",
            );
          }
          command = appendProviderArguments(command, providerArguments);
        }
        return {
          command,
          environment: agentConfigHomeEnvironment(profile.kind, configHome),
        };
      }
      case "pi": {
        const agentDirectory = configHome;
        ensurePrivateDirectory(agentDirectory);
        const mcpPath = join(agentDirectory, "mcp.json");
        const mcpConfig = readPrivateJsonObject(mcpPath);
        writePrivateJson(mcpPath, {
          ...mcpConfig,
          settings: {
            ...objectValue(mcpConfig.settings),
            directTools: true,
            hostConfigDiscovery: "off",
          },
          mcpServers: {
            ...objectValue(mcpConfig.mcpServers),
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
        if (promptPath !== undefined) command = [...command, "--append-system-prompt", promptPath];
        if (readOnly) {
          const policyPath = join(agentDirectory, "nanasa-read-only-policy.mjs");
          writePrivateText(policyPath, PI_READ_ONLY_POLICY_SOURCE);
          command = [...command, "--extension", policyPath];
        }
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
        const opencodeConfig = readPrivateJsonObject(configPath);
        const generatedAgent =
          promptPath === undefined
            ? undefined
            : {
                description: `Nanasa-managed ${effectivePrompt?.role?.name ?? "agent"}`,
                mode: "primary",
                prompt: `{file:${promptPath}}`,
                ...(readOnly ? { permission: { edit: "deny", bash: "deny" } } : {}),
              };
        writePrivateJson(configPath, {
          ...opencodeConfig,
          $schema: opencodeConfig.$schema ?? "https://opencode.ai/config.json",
          mcp: {
            ...objectValue(opencodeConfig.mcp),
            nanasa: {
              type: "remote",
              url: this.#options.mcpEndpointUrl,
              enabled: true,
              oauth: false,
              headers: { Authorization: "Bearer {env:NANASA_MCP_TOKEN}" },
            },
          },
          ...(generatedAgent === undefined
            ? {}
            : {
                agent: {
                  ...objectValue(opencodeConfig.agent),
                  [generatedName]: generatedAgent,
                },
              }),
        });
        if (generatedAgent !== undefined) command = [...command, "--agent", generatedName];
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
