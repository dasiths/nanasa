import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentConfigHome, AgentKind } from "@nanasa/contracts";

const PLACEHOLDER_PATTERN = /\{([^}]+)\}/g;
const SAFE_AGENT_TYPE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_MEMBERSHIP_PATTERN = /^membership_[A-Za-z0-9-]+$/;

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
  if (firstSegment === "agent-types" || firstSegment === "members") {
    throw new Error(`Agent configuration home path uses reserved directory ${firstSegment}`);
  }
  const placeholders = [...policy.path.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
  if (placeholders.some((name) => name !== "agentType" && name !== "membershipId")) {
    throw new Error("Agent configuration home path contains an unknown placeholder");
  }
  if (
    policy.path
      .replaceAll("{agentType}", "agent")
      .replaceAll("{membershipId}", "member")
      .match(/[{}]/) !== null
  ) {
    throw new Error("Agent configuration home path contains an invalid placeholder");
  }
}

export function resolveAgentConfigHome(
  integrationsDirectory: string,
  agentType: string,
  policy: AgentConfigHome,
  membershipId?: string,
): string {
  validateAgentConfigHome(policy);
  if (!SAFE_AGENT_TYPE_PATTERN.test(agentType)) {
    throw new Error(`Agent type is not path-safe: ${agentType}`);
  }
  if (policy.scope === "member" && membershipId === undefined) {
    throw new Error(`Agent type ${agentType} requires a membership-specific configuration home`);
  }
  if (membershipId !== undefined && !SAFE_MEMBERSHIP_PATTERN.test(membershipId)) {
    throw new Error(`Membership ID is not path-safe: ${membershipId}`);
  }

  const relativeHome =
    policy.scope === "agent-type"
      ? `agent-types/${agentType}`
      : policy.scope === "member"
        ? `members/${membershipId}/${agentType}`
        : policy.path
            .replaceAll("{agentType}", agentType)
            .replaceAll("{membershipId}", membershipId ?? "shared");
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
