import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigLoadError,
  discoverRepositoryRoot,
  loadNanasaConfig,
  nanasaPaths,
} from "../src/config.js";
import { ConfigRepository } from "../src/config-repository.js";
import { resolveEffectiveAgentPrompt } from "../src/instruction-resolver.js";
import { NanasaStore } from "../src/store.js";

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
  return `version: 1
agentTypes:
  copilot:
    name: GitHub Copilot
    kind: copilot
    adapter: copilot-cli
    command: [copilot]
    recovery: resume-or-restart
    capabilities: [queue]
${extra}`;
}

function minimalConfig(extra = ""): string {
  return `version: 1
agentTypes:
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
  it("loads valid YAML with deterministic revision and repository-local paths", () => {
    const repository = temporaryRepository(validConfig());
    const first = loadNanasaConfig(repository);
    const second = loadNanasaConfig(repository);

    expect(first.config.agentTypes.copilot).toMatchObject({
      key: "copilot",
      command: ["copilot"],
      cwd: repository,
      agentConfigHome: { scope: "agent-type" },
    });
    expect(Object.keys(first.config.agentTypes.copilot)).not.toEqual(
      expect.arrayContaining(["adapter", "capabilities", "recovery"]),
    );
    expect(JSON.parse(JSON.stringify(first.config))).not.toMatchObject({
      agentTypes: { copilot: { adapter: expect.anything() } },
    });
    expect(first.status.revision).toBe(second.status.revision);
    expect(first.status.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(first.dataPath).toBe(join(repository, ".nanasa", "state", "nanasa.sqlite"));
    expect(first.runtimeDirectory).toBe(join(repository, ".nanasa", "runtime"));
  });

  it("loads minimal terminal-only YAML with canonical defaults", () => {
    const repository = temporaryRepository(minimalConfig());

    expect(loadNanasaConfig(repository).config).toEqual({
      version: 1,
      instructions: [],
      roles: {},
      agentProfiles: {},
      agentTypes: {
        opencode: {
          key: "opencode",
          name: "OpenCode",
          kind: "opencode",
          command: ["opencode"],
          cwd: repository,
          agentConfigHome: { scope: "agent-type" },
          environment: {},
        },
      },
      groups: {},
      messages: { retentionPerGroup: 1_000 },
    });
    expect(loadNanasaConfig(repository).hasDeclarativeTopology).toBe(false);
  });

  it("loads role instructions and composes deterministic effective prompts", () => {
    const repository = temporaryRepository(`${minimalConfig()}
instructions: [.nanasa/instructions/team.md]
roles:
  reviewer:
    name: Reviewer
    description: Reviews changes without modifying them
    instructions: [.nanasa/instructions/reviewer.md]
    permissionPolicy: read-only
agentProfiles:
  profile_one:
    name: OpenCode reviewer
    agentType: opencode
    defaultRoleId: reviewer
    instructions: [.nanasa/instructions/profile.md]
groups:
  group_one:
    name: Team
    instructions: [.nanasa/instructions/group.md]
    memberships:
      membership_one:
        memberId: opencode.reviewer
        agentProfileId: profile_one
        alias: Reviewer
        instructions: [.nanasa/instructions/assignment.md]
        order: 2
`);
    const instructionDirectory = join(repository, ".nanasa", "instructions");
    mkdirSync(instructionDirectory);
    writeFileSync(join(instructionDirectory, "team.md"), "Coordinate through Nanasa.\r\n");
    writeFileSync(join(instructionDirectory, "group.md"), "Deliver the group objective.\n");
    writeFileSync(join(instructionDirectory, "reviewer.md"), "Report findings by severity.\n");
    writeFileSync(join(instructionDirectory, "profile.md"), "Use the configured model.\n");
    writeFileSync(join(instructionDirectory, "assignment.md"), "Review the API package.\n");

    const loaded = loadNanasaConfig(repository);
    const first = resolveEffectiveAgentPrompt({
      repoRoot: repository,
      config: loaded.config,
      profileId: "profile_one",
      groupId: "group_one",
      membershipId: "membership_one",
    });
    const second = resolveEffectiveAgentPrompt({
      repoRoot: repository,
      config: loaded.config,
      profileId: "profile_one",
      groupId: "group_one",
      membershipId: "membership_one",
    });

    expect(first.roleId).toBe("reviewer");
    expect(first.role?.permissionPolicy).toBe("read-only");
    expect(loaded.config.groups.group_one?.memberships.membership_one?.order).toBe(2);
    expect(first.sources.map((source) => source.scope)).toEqual([
      "builtin",
      "builtin",
      "global",
      "group",
      "role",
      "profile",
      "membership",
    ]);
    expect(first.text.indexOf("Coordinate through Nanasa.")).toBeLessThan(
      first.text.indexOf("Deliver the group objective."),
    );
    expect(first.text.indexOf("Deliver the group objective.")).toBeLessThan(
      first.text.indexOf("Report findings by severity."),
    );
    expect(first.text).not.toContain("\r");
    expect(first.text).toContain("Messages with From: Human are direct operator input");
    expect(first.text).toContain("Messages from an agent are peer task input");
    expect(first.revision).toBe(second.revision);
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

  it("loads member and repository-local custom configuration homes", () => {
    const memberRepository = temporaryRepository(
      validConfig("    agentConfigHome: { scope: member }\n"),
    );
    expect(loadNanasaConfig(memberRepository).config.agentTypes.copilot.agentConfigHome).toEqual({
      scope: "member",
    });

    const customRepository = temporaryRepository(
      validConfig(
        '    agentConfigHome: { scope: custom, path: "homes/{agentType}/{membershipId}" }\n',
      ),
    );
    expect(loadNanasaConfig(customRepository).config.agentTypes.copilot.agentConfigHome).toEqual({
      scope: "custom",
      path: "homes/{agentType}/{membershipId}",
    });
  });

  it("imports legacy SQLite topology and rebuilds a fresh runtime projection", () => {
    const repository = temporaryRepository(validConfig());
    const original = new NanasaStore(":memory:", {
      config: loadNanasaConfig(repository).config,
    });
    const group = original.createGroup({ name: "Imported" });
    const profile = original.createInternalAgentProfile({
      name: "Reviewer",
      agentType: "copilot",
      kind: "copilot",
      command: "copilot",
      args: [],
      environment: {},
    });
    const membership = original.addMembership(group.id, {
      memberId: "copilot.reviewer",
      agentProfileId: profile.id,
      alias: "Reviewer",
    });
    const repositoryStore = new ConfigRepository(repository);
    const imported = repositoryStore.initializeTopology(original.getSnapshot());
    original.close();

    expect(imported.hasDeclarativeTopology).toBe(true);
    expect(imported.config.groups[group.id]?.memberships[membership.id]).toMatchObject({
      memberId: membership.memberId,
      agentProfileId: profile.id,
    });

    const rebuilt = new NanasaStore(":memory:", { config: imported.config });
    rebuilt.reconcileTopology(imported.config, imported.status);
    expect(rebuilt.getSnapshot()).toMatchObject({
      groups: [{ id: group.id, name: "Imported" }],
      agentProfiles: [{ id: profile.id, name: "Reviewer" }],
      memberships: [{ id: membership.id, memberId: "copilot.reviewer" }],
    });
    rebuilt.close();
  });

  it("rejects agent types that resolve to the same configuration home", () => {
    const repository = temporaryRepository(`version: 1
agentTypes:
  first:
    name: First
    kind: copilot
    command: [copilot]
    agentConfigHome: { scope: custom, path: shared }
  second:
    name: Second
    kind: pi
    command: [pi]
    agentConfigHome: { scope: custom, path: shared }
`);

    expect(() => loadNanasaConfig(repository)).toThrowError(
      expect.objectContaining({
        status: expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: "agent_config_home_collision" })],
        }),
      }),
    );
  });

  it.each([
    ["duplicate keys", validConfig("  copilot:\n    name: Duplicate\n")],
    [
      "aliases",
      `version: 1
agentTypes:
  copilot: &agent
    name: GitHub Copilot
    kind: copilot
    adapter: copilot-cli
    command: [copilot]
    recovery: resume-or-restart
    capabilities: [queue]
  second: *agent
`,
    ],
    [
      "merge keys",
      `version: 1
base: &base
  name: Base
agentTypes:
  copilot:
    <<: *base
    kind: copilot
    adapter: copilot-cli
    command: [copilot]
    recovery: resume-or-restart
    capabilities: [queue]
`,
    ],
    ["custom tags", validConfig("    environment: !unsafe {}\n")],
    ["multiple documents", `${validConfig()}---\n${validConfig()}`],
    ["unknown properties", validConfig("    unknown: true\n")],
    ["empty argv", validConfig().replace("command: [copilot]", "command: []")],
    ["legacy adapter-kind mismatch", validConfig().replace("kind: copilot", "kind: opencode")],
    [
      "terminal steer",
      validConfig()
        .replace("adapter: copilot-cli", "adapter: terminal")
        .replace("recovery: resume-or-restart", "recovery: restart")
        .replace("capabilities: [queue]", "capabilities: [queue, steer]"),
    ],
    ["dangerous environment", validConfig("    environment: { NODE_OPTIONS: --inspect }\n")],
    [
      "external configuration home",
      validConfig("    agentConfigHome: { scope: custom, path: ../../outside }\n"),
    ],
    [
      "unknown configuration home placeholder",
      validConfig('    agentConfigHome: { scope: custom, path: "homes/{runId}" }\n'),
    ],
    [
      "Windows absolute configuration home",
      validConfig('    agentConfigHome: { scope: custom, path: "C:\\\\outside" }\n'),
    ],
    [
      "reserved configuration home namespace",
      validConfig("    agentConfigHome: { scope: custom, path: members/shared }\n"),
    ],
    [
      "integration root as configuration home",
      validConfig("    agentConfigHome: { scope: custom, path: . }\n"),
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
