import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKind, AgentProfile, GroupMembership } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { AgentRuntimeProvisioner } from "../src/agent-runtime-provisioner.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-10T12:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-agent-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function membership(id = "membership_stable"): GroupMembership {
  return {
    id,
    groupId: "group_one",
    memberId: "member_one",
    agentProfileId: "profile_one",
    alias: "Agent One",
    state: "active",
    joinedAt: timestamp,
  };
}

function profile(kind: AgentKind, command = kind): AgentProfile {
  return {
    id: "profile_one",
    name: "Agent profile",
    agentType: kind,
    kind,
    command,
    args: [],
    environment: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("AgentRuntimeProvisioner", () => {
  it("generates Copilot MCP config without replacing its authentication home", () => {
    const root = temporaryDirectory();
    const provisioner = new AgentRuntimeProvisioner({
      agentsDirectory: join(root, "agents"),
      mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
    });

    const configured = provisioner.provision(membership(), profile("copilot"));
    const configPath = join(root, "agents", "membership_stable", "copilot", "mcp-config.json");

    expect(configured).toEqual({
      command: ["copilot", "--additional-mcp-config", `@${configPath}`],
      environment: {},
    });
    expect(readJson(configPath)).toMatchObject({
      mcpServers: {
        nanasa: {
          type: "http",
          headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
        },
      },
    });
  });

  it("uses an isolated Claude config for direct and wrapped launch commands", () => {
    const root = temporaryDirectory();
    const credentials = join(root, "claude-credentials.json");
    writeFileSync(credentials, "{}\n");
    const provisioner = new AgentRuntimeProvisioner({
      agentsDirectory: join(root, "agents"),
      mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
      claudeCredentialsPath: credentials,
    });
    const wrappedProfile = { ...profile("claude-code", "make"), args: ["claude-copilot"] };

    const configured = provisioner.provision(membership(), wrappedProfile);
    const configDirectory = join(root, "agents", "membership_stable", "claude");

    expect(configured).toEqual({
      command: ["make", "claude-copilot"],
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
    });
    expect(readJson(join(configDirectory, ".claude.json"))).toMatchObject({
      mcpServers: {
        nanasa: {
          type: "http",
          alwaysLoad: true,
          headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
        },
      },
    });
    expect(lstatSync(join(configDirectory, ".credentials.json")).isSymbolicLink()).toBe(true);
  });

  it("loads the official Pi adapter with persistent config and authentication", () => {
    const root = temporaryDirectory();
    const auth = join(root, "pi-auth.json");
    writeFileSync(auth, "{}\n");
    const provisioner = new AgentRuntimeProvisioner({
      agentsDirectory: join(root, "agents"),
      mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
      piExtensionPath: "/runtime/pi-mcp-adapter/index.ts",
      piAuthPath: auth,
    });

    const configured = provisioner.provision(membership(), profile("pi"));
    const agentDirectory = join(root, "agents", "membership_stable", "pi");

    expect(configured).toEqual({
      command: ["pi", "--extension", "/runtime/pi-mcp-adapter/index.ts"],
      environment: { PI_CODING_AGENT_DIR: agentDirectory },
    });
    expect(readJson(join(agentDirectory, "mcp.json"))).toMatchObject({
      settings: { directTools: true, hostConfigDiscovery: "off" },
      mcpServers: {
        nanasa: {
          protocolVersion: "auto",
          lifecycle: "eager",
          headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
        },
      },
    });
    expect(lstatSync(join(agentDirectory, "auth.json")).isSymbolicLink()).toBe(true);
  });

  it("selects a persistent OpenCode config without replacing provider state", () => {
    const root = temporaryDirectory();
    const provisioner = new AgentRuntimeProvisioner({
      agentsDirectory: join(root, "agents"),
      mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
    });

    const configured = provisioner.provision(membership(), profile("opencode"));
    const configPath = join(root, "agents", "membership_stable", "opencode", "opencode.json");

    expect(configured).toEqual({
      command: ["opencode"],
      environment: { OPENCODE_CONFIG: configPath },
    });
    expect(readJson(configPath)).toMatchObject({
      mcp: {
        nanasa: {
          type: "remote",
          oauth: false,
          headers: { Authorization: "Bearer {env:NANASA_MCP_TOKEN}" },
        },
      },
    });
  });

  it("reuses private membership directories without persisting a capability", () => {
    const root = temporaryDirectory();
    const agentsDirectory = join(root, "agents");
    const provisioner = new AgentRuntimeProvisioner({
      agentsDirectory,
      mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
    });

    provisioner.provision(membership(), profile("copilot"));
    provisioner.provision(membership(), profile("copilot"));

    const membershipDirectory = join(agentsDirectory, "membership_stable");
    const configPath = join(membershipDirectory, "copilot", "mcp-config.json");
    expect(statSync(membershipDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, "utf8")).not.toContain("secret-run-token");
  });

  it("rejects a symlinked membership directory", () => {
    const root = temporaryDirectory();
    const agentsDirectory = join(root, "agents");
    const outside = join(root, "outside");
    mkdirSync(agentsDirectory);
    mkdirSync(outside);
    symlinkSync(outside, join(agentsDirectory, "membership_stable"), "dir");
    const provisioner = new AgentRuntimeProvisioner({
      agentsDirectory,
      mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
    });

    expect(() => provisioner.provision(membership(), profile("copilot"))).toThrow(
      "Agent runtime path must be a regular directory",
    );
  });
});
