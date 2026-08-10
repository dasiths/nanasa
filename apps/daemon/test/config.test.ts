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
      agentTypes: {
        opencode: {
          key: "opencode",
          name: "OpenCode",
          kind: "opencode",
          command: ["opencode"],
          cwd: repository,
          environment: {},
        },
      },
    });
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
