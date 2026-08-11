import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentConfigHome, AgentKind } from "@nanasa/contracts";

const PLACEHOLDER_PATTERN = /\{([^}]+)\}/g;
const SAFE_INTEGRATION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_AGENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function validateAgentConfigHome(policy: AgentConfigHome): void {
  if (policy.scope !== "custom") return;
  if (policy.path.includes("\0")) {
    throw new Error("Agent configuration home path may not contain NUL characters");
  }
  if (isAbsolute(policy.path) || /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(policy.path)) {
    throw new Error("Agent configuration home path must be relative to .nanasa/integrations");
  }
  const pathSegments = policy.path.split(/[\\/]/).filter((segment) => segment !== "");
  if (pathSegments.includes("..")) {
    throw new Error("Agent configuration home path may not traverse outside integrations");
  }
  const firstSegment = pathSegments.find((segment) => segment !== ".");
  if (firstSegment === undefined) {
    throw new Error("Agent configuration home path must name a directory beneath integrations");
  }
  if (firstSegment === "integrations" || firstSegment === "agents") {
    throw new Error(`Agent configuration home path uses reserved directory ${firstSegment}`);
  }
  const placeholders = [...policy.path.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
  if (placeholders.some((name) => name !== "integrationId" && name !== "agentId")) {
    throw new Error("Agent configuration home path contains an unknown placeholder");
  }
  if (
    policy.path
      .replaceAll("{integrationId}", "integration")
      .replaceAll("{agentId}", "agent")
      .match(/[{}]/) !== null
  ) {
    throw new Error("Agent configuration home path contains an invalid placeholder");
  }
}

export function resolveAgentConfigHome(
  integrationsDirectory: string,
  integrationId: string,
  policy: AgentConfigHome,
  agentId?: string,
): string {
  validateAgentConfigHome(policy);
  if (!SAFE_INTEGRATION_PATTERN.test(integrationId)) {
    throw new Error(`Integration ID is not path-safe: ${integrationId}`);
  }
  if (policy.scope === "agent" && agentId === undefined) {
    throw new Error(`Integration ${integrationId} requires an agent-specific configuration home`);
  }
  if (agentId !== undefined && !SAFE_AGENT_PATTERN.test(agentId)) {
    throw new Error(`Agent ID is not path-safe: ${agentId}`);
  }

  const relativeHome =
    policy.scope === "integration"
      ? `integrations/${integrationId}`
      : policy.scope === "agent"
        ? `agents/${agentId}/${integrationId}`
        : policy.path
            .replaceAll("{integrationId}", integrationId)
            .replaceAll("{agentId}", agentId ?? "shared");
  const home = resolve(integrationsDirectory, relativeHome);
  const relativeHomePath = relative(resolve(integrationsDirectory), home);
  if (
    relativeHomePath === ".." ||
    relativeHomePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativeHomePath)
  ) {
    throw new Error("Agent configuration home must remain beneath .nanasa/integrations");
  }
  return home;
}

export function agentConfigHomeEnvironment(
  kind: AgentKind,
  configHome: string,
): Record<string, string> {
  switch (kind) {
    case "copilot":
      return {
        COPILOT_HOME: configHome,
        COPILOT_CACHE_HOME: join(configHome, "cache"),
      };
    case "claude-code":
      return { CLAUDE_CONFIG_DIR: configHome };
    case "pi":
      return { PI_CODING_AGENT_DIR: configHome };
    case "opencode":
      return {
        XDG_CONFIG_HOME: join(configHome, "xdg-config"),
        XDG_DATA_HOME: join(configHome, "xdg-data"),
        XDG_STATE_HOME: join(configHome, "xdg-state"),
        XDG_CACHE_HOME: join(configHome, "xdg-cache"),
      };
  }
}
