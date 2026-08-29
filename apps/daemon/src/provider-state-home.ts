import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentKind, ProviderStatePolicy } from "@nanasa/contracts";

const PLACEHOLDER_PATTERN = /\{([^}]+)\}/g;
const SAFE_INTEGRATION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_AGENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function validateProviderStatePolicy(policy: ProviderStatePolicy): void {
  if (policy.scope !== "custom") return;
  if (policy.path.includes("\0"))
    throw new Error("Provider state path may not contain NUL characters");
  if (isAbsolute(policy.path) || /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(policy.path)) {
    throw new Error("Provider state path must be relative to .nanasa/integrations");
  }
  const segments = policy.path.split(/[\\/]/).filter(Boolean);
  if (segments.includes(".."))
    throw new Error("Provider state path may not traverse outside integrations");
  const first = segments.find((segment) => segment !== ".");
  if (first === undefined)
    throw new Error("Provider state path must name a directory beneath integrations");
  if (["integrations", "members", "overlays"].includes(first)) {
    throw new Error(`Provider state path uses reserved directory ${first}`);
  }
  const placeholders = [...policy.path.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
  if (placeholders.some((name) => name !== "integrationId" && name !== "agentId")) {
    throw new Error("Provider state path contains an unknown placeholder");
  }
  if (
    /[{}]/.test(
      policy.path.replaceAll("{integrationId}", "integration").replaceAll("{agentId}", "agent"),
    )
  ) {
    throw new Error("Provider state path contains an invalid placeholder");
  }
}

export function resolveProviderStateHome(
  integrationsDirectory: string,
  integrationId: string,
  policy: ProviderStatePolicy,
  agentId?: string,
): string {
  validateProviderStatePolicy(policy);
  if (!SAFE_INTEGRATION_PATTERN.test(integrationId))
    throw new Error(`Integration ID is not path-safe: ${integrationId}`);
  if (policy.scope === "membership" && agentId === undefined) {
    throw new Error(`Integration ${integrationId} requires an agent-specific provider state home`);
  }
  if (agentId !== undefined && !SAFE_AGENT_PATTERN.test(agentId))
    throw new Error(`Agent ID is not path-safe: ${agentId}`);
  const relativeHome =
    policy.scope === "integration"
      ? `integrations/${integrationId}/state`
      : policy.scope === "membership"
        ? `members/${agentId}/${integrationId}/state`
        : policy.path
            .replaceAll("{integrationId}", integrationId)
            .replaceAll("{agentId}", agentId ?? "shared");
  const home = resolve(integrationsDirectory, relativeHome);
  const relativePath = relative(resolve(integrationsDirectory), home);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Provider state home must remain beneath .nanasa/integrations");
  }
  return home;
}

export function providerStateEnvironment(
  kind: AgentKind,
  stateHome: string,
): Record<string, string> {
  switch (kind) {
    case "copilot":
      return { COPILOT_HOME: stateHome, COPILOT_CACHE_HOME: join(stateHome, "cache") };
    case "claude-code":
      return { CLAUDE_CONFIG_DIR: stateHome };
    case "pi":
      return { PI_CODING_AGENT_DIR: stateHome };
    case "opencode":
      return {
        XDG_CONFIG_HOME: join(stateHome, "xdg-config"),
        XDG_DATA_HOME: join(stateHome, "xdg-data"),
        XDG_STATE_HOME: join(stateHome, "xdg-state"),
        XDG_CACHE_HOME: join(stateHome, "xdg-cache"),
      };
  }
}
