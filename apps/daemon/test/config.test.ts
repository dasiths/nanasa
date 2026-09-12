import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigLoadError,
  discoverRepositoryRoot,
  loadNanasaConfig,
  nanasaPaths,
} from "../src/config-loader.js";
import { ConfigRepository } from "../src/config-repository.js";
import {
  NANASA_FOREMAN_INSTRUCTIONS,
  nanasaMcpServerInstructions,
} from "../src/coordination-instructions.js";
import {
  resolveEffectiveAgentPrompt,
  resolveEffectiveForemanPrompt,
} from "../src/instruction-resolver.js";

const temporaryDirectories: string[] = [];

function temporaryRepository(config: string): string {
  const repository = mkdtempSync(join(tmpdir(), "nanasa-config-"));
  temporaryDirectories.push(repository);
  mkdirSync(join(repository, ".git"));
  mkdirSync(join(repository, ".nanasa"));
  writeFileSync(join(repository, ".nanasa", "config.yaml"), config);
  return repository;
}

function validConfig(extra = ""): string {
  return `version: 2
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    command: [copilot]
${extra}`;
}

function minimalConfig(extra = ""): string {
  return `version: 2
integrations:
  opencode:
    name: OpenCode
    kind: opencode
    command: [opencode]
${extra}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Nanasa configuration", () => {
  it.each([
    "",
    "foreman: { integrationId: opencode, enabled: false }",
    "foreman: { integrationId: opencode, enabled: true }",
  ])("injects Foreman system guidance without user instruction files (%s)", (foreman) => {
    const repository = temporaryRepository(
      minimalConfig(`${foreman}
groups:
  team:
    name: Team
    agents:
      worker:
        memberId: worker
        name: Worker
        integrationId: opencode
`),
    );
    const config = loadNanasaConfig(repository).config;
    const prompt = resolveEffectiveAgentPrompt({
      repoRoot: repository,
      config,
      groupId: "team",
      agentId: "worker",
    });
    expect(prompt.sources).toEqual([
      { scope: "builtin", reference: "builtin:nanasa-coordination-v1" },
      { scope: "builtin", reference: "builtin:nanasa-assignment-v1" },
    ]);
    for (const instructions of [prompt.text, nanasaMcpServerInstructions()]) {
      expect(instructions).toContain("## Repository Foreman");
      expect(instructions).toContain("does not replace your team's project manager or the Human");
      expect(instructions).toContain("does not receive team broadcasts");
      expect(instructions).toContain("no unrestricted worker-to-Foreman DM tool");
      expect(instructions).toContain("nanasa.reply_foreman");
      expect(instructions).toContain("discover Foreman presence from its foreman summary");
      expect(instructions).toContain(
        "Empty requests or team_delegations lists do not mean Foreman is absent",
      );
      expect(instructions).toContain(
        "report concrete progress, blockers, and results with nanasa.report_progress",
      );
      expect(instructions).toContain(
        "not a direct message, a guaranteed immediate Foreman response",
      );
      expect(instructions).toContain("Deliver peer replies with nanasa.send_dm");
      expect(instructions).toContain("use nanasa.report_delegation with the delegation ID");
      expect(instructions).toContain(
        "Terminal output alone does not deliver a peer reply or delegation report",
      );
      expect(instructions).toContain("Work in your team's assigned checkout");
    }
  });

  it("injects the complete Foreman channel and delegation protocol without user instruction files", () => {
    const repository = temporaryRepository(
      minimalConfig("foreman: { integrationId: opencode, enabled: true }\n"),
    );
    const config = loadNanasaConfig(repository).config;
    expect(config.instructions).toEqual([]);
    expect(config.foreman?.instructions).toEqual([]);
    const prompt = resolveEffectiveForemanPrompt({ repoRoot: repository, config });
    expect(prompt.sources).toEqual([
      { scope: "builtin", reference: "builtin:nanasa-foreman-v1" },
      { scope: "builtin", reference: "builtin:nanasa-foreman-identity-v1" },
    ]);
    expect(prompt.text).toContain(NANASA_FOREMAN_INSTRUCTIONS);
    for (const tool of [
      "nanasa.foreman_bootstrap",
      "nanasa.foreman_read_channel",
      "nanasa.foreman_reply",
      "nanasa.foreman_discover_teams",
      "nanasa.foreman_delegate_goal",
      "nanasa.foreman_finish_goal_review",
    ]) {
      expect(prompt.text).toContain(tool);
    }
    expect(prompt.text).toContain("preserve its teamId exactly");
    expect(prompt.text).toContain("Terminal output alone is not a channel reply");
    expect(prompt.text).toContain("Converse with the Human and team members without a goal");
    expect(prompt.text).toContain("nanasa.foreman_ask_member");
    expect(prompt.text).toContain("end your turn so result wakeups can be delivered");
    expect(prompt.text).toContain("Do not use shell waits, sleep commands, or repeated polling");
    expect(prompt.text).toContain("nanasa.request_human_decision cannot approve a proposed goal");
    expect(prompt.text).toContain("Foreman cannot answer worker waits");
    expect(prompt.text).toContain("Never copy provider credentials between homes");
    expect(prompt.text).not.toContain("Prefer exact actions and typed wait replies");
  });

  it("requires the exact revision for config mutation and preserves comments", async () => {
    const source = `# Keep this repository comment\n${minimalConfig()}`;
    const repository = temporaryRepository(source);
    const configs = new ConfigRepository(repository);
    const revision = configs.load().status.revision!;
    expect(readFileSync(configs.load().configPath, "utf8")).toBe(source);
    const mutation = await configs.mutate(
      (config) => ({
        config: { ...config, messages: { retentionPerGroup: 200 } },
        result: undefined,
      }),
      revision,
    );
    expect(mutation.loaded.config.version).toBe(2);
    expect(readFileSync(mutation.loaded.configPath, "utf8")).toContain(
      "# Keep this repository comment",
    );
    await expect(
      configs.mutate((config) => ({ config, result: undefined }), revision),
    ).rejects.toThrow(/revision changed/);
  });

  it("persists and removes Foreman settings without dropping unrelated configuration", async () => {
    const repository = temporaryRepository(minimalConfig());
    const configs = new ConfigRepository(repository);
    const config = configs.load().config;
    const { ForemanConfigSchema } = await import("@nanasa/contracts");
    await configs.mutate((current) => ({
      config: { ...current, foreman: ForemanConfigSchema.parse({ integrationId: "opencode" }) },
      result: undefined,
    }));
    expect(configs.load().config.foreman?.integrationId).toBe("opencode");
    expect(configs.load().config.integrations).toEqual(config.integrations);
    await configs.mutate((current) => {
      const remaining = { ...current };
      delete remaining.foreman;
      return { config: remaining, result: undefined };
    });
    expect(configs.load().config.foreman).toBeUndefined();
  });

  it("resolves Foreman instructions independently of team roles with a stable revision", () => {
    const repository = temporaryRepository(
      minimalConfig(`
instructions: [.nanasa/global.md]
foreman:
  integrationId: opencode
  instructions: [.nanasa/foreman.md]
roles:
  reviewer:
    name: Reviewer
    instructions: [.nanasa/reviewer.md]
groups:
  team:
    name: Team
    instructions: [.nanasa/team.md]
`),
    );
    for (const file of ["global.md", "foreman.md", "reviewer.md", "team.md"]) {
      writeFileSync(join(repository, ".nanasa", file), `Instructions for ${file}\n`);
    }
    const input = { repoRoot: repository, config: loadNanasaConfig(repository).config };
    const prompt = resolveEffectiveForemanPrompt(input);
    expect(prompt.sources.map(({ scope }) => scope)).toEqual([
      "builtin",
      "builtin",
      "global",
      "foreman",
    ]);
    expect(prompt.text).toContain("nanasa.foreman_bootstrap");
    expect(prompt.text).toContain("not a member of any team");
    expect(prompt.text).toContain("Instructions for global.md");
    expect(prompt.text).toContain("Instructions for foreman.md");
    expect(prompt.text).not.toContain("Instructions for team.md");
    expect(prompt.text).not.toContain("Instructions for reviewer.md");
    expect(resolveEffectiveForemanPrompt(input).revision).toBe(prompt.revision);
    writeFileSync(join(repository, ".nanasa", "foreman.md"), "Changed operator guidance\n");
    expect(resolveEffectiveForemanPrompt(input).revision).not.toBe(prompt.revision);
  });

  it("rejects Foreman instruction aliases and duplicate instruction sources", () => {
    const repository = temporaryRepository(
      minimalConfig(`
foreman: { integrationId: opencode, instructions: [.nanasa/foreman.md] }
`),
    );
    writeFileSync(join(repository, ".nanasa", "foreman.md"), "Foreman guidance\n");
    const config = loadNanasaConfig(repository).config;
    expect(() =>
      resolveEffectiveForemanPrompt({
        repoRoot: repository,
        config: { ...config, instructions: [".nanasa/foreman.md"] },
      }),
    ).toThrow(/more than once/);
    rmSync(join(repository, ".nanasa", "foreman.md"));
    symlinkSync(join(repository, "outside.md"), join(repository, ".nanasa", "foreman.md"));
    writeFileSync(join(repository, "outside.md"), "Not an instruction source\n");
    expect(() => loadNanasaConfig(repository)).toThrow(ConfigLoadError);
  });

  it("loads Foreman goal limits and team roles in the current configuration schema", () => {
    const source = minimalConfig(`
foreman:
  integrationId: opencode
  instructions: [.nanasa/foreman.md]
  autonomy:
    maxActiveGoals: 2
    maxGoalHours: 8
roles:
  builder:
    name: Builder
    instructions: [.nanasa/builder.md]
`);
    const repository = temporaryRepository(source);
    for (const file of ["foreman.md", "builder.md", "team.md"]) {
      writeFileSync(join(repository, ".nanasa", file), `Instructions for ${file}\n`);
    }
    const loaded = loadNanasaConfig(repository);
    expect(loaded.config.version).toBe(2);
    expect(loaded.config.foreman).toMatchObject({
      integrationId: "opencode",
      enabled: false,
      autonomy: { mode: "supervised" },
    });
    expect(loaded.config.foreman?.autonomy).toMatchObject({ maxActiveGoals: 2, maxGoalHours: 8 });
    expect(loaded.config.roles.builder?.name).toBe("Builder");
    expect(loaded.config.groups).toEqual({});
    expect(readFileSync(loaded.configPath, "utf8")).toBe(source);
  });

  it.each([
    [3, "foreman: { integrationId: opencode }", ["version"]],
    [2, "foreman: { integrationId: missing }", ["foreman", "integrationId"]],
    [
      2,
      "foreman: { integrationId: opencode, autonomy: { permittedTeamTemplates: [missing] } }",
      ["foreman", "autonomy"],
    ],
    [
      2,
      "teamTemplates: { delivery: { members: { builder: { integrationId: opencode, roleId: missing } } } }",
      [],
    ],
  ])(
    "rejects version %s invalid Foreman references with a structured diagnostic",
    (version, fields, expectedPath) => {
      const repository = temporaryRepository(
        minimalConfig(`${fields}\n`).replace("version: 2", `version: ${version}`),
      );
      expect(() => loadNanasaConfig(repository)).toThrowError(
        expect.objectContaining({
          status: expect.objectContaining({
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: "invalid_config", path: expectedPath }),
            ]),
          }),
        }),
      );
    },
  );

  it.each(["foreman: { integrationId: opencode, instructions: [.nanasa/missing.md] }"])(
    "validates Foreman instruction files during load",
    (fields) => {
      const repository = temporaryRepository(minimalConfig(`${fields}\n`));
      expect(() => loadNanasaConfig(repository)).toThrowError(
        expect.objectContaining({
          status: expect.objectContaining({
            diagnostics: [expect.objectContaining({ code: "invalid_instruction_file" })],
          }),
        }),
      );
    },
  );

  it("loads valid YAML with deterministic revision and repository-local paths", () => {
    const repository = temporaryRepository(validConfig());
    const first = loadNanasaConfig(repository);
    const second = loadNanasaConfig(repository);

    expect(first.config.integrations.copilot).toMatchObject({
      id: "copilot",
      command: ["copilot"],
      cwd: repository,
      providerState: { scope: "membership" },
    });
    expect(Object.keys(first.config.integrations.copilot)).not.toEqual(
      expect.arrayContaining(["adapter", "capabilities", "recovery", "agentConfigHome"]),
    );
    expect(JSON.parse(JSON.stringify(first.config))).not.toMatchObject({
      integrations: { copilot: { adapter: expect.anything() } },
    });
    expect(first.status.revision).toBe(second.status.revision);
    expect(first.status.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(first.dataPath).toBe(join(repository, ".nanasa", "state", "nanasa.sqlite"));
    expect(first.runtimeDirectory).toBe(join(repository, ".nanasa", "runtime"));
  });

  it.each([
    ["copilot", "copilot"],
    ["claude-code", "claude"],
    ["pi", "pi"],
    ["opencode", "opencode"],
  ] as const)("defaults the %s command when omitted", (kind, executable) => {
    const repository = temporaryRepository(`version: 2
integrations:
  provider:
    name: Provider
    kind: ${kind}
`);

    expect(loadNanasaConfig(repository).config.integrations.provider).toMatchObject({
      command: [executable],
      commandSource: "builtin",
    });
    expect(loadNanasaConfig(repository).config.integrations.provider?.launcher).toBeUndefined();
  });

  it("preserves an explicit integration command override as a custom append launcher", () => {
    const repository = temporaryRepository(`version: 2
integrations:
  claude-copilot:
    name: Claude Code via GitHub Copilot
    kind: claude-code
    command: [make, claude-copilot]
`);

    expect(loadNanasaConfig(repository).config.integrations["claude-copilot"]).toMatchObject({
      command: ["make", "claude-copilot"],
      commandSource: "custom",
      launcher: { providerArguments: "append" },
    });
  });

  it("loads execution profiles and scoped provider MCP files without changing built-in origin", () => {
    const repository = temporaryRepository(`version: 2
executionProfiles:
  autonomous:
    continuation: autonomous
    questions: disabled
    approvals: unrestricted
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    executionProfile: autonomous
    providerFiles:
      mcp:
        paths: [.nanasa/providers/copilot/mcp.json]
groups:
  team:
    name: Team
    agents:
      worker:
        memberId: worker
        name: Worker
        integrationId: copilot
        providerFiles:
          mcp:
            mode: replace
            paths: [.nanasa/providers/copilot/worker.json]
`);

    const config = loadNanasaConfig(repository).config;
    expect(config.executionProfiles!.autonomous).toEqual({
      continuation: "autonomous",
      questions: "disabled",
      approvals: "unrestricted",
    });
    expect(config.integrations.copilot).toMatchObject({
      command: ["copilot"],
      commandSource: "builtin",
      executionProfile: "autonomous",
      providerFiles: {
        mcp: { mode: "append", paths: [".nanasa/providers/copilot/mcp.json"] },
      },
    });
    expect(config.groups.team?.agents.worker?.providerFiles).toEqual({
      mcp: { mode: "replace", paths: [".nanasa/providers/copilot/worker.json"] },
    });
  });

  it("rejects unknown execution profiles and invalid provider file selections", () => {
    const unknownProfile = temporaryRepository(`version: 2
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    executionProfile: missing
`);
    const invalidFiles = temporaryRepository(`version: 2
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    providerFiles:
      mcp:
        mode: disabled
        paths: [../outside.json]
`);

    expect(() => loadNanasaConfig(unknownProfile)).toThrow(ConfigLoadError);
    expect(() => loadNanasaConfig(invalidFiles)).toThrow(ConfigLoadError);
  });

  it("treats an explicit built-in executable as a custom command", () => {
    const repository = temporaryRepository(`version: 2
integrations:
  claude:
    name: Explicit Claude Code
    kind: claude-code
    command: [claude]
`);

    expect(loadNanasaConfig(repository).config.integrations.claude).toMatchObject({
      command: ["claude"],
      commandSource: "custom",
      launcher: { providerArguments: "append" },
    });
  });

  it("loads an environment provider-argument strategy for a custom command", () => {
    const repository = temporaryRepository(`version: 2
integrations:
  claude-wrapper:
    name: Claude wrapper
    kind: claude-code
    command: [sh, bin/claude-wrapper]
    launcher:
      providerArguments:
        kind: environment
        name: CLAUDE_ARGS
`);

    expect(loadNanasaConfig(repository).config.integrations["claude-wrapper"]?.launcher).toEqual({
      providerArguments: { kind: "environment", name: "CLAUDE_ARGS" },
    });
  });

  it.each([
    ["launcher without a command", "    launcher: { providerArguments: append }\n"],
    ["author-supplied command origin", "    commandSource: builtin\n"],
  ])("rejects %s", (_name, integrationFields) => {
    const repository = temporaryRepository(`version: 2
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
${integrationFields}`);

    expect(() => loadNanasaConfig(repository)).toThrow(ConfigLoadError);
  });

  it("loads minimal terminal-only YAML with canonical defaults", () => {
    const repository = temporaryRepository(minimalConfig());

    expect(loadNanasaConfig(repository).config).toEqual({
      version: 2,
      repository: { path: repository, checkout: { kind: "current" } },
      terminal: {
        checkpoints: {
          enabled: false,
          maxLines: 5_000,
          maxBytes: 1_048_576,
          retentionSeconds: 86_400,
          sensitivity: "repository-private",
        },
      },
      instructions: [],
      executionProfiles: {},
      attention: {
        defaults: {
          "response-required": true,
          "agent-health": true,
          completion: true,
          "delivery-failure": true,
          "action-state": false,
          "provider-update-failed": true,
          "provider-update-succeeded": false,
          "unread-message": false,
          "url-open-request": true,
        },
      },
      roles: {},
      extensions: {},
      integrations: {
        opencode: {
          id: "opencode",
          name: "OpenCode",
          kind: "opencode",
          command: ["opencode"],
          commandSource: "custom",
          launcher: { providerArguments: "append" },
          cwd: repository,
          providerState: { scope: "membership" },
          credentials: { kind: "provider-managed" },
          model: { resumePolicy: "preserve-session" },
          nativeRecovery: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
          extensions: [],
          environment: {},
        },
      },
      groups: {},
      messages: { retentionPerGroup: 1_000 },
    });
  });

  it("loads authored Attention defaults", () => {
    const repository = temporaryRepository(`${minimalConfig()}attention:
  defaults:
    response-required: false
    agent-health: false
    completion: false
    delivery-failure: false
    action-state: false
    provider-update-failed: false
    provider-update-succeeded: false
    unread-message: false
`);

    expect(loadNanasaConfig(repository).config.attention.defaults).toEqual({
      "response-required": false,
      "agent-health": false,
      completion: false,
      "delivery-failure": false,
      "action-state": false,
      "provider-update-failed": false,
      "provider-update-succeeded": false,
      "unread-message": false,
      "url-open-request": true,
    });
  });

  it("loads role, group, and direct agent instructions", () => {
    const repository = temporaryRepository(`${minimalConfig()}
instructions: [.nanasa/instructions/team.md]
roles:
  reviewer:
    name: Reviewer
    description: Reviews changes without modifying them
    instructions: [.nanasa/instructions/reviewer.md]
    permissionPolicy: read-only
groups:
  group_one:
    name: Team
    instructions: [.nanasa/instructions/group.md]
    agents:
      agent_one:
        memberId: opencode.reviewer
        name: Reviewer
        integrationId: opencode
        roleId: reviewer
        instructions: [.nanasa/instructions/agent.md]
        order: 2
`);
    const instructionDirectory = join(repository, ".nanasa", "instructions");
    mkdirSync(instructionDirectory);
    writeFileSync(join(instructionDirectory, "team.md"), "Coordinate through Nanasa.\r\n");
    writeFileSync(join(instructionDirectory, "group.md"), "Deliver the group objective.\n");
    writeFileSync(join(instructionDirectory, "reviewer.md"), "Report findings by severity.\n");
    writeFileSync(join(instructionDirectory, "agent.md"), "Review the API package.\n");

    const loaded = loadNanasaConfig(repository);
    expect(loaded.config.roles.reviewer?.permissionPolicy).toBe("read-only");
    expect(loaded.config.groups.group_one?.agents.agent_one).toMatchObject({
      memberId: "opencode.reviewer",
      name: "Reviewer",
      integrationId: "opencode",
      roleId: "reviewer",
      instructions: [".nanasa/instructions/agent.md"],
      order: 2,
    });
    const prompt = resolveEffectiveAgentPrompt({
      repoRoot: repository,
      config: loaded.config,
      groupId: "group_one",
      agentId: "agent_one",
    });
    expect(prompt.roleId).toBe("reviewer");
    expect(prompt.role?.permissionPolicy).toBe("read-only");
    expect(prompt.sources.map((source) => source.scope)).toEqual([
      "builtin",
      "builtin",
      "global",
      "group",
      "role",
      "agent",
    ]);
    expect(prompt.text.indexOf("Coordinate through Nanasa.")).toBeLessThan(
      prompt.text.indexOf("Deliver the group objective."),
    );
    expect(prompt.text.indexOf("Deliver the group objective.")).toBeLessThan(
      prompt.text.indexOf("Report findings by severity."),
    );
    expect(prompt.text.indexOf("Report findings by severity.")).toBeLessThan(
      prompt.text.indexOf("Review the API package."),
    );
  });

  it("rejects missing instruction files during configuration loading", () => {
    const repository = temporaryRepository(`${minimalConfig()}
instructions: [.nanasa/instructions/missing.md]
`);

    expect(() => loadNanasaConfig(repository)).toThrowError(
      expect.objectContaining({
        status: expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: "invalid_instruction_file" })],
        }),
      }),
    );
  });

  it("rejects duplicate and NUL-bearing instruction content", () => {
    const duplicateRepository = temporaryRepository(`${minimalConfig()}
instructions: [.nanasa/instructions/shared.md]
roles:
  reviewer:
    name: Reviewer
    instructions: [.nanasa/instructions/shared.md]
`);
    mkdirSync(join(duplicateRepository, ".nanasa", "instructions"));
    writeFileSync(join(duplicateRepository, ".nanasa", "instructions", "shared.md"), "Shared\n");
    expect(() => loadNanasaConfig(duplicateRepository)).toThrow(ConfigLoadError);

    const nulRepository = temporaryRepository(`${minimalConfig()}
instructions: [.nanasa/instructions/nul.md]
`);
    mkdirSync(join(nulRepository, ".nanasa", "instructions"));
    writeFileSync(join(nulRepository, ".nanasa", "instructions", "nul.md"), "before\0after");
    expect(() => loadNanasaConfig(nulRepository)).toThrow(ConfigLoadError);
  });

  it("discovers the nearest config before falling back to a Git root", () => {
    const repository = temporaryRepository(validConfig());
    const child = join(repository, "packages", "nested");
    mkdirSync(child, { recursive: true });
    expect(discoverRepositoryRoot(child)).toBe(repository);

    rmSync(join(repository, ".nanasa", "config.yaml"));
    expect(discoverRepositoryRoot(child)).toBe(repository);
    expect(nanasaPaths(repository).configPath).toBe(join(repository, ".nanasa", "config.yaml"));
  });

  it("loads agent and repository-local custom configuration homes", () => {
    const agentRepository = temporaryRepository(
      validConfig("    providerState: { scope: membership }\n"),
    );
    expect(loadNanasaConfig(agentRepository).config.integrations.copilot.providerState).toEqual({
      scope: "membership",
    });

    const customRepository = temporaryRepository(
      validConfig(
        '    providerState: { scope: custom, path: "homes/{integrationId}/{agentId}" }\n',
      ),
    );
    expect(loadNanasaConfig(customRepository).config.integrations.copilot.providerState).toEqual({
      scope: "custom",
      path: "homes/{integrationId}/{agentId}",
    });
  });

  it.each([
    ["version", validConfig().replace("version: 2", "version: 1")],
    ["agentTypes", validConfig().replace("integrations:", "agentTypes:")],
    ["agentProfiles", `${validConfig()}agentProfiles: {}\n`],
    ["memberships", `${validConfig()}groups:\n  group_one:\n    name: Team\n    memberships: {}\n`],
  ])("rejects the legacy %s vocabulary", (_name, source) => {
    const repository = temporaryRepository(source);
    expect(() => loadNanasaConfig(repository)).toThrow(ConfigLoadError);
  });

  it("rejects integrations that resolve to the same configuration home", () => {
    const repository = temporaryRepository(`version: 2
integrations:
  first:
    name: First
    kind: copilot
    command: [copilot]
    providerState: { scope: custom, path: shared }
  second:
    name: Second
    kind: pi
    command: [pi]
    providerState: { scope: custom, path: shared }
`);

    expect(() => loadNanasaConfig(repository)).toThrowError(
      expect.objectContaining({
        status: expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: "provider_state_collision" })],
        }),
      }),
    );
  });

  it.each([
    ["duplicate keys", validConfig("  copilot:\n    name: Duplicate\n")],
    [
      "aliases",
      `version: 2
integrations:
  copilot: &agent
    name: GitHub Copilot
    kind: copilot
    command: [copilot]
  second: *agent
`,
    ],
    [
      "merge keys",
      `base: &base
  name: Base
version: 2
integrations:
  copilot:
    <<: *base
    kind: copilot
    command: [copilot]
`,
    ],
    ["custom tags", validConfig("    environment: !unsafe {}\n")],
    ["multiple documents", `${validConfig()}---\n${validConfig()}`],
    ["unknown properties", validConfig("    unknown: true\n")],
    ["empty argv", validConfig().replace("command: [copilot]", "command: []")],
    ["discarded adapter", validConfig("    adapter: terminal\n")],
    ["dangerous environment", validConfig("    environment: { NODE_OPTIONS: --inspect }\n")],
    [
      "external configuration home",
      validConfig("    providerState: { scope: custom, path: ../../outside }\n"),
    ],
    [
      "unknown configuration home placeholder",
      validConfig('    providerState: { scope: custom, path: "homes/{runId}" }\n'),
    ],
    [
      "Windows absolute configuration home",
      validConfig('    providerState: { scope: custom, path: "C:\\\\outside" }\n'),
    ],
    [
      "reserved configuration home namespace",
      validConfig("    providerState: { scope: custom, path: integrations/shared }\n"),
    ],
    [
      "integration root as configuration home",
      validConfig("    providerState: { scope: custom, path: . }\n"),
    ],
  ])("rejects %s", (_name, source) => {
    const repository = temporaryRepository(source);
    expect(() => loadNanasaConfig(repository)).toThrow(ConfigLoadError);
  });

  it("rejects lexical and symlink working-directory escapes", () => {
    const lexicalRepository = temporaryRepository(validConfig("    cwd: ../\n"));
    expect(() => loadNanasaConfig(lexicalRepository)).toThrowError(
      expect.objectContaining({ status: expect.objectContaining({ state: "error" }) }),
    );

    const symlinkRepository = temporaryRepository(validConfig("    cwd: outside\n"));
    symlinkSync(dirname(symlinkRepository), join(symlinkRepository, "outside"));
    expect(() => loadNanasaConfig(symlinkRepository)).toThrow(ConfigLoadError);
  });

  it("rejects oversized and deeply nested structures", () => {
    const oversized = temporaryRepository(`${validConfig()}# ${"x".repeat(256 * 1024)}\n`);
    expect(() => loadNanasaConfig(oversized)).toThrow(ConfigLoadError);

    const nested = `${validConfig("    environment:\n")}${Array.from(
      { length: 24 },
      (_, index) => `${" ".repeat(6 + index * 2)}level${index}:\n`,
    ).join("")}      value: end\n`;
    const deep = temporaryRepository(nested);
    expect(() => loadNanasaConfig(deep)).toThrow(ConfigLoadError);
  });
});
