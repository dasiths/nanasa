import {
  existsSync,
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
import type { EffectiveAgentPrompt } from "../src/instruction-resolver.js";

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

function provisioner(
  root: string,
  options: {
    piExtensionPath?: string;
    promptResolver?: () => EffectiveAgentPrompt;
  } = {},
) {
  return new AgentRuntimeProvisioner({
    integrationsDirectory: join(root, "integrations"),
    providerStates: {
      copilot: { scope: "integration" },
      "claude-code": { scope: "integration" },
      pi: { scope: "integration" },
      opencode: { scope: "integration" },
    },
    mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
    ...options,
  });
}

function reviewerPrompt(): EffectiveAgentPrompt {
  const text =
    "## builtin: nanasa\n\nCoordinate through Nanasa.\n\n## role: reviewer\n\nReview without editing.\n";
  return {
    roleId: "reviewer",
    role: {
      name: "Reviewer",
      instructions: [],
      permissionPolicy: "read-only",
    },
    text,
    revision: "a".repeat(64),
    sources: [
      { scope: "builtin", reference: "builtin:nanasa-coordination-v1" },
      { scope: "role", reference: ".nanasa/instructions/reviewer.md" },
    ],
  };
}

describe("AgentRuntimeProvisioner", () => {
  it("generates Copilot hooks and MCP config in its isolated home", () => {
    const root = temporaryDirectory();
    const runtimeProvisioner = provisioner(root);
    const configHome = join(root, "integrations", "integrations", "copilot", "state");
    const hooksDirectory = join(configHome, "hooks");
    mkdirSync(configHome, { recursive: true });
    writeFileSync(join(configHome, "settings.json"), JSON.stringify({ theme: "dim" }));

    const configured = runtimeProvisioner.provision(membership(), profile("copilot"));
    runtimeProvisioner.provision(membership(), profile("copilot"));
    const configPath = join(
      root,
      "integrations",
      "members",
      "membership_stable",
      "copilot",
      "mcp-config.json",
    );

    expect(configured).toEqual({
      command: ["copilot", "--additional-mcp-config", `@${configPath}`],
      environment: {
        COPILOT_HOME: configHome,
        COPILOT_CACHE_HOME: join(configHome, "cache"),
      },
    });
    expect(readJson(configPath)).toMatchObject({
      mcpServers: {
        nanasa: {
          type: "http",
          headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
        },
      },
    });
    expect(readJson(join(hooksDirectory, "nanasa-status-v1.json"))).toMatchObject({
      version: 1,
      hooks: {
        sessionStart: expect.any(Array),
        preToolUse: expect.any(Array),
        permissionRequest: expect.any(Array),
        agentStop: expect.any(Array),
        sessionEnd: expect.any(Array),
      },
    });
    expect(readJson(join(hooksDirectory, "nanasa-status-v1.json"))).toMatchObject({
      hooks: {
        sessionStart: [{ bash: expect.stringMatching(/copilot 'sessionStart'$/) }],
      },
    });
    expect(readFileSync(join(hooksDirectory, "nanasa-status-hook-v1.mjs"), "utf8")).not.toContain(
      "NANASA_MCP_TOKEN=",
    );
    expect(readJson(join(configHome, "settings.json"))).toEqual({ theme: "dim" });
  });

  it("uses an isolated Claude config for direct and wrapped launch commands", () => {
    const root = temporaryDirectory();
    const runtimeProvisioner = provisioner(root);
    const wrappedProfile = { ...profile("claude-code", "make"), args: ["claude-copilot"] };
    const configDirectory = join(root, "integrations", "integrations", "claude-code", "state");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      join(configDirectory, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        mcpServers: { existing: { type: "stdio", command: "existing" } },
      }),
    );
    writeFileSync(
      join(configDirectory, "settings.json"),
      JSON.stringify({
        theme: "dark",
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "user-hook" }] }],
        },
      }),
    );

    const configured = runtimeProvisioner.provision(membership(), wrappedProfile);
    runtimeProvisioner.provision(membership(), wrappedProfile);

    expect(configured).toEqual({
      command: ["make", "claude-copilot"],
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
    });
    expect(readJson(join(configDirectory, ".claude.json"))).toMatchObject({
      hasCompletedOnboarding: true,
      mcpServers: {
        existing: { type: "stdio", command: "existing" },
        nanasa: {
          type: "http",
          alwaysLoad: true,
          headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
        },
      },
    });
    expect(readJson(join(configDirectory, "settings.json"))).toMatchObject({
      theme: "dark",
      hooks: {
        SessionStart: expect.any(Array),
        PreToolUse: expect.any(Array),
        PermissionRequest: expect.any(Array),
        Stop: expect.any(Array),
        SessionEnd: expect.any(Array),
      },
    });
    expect(readJson(join(configDirectory, "settings.json"))).toMatchObject({
      hooks: {
        SessionStart: expect.arrayContaining([
          expect.objectContaining({
            hooks: [
              expect.objectContaining({
                args: [
                  expect.stringContaining("nanasa-status-hook.mjs"),
                  "claude-code",
                  "SessionStart",
                ],
              }),
            ],
          }),
        ]),
      },
    });
    const settings = readJson(join(configDirectory, "settings.json")) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(existsSync(join(configDirectory, ".credentials.json"))).toBe(false);
  });

  it("loads the official Pi adapter with persistent config and authentication", () => {
    const root = temporaryDirectory();
    const runtimeProvisioner = provisioner(root, {
      piExtensionPath: "/runtime/pi-mcp-adapter/index.ts",
    });
    const agentDirectory = join(root, "integrations", "integrations", "pi", "state");
    mkdirSync(agentDirectory, { recursive: true });
    writeFileSync(
      join(agentDirectory, "mcp.json"),
      JSON.stringify({
        customSetting: true,
        settings: { userSetting: "preserved" },
        mcpServers: { existing: { command: "existing-server" } },
      }),
    );

    const configured = runtimeProvisioner.provision(membership(), profile("pi"));
    runtimeProvisioner.provision(membership(), profile("pi"));
    const statusExtensionPath = join(agentDirectory, "nanasa-status-extension.mjs");

    expect(configured).toEqual({
      command: [
        "pi",
        "--extension",
        "/runtime/pi-mcp-adapter/index.ts",
        "--extension",
        statusExtensionPath,
      ],
      environment: { PI_CODING_AGENT_DIR: agentDirectory },
    });
    expect(readJson(join(agentDirectory, "mcp.json"))).toMatchObject({
      customSetting: true,
      settings: {
        userSetting: "preserved",
        directTools: true,
        hostConfigDiscovery: "off",
      },
      mcpServers: {
        existing: { command: "existing-server" },
        nanasa: {
          protocolVersion: "auto",
          lifecycle: "eager",
          headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
        },
      },
    });
    expect(readFileSync(statusExtensionPath, "utf8")).toContain('pi.on("agent_settled"');
    expect(statSync(statusExtensionPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(agentDirectory, "auth.json"))).toBe(false);
  });

  it("selects a persistent OpenCode config without replacing provider state", () => {
    const root = temporaryDirectory();
    const runtimeProvisioner = provisioner(root);
    const opencodeDirectory = join(root, "integrations", "integrations", "opencode", "state");
    const configPath = join(opencodeDirectory, "opencode.json");
    const configDirectory = join(opencodeDirectory, "nanasa-config");
    mkdirSync(opencodeDirectory, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "provider/model",
        plugin: ["user-plugin"],
        mcp: { existing: { type: "local", command: ["existing"] } },
      }),
    );

    const configured = runtimeProvisioner.provision(membership(), profile("opencode"));
    runtimeProvisioner.provision(membership(), profile("opencode"));

    expect(configured).toEqual({
      command: ["opencode"],
      environment: {
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: configDirectory,
        XDG_CONFIG_HOME: join(opencodeDirectory, "xdg-config"),
        XDG_DATA_HOME: join(opencodeDirectory, "xdg-data"),
        XDG_STATE_HOME: join(opencodeDirectory, "xdg-state"),
        XDG_CACHE_HOME: join(opencodeDirectory, "xdg-cache"),
      },
    });
    expect(readJson(configPath)).toMatchObject({
      model: "provider/model",
      plugin: ["user-plugin"],
      mcp: {
        existing: { type: "local", command: ["existing"] },
        nanasa: {
          type: "remote",
          oauth: false,
          headers: { Authorization: "Bearer {env:NANASA_MCP_TOKEN}" },
        },
      },
    });
    expect(readFileSync(join(configDirectory, "plugins", "nanasa-status.mjs"), "utf8")).toContain(
      "session.status",
    );
  });

  it.each(["copilot", "claude-code", "pi", "opencode"] as const)(
    "injects one frozen effective prompt for %s while enforcing a read-only role",
    (kind) => {
      const root = temporaryDirectory();
      const runtimeProvisioner = provisioner(root, {
        piExtensionPath: "/runtime/pi-mcp-adapter/index.ts",
        promptResolver: reviewerPrompt,
      });

      const configured = runtimeProvisioner.provision(membership(), profile(kind));
      const memberDirectory = join(root, "integrations", "members", "membership_stable", kind);
      const promptPath = join(memberDirectory, "instructions", "system-prompt-suffix.md");
      const manifestPath = join(memberDirectory, "instructions", "manifest.json");

      expect(readFileSync(promptPath, "utf8")).toContain("Review without editing.");
      expect(statSync(promptPath).mode & 0o777).toBe(0o600);
      expect(readJson(manifestPath)).toMatchObject({
        revision: "a".repeat(64),
        roleId: "reviewer",
        permissionPolicy: "read-only",
      });
      if (kind === "copilot") {
        expect(configured.command).toEqual(
          expect.arrayContaining([
            "--agent",
            expect.stringMatching(/^nanasa-/),
            "--deny-tool=write",
          ]),
        );
      } else if (kind === "claude-code") {
        expect(configured.command).toEqual(
          expect.arrayContaining(["--append-system-prompt-file", promptPath, "--disallowedTools"]),
        );
      } else if (kind === "pi") {
        expect(configured.command).toEqual(
          expect.arrayContaining(["--append-system-prompt", promptPath, "--extension"]),
        );
        expect(
          readFileSync(
            join(configured.environment.PI_CODING_AGENT_DIR!, "nanasa-read-only-policy.mjs"),
            "utf8",
          ),
        ).toContain('new Set(["bash", "edit", "write"])');
      } else {
        expect(configured.command).toEqual(
          expect.arrayContaining(["--agent", expect.stringMatching(/^nanasa-/)]),
        );
        const generated = Object.values(
          (readJson(configured.environment.OPENCODE_CONFIG!) as { agent: Record<string, unknown> })
            .agent,
        )[0];
        expect(generated).toMatchObject({
          mode: "primary",
          permission: { edit: "deny", bash: "deny" },
        });
      }
    },
  );

  it("forwards generated Claude arguments through the supported make wrapper", () => {
    const root = temporaryDirectory();
    const runtimeProvisioner = provisioner(root, { promptResolver: reviewerPrompt });
    const wrappedProfile = { ...profile("claude-code", "make"), args: ["claude-copilot"] };

    const configured = runtimeProvisioner.provision(membership(), wrappedProfile);

    expect(configured.command).toHaveLength(3);
    expect(configured.command.slice(0, 2)).toEqual(["make", "claude-copilot"]);
    expect(configured.command[2]).toContain("CLAUDE_ARGS='--append-system-prompt-file'");
    expect(configured.command[2]).toContain("'--disallowedTools' 'Edit'");
  });

  it("reuses private membership directories without persisting a capability", () => {
    const root = temporaryDirectory();
    const integrationsDirectory = join(root, "integrations");
    const runtimeProvisioner = provisioner(root);

    runtimeProvisioner.provision(membership(), profile("copilot"));
    runtimeProvisioner.provision(membership(), profile("copilot"));

    const membershipDirectory = join(integrationsDirectory, "members", "membership_stable");
    const configPath = join(membershipDirectory, "copilot", "mcp-config.json");
    expect(statSync(membershipDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, "utf8")).not.toContain("secret-run-token");
  });

  it("rejects a symlinked membership directory", () => {
    const root = temporaryDirectory();
    const integrationsDirectory = join(root, "integrations");
    const outside = join(root, "outside");
    mkdirSync(integrationsDirectory);
    mkdirSync(outside);
    mkdirSync(join(integrationsDirectory, "members"));
    symlinkSync(outside, join(integrationsDirectory, "members", "membership_stable"), "dir");
    const runtimeProvisioner = new AgentRuntimeProvisioner({
      integrationsDirectory,
      providerStates: { copilot: { scope: "membership" } },
      mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
    });

    expect(() => runtimeProvisioner.provision(membership(), profile("copilot"))).toThrow(
      "Agent runtime path must be a regular directory",
    );
  });

  it("resolves agent and custom homes without touching an external home", () => {
    const root = temporaryDirectory();
    const externalHome = join(root, "external-home");
    mkdirSync(externalHome);
    writeFileSync(join(externalHome, "sentinel"), "unchanged\n");
    const runtimeProvisioner = new AgentRuntimeProvisioner({
      integrationsDirectory: join(root, "integrations"),
      providerStates: {
        copilot: { scope: "membership" },
        pi: { scope: "custom", path: "custom/{integrationId}/{agentId}" },
      },
      mcpEndpointUrl: "http://127.0.0.1:3210/mcp",
      piExtensionPath: "/runtime/pi-mcp-adapter/index.ts",
    });

    const copilot = runtimeProvisioner.provision(membership(), profile("copilot"));
    const pi = runtimeProvisioner.provision(membership(), profile("pi"));

    expect(copilot.environment.COPILOT_HOME).toBe(
      join(root, "integrations", "members", "membership_stable", "copilot", "state"),
    );
    expect(pi.environment.PI_CODING_AGENT_DIR).toBe(
      join(root, "integrations", "custom", "pi", "membership_stable"),
    );
    expect(readFileSync(join(externalHome, "sentinel"), "utf8")).toBe("unchanged\n");
  });
});
