import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { loadNanasaConfig } from "../src/config-loader.js";
import { resolveEffectiveAgentPrompt } from "../src/instruction-resolver.js";
import { resolveProviderStateHome } from "../src/provider-state-home.js";
import { ProviderStateRepository } from "../src/provider-state-repository.js";
import { UserCredentialBroker } from "../src/user-credential-broker.js";

const examplesRoot = fileURLToPath(new URL("../../../docs/next/examples/", import.meta.url));
const temporaryDirectories: string[] = [];

function temporaryGitRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "nanasa-doc-example-"));
  temporaryDirectories.push(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  mkdirSync(join(repository, ".nanasa"));
  return repository;
}

function copyConfigExample(relativePath: string): string {
  const repository = temporaryGitRepository();
  const source = join(examplesRoot, relativePath);
  copyFileSync(source, join(repository, ".nanasa", "config.yaml"));
  const instructionSource = join(dirname(source), "instructions");
  if (statExists(instructionSource)) {
    cpSync(instructionSource, join(repository, ".nanasa", "instructions"), { recursive: true });
  }
  return repository;
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("tested documentation examples", () => {
  it("loads the minimal one-agent setup from a Git repository", () => {
    const repository = copyConfigExample("minimal/config.yaml");
    const loaded = loadNanasaConfig(repository);

    expect(loaded.config.version).toBe(2);
    expect(loaded.config.integrations.copilot).toMatchObject({
      kind: "copilot",
      command: ["copilot"],
      providerState: { scope: "membership" },
    });
    expect(loaded.config.groups["starter-team"]?.agents.agent_builder).toMatchObject({
      memberId: "copilot.builder",
      integrationId: "copilot",
    });
  });

  it("resolves first-team instructions in global, group, role, and agent order", () => {
    const repository = copyConfigExample("first-team/config.yaml");
    const loaded = loadNanasaConfig(repository);
    const providerStates = new ProviderStateRepository(loaded.integrationsDirectory);
    const cases = [
      {
        agentId: "agent_builder",
        permissionPolicy: "inherit",
        rolePath: ".nanasa/instructions/implementor.md",
        agentPath: ".nanasa/instructions/builder.md",
      },
      {
        agentId: "agent_reviewer",
        permissionPolicy: "read-only",
        rolePath: ".nanasa/instructions/reviewer.md",
        agentPath: ".nanasa/instructions/review-agent.md",
      },
    ] as const;

    for (const example of cases) {
      const prompt = resolveEffectiveAgentPrompt({
        repoRoot: repository,
        config: loaded.config,
        groupId: "first-team",
        agentId: example.agentId,
      });
      expect(prompt.role?.permissionPolicy).toBe(example.permissionPolicy);
      expect(prompt.sources).toEqual([
        { scope: "builtin", reference: "builtin:nanasa-coordination-v1" },
        { scope: "builtin", reference: "builtin:nanasa-assignment-v1" },
        { scope: "global", reference: ".nanasa/instructions/global.md" },
        { scope: "group", reference: ".nanasa/instructions/team.md" },
        { scope: "role", reference: example.rolePath },
        { scope: "agent", reference: example.agentPath },
      ]);
      expect(prompt.text.indexOf("# Repository instructions")).toBeLessThan(
        prompt.text.indexOf("# Team instructions"),
      );
      expect(prompt.text.indexOf("# Team instructions")).toBeLessThan(
        prompt.text.indexOf(
          example.agentId === "agent_builder"
            ? "# Implementor instructions"
            : "# Reviewer instructions",
        ),
      );
      expect(prompt.text.indexOf(example.rolePath)).toBeLessThan(
        prompt.text.indexOf(example.agentPath),
      );

      const configuredAgent = loaded.config.groups["first-team"]!.agents[example.agentId]!;
      const integration = loaded.config.integrations[configuredAgent.integrationId]!;
      const loginHome = resolveProviderStateHome(
        loaded.integrationsDirectory,
        integration.id,
        integration.providerState,
        example.agentId,
      );
      const runtimeHome = providerStates.resolve({
        membershipId: example.agentId,
        integrationId: integration.id,
        policy: integration.providerState,
        credentialReference: integration.credentials,
      }).storageReference;
      expect(runtimeHome).toBe(loginHome);
      expect(configuredAgent.memberId).not.toBe(example.agentId);
    }

    for (const reference of [
      ".nanasa/instructions/global.md",
      ".nanasa/instructions/team.md",
      ".nanasa/instructions/implementor.md",
      ".nanasa/instructions/reviewer.md",
      ".nanasa/instructions/builder.md",
      ".nanasa/instructions/review-agent.md",
    ]) {
      expect(readFileSync(join(repository, reference), "utf8")).not.toMatch(/^---/);
    }
  });

  it.each([
    {
      file: "membership.yaml",
      integrationId: "copilot",
      agentId: "agent_builder",
      policy: { scope: "membership" } as const,
      statePath: join("state", "members", "agent_builder", "copilot"),
    },
    {
      file: "integration.yaml",
      integrationId: "copilot",
      agentId: undefined,
      policy: { scope: "integration" } as const,
      statePath: join("state", "integrations", "copilot"),
    },
    {
      file: "custom.yaml",
      integrationId: "claude-code",
      agentId: "agent_reviewer",
      policy: {
        scope: "custom",
        path: "team-homes/{integrationId}/{agentId}",
      } as const,
      statePath: join("state", "custom", "team-homes", "claude-code", "agent_reviewer"),
    },
  ])("loads the $file provider state scope", (example) => {
    const repository = copyConfigExample(`auth-scopes/${example.file}`);
    const loaded = loadNanasaConfig(repository);
    const integration = loaded.config.integrations[example.integrationId];

    expect(integration?.providerState).toEqual(example.policy);
    expect(
      resolveProviderStateHome(
        loaded.integrationsDirectory,
        example.integrationId,
        integration!.providerState,
        example.agentId,
      ),
    ).toBe(join(loaded.integrationsDirectory, example.statePath));
  });

  it("loads private credential profiles referenced by the YAML examples", () => {
    const repository = copyConfigExample("auth-scopes/credential-profiles.yaml");
    const integrations = loadNanasaConfig(repository).config.integrations;
    const profileReferences = ["copilot", "claude-code"].map((integrationId) => {
      const credentials = integrations[integrationId]!.credentials;
      expect(credentials.kind).toBe("broker-profile");
      return credentials.kind === "broker-profile" ? credentials.profileId : "";
    });
    expect(profileReferences).toEqual(["copilot-from-environment", "claude-from-helper"]);

    const userConfigRoot = mkdtempSync(join(tmpdir(), "nanasa-doc-credentials-"));
    temporaryDirectories.push(userConfigRoot);
    const credentialsPath = join(userConfigRoot, "nanasa", "credentials.json");
    mkdirSync(dirname(credentialsPath), { recursive: true });
    copyFileSync(join(examplesRoot, "auth-scopes", "credentials.example.json"), credentialsPath);
    chmodSync(credentialsPath, 0o600);
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);

    const broker = new UserCredentialBroker({
      configPath: credentialsPath,
      environment: { NANASA_EXAMPLE_GITHUB_TOKEN: "test-placeholder-value" },
    });
    expect(
      broker.resolve({ kind: "broker-profile", profileId: profileReferences[0]! }, "copilot", [
        "GH_TOKEN",
      ]),
    ).toMatchObject({
      mode: "broker-profile",
      profileId: "copilot-from-environment",
      health: "available",
      environment: { GH_TOKEN: "test-placeholder-value" },
    });
    expect(broker.describe({ kind: "broker-profile", profileId: profileReferences[1]! })).toEqual({
      mode: "broker-profile",
      profileId: "claude-from-helper",
      provider: "claude-code",
      source: "helper",
    });

    chmodSync(credentialsPath, 0o644);
    expect(() => new UserCredentialBroker({ configPath: credentialsPath })).toThrow(
      "Credential broker file must be a private bounded regular file",
    );
  });
});
