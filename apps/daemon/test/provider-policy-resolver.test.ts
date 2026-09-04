import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfile, GroupMembership, NanasaConfig } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderPolicyError,
  resolveEffectiveProviderPolicy,
} from "../src/provider-policy-resolver.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nanasa-provider-policy-"));
  roots.push(root);
  mkdirSync(join(root, ".nanasa", "providers", "copilot"), { recursive: true });
  writeFileSync(
    join(root, ".nanasa", "providers", "copilot", "base.json"),
    '{"mcpServers":{"base":{"url":"https://base.example/mcp"}}}\n',
  );
  writeFileSync(
    join(root, ".nanasa", "providers", "copilot", "agent.json"),
    '{"mcpServers":{"agent":{"url":"https://agent.example/mcp"}}}\n',
  );
  const config = {
    executionProfiles: {
      autonomous: {
        continuation: "autonomous",
        questions: "disabled",
        approvals: "unrestricted",
      },
    },
    integrations: {
      copilot: {
        executionProfile: "autonomous",
        providerFiles: {
          mcp: {
            mode: "append",
            paths: [".nanasa/providers/copilot/base.json"],
          },
        },
      },
    },
    groups: {
      team: {
        agents: {
          worker: {
            providerFiles: {
              mcp: {
                mode: "append",
                paths: [".nanasa/providers/copilot/agent.json"],
              },
            },
          },
        },
      },
    },
  } as unknown as NanasaConfig;
  const membership = { id: "worker", groupId: "team" } as GroupMembership;
  const profile = { agentType: "copilot" } as AgentProfile;
  return { root, config, membership, profile };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("effective provider policy", () => {
  it("resolves autonomous profiles and ordered integration plus agent files", () => {
    const context = fixture();
    const policy = resolveEffectiveProviderPolicy({
      repoRoot: context.root,
      config: context.config,
      membership: context.membership,
      profile: context.profile,
      allowAutonomous: true,
      allowProviderFiles: true,
    });

    expect(policy.executionProfileId).toBe("autonomous");
    expect(policy.providerFiles.map(({ sourcePath, scope }) => ({ sourcePath, scope }))).toEqual([
      { sourcePath: ".nanasa/providers/copilot/base.json", scope: "integration" },
      { sourcePath: ".nanasa/providers/copilot/agent.json", scope: "agent" },
    ]);
    expect(policy.providerFiles.every((file) => /^[0-9a-f]{64}$/.test(file.digest))).toBe(true);
  });

  it("supports replace and disabled agent selections", () => {
    const context = fixture();
    const agent = context.config.groups.team!.agents.worker!;
    const replaced = resolveEffectiveProviderPolicy({
      repoRoot: context.root,
      membership: context.membership,
      profile: context.profile,
      config: {
        ...context.config,
        groups: {
          team: {
            ...context.config.groups.team!,
            agents: {
              worker: {
                ...agent,
                providerFiles: {
                  mcp: {
                    mode: "replace",
                    paths: [".nanasa/providers/copilot/agent.json"],
                  },
                },
              },
            },
          },
        },
      },
      allowAutonomous: true,
      allowProviderFiles: true,
    });
    expect(replaced.providerFiles.map((file) => file.scope)).toEqual(["agent"]);

    const disabled = resolveEffectiveProviderPolicy({
      repoRoot: context.root,
      membership: context.membership,
      profile: context.profile,
      config: {
        ...context.config,
        groups: {
          team: {
            ...context.config.groups.team!,
            agents: {
              worker: { ...agent, providerFiles: { mcp: { mode: "disabled", paths: [] } } },
            },
          },
        },
      },
      allowAutonomous: true,
      allowProviderFiles: true,
    });
    expect(disabled.providerFiles).toEqual([]);
  });

  it("fails closed for unauthorized profiles, files, and symlinks", () => {
    const context = fixture();
    expect(() =>
      resolveEffectiveProviderPolicy({
        repoRoot: context.root,
        config: context.config,
        membership: context.membership,
        profile: context.profile,
        allowAutonomous: false,
        allowProviderFiles: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "execution_profile_not_authorized" }));
    expect(() =>
      resolveEffectiveProviderPolicy({
        repoRoot: context.root,
        config: context.config,
        membership: context.membership,
        profile: context.profile,
        allowAutonomous: true,
        allowProviderFiles: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "provider_file_not_authorized" }));

    symlinkSync(
      join(context.root, ".nanasa", "providers", "copilot", "base.json"),
      join(context.root, ".nanasa", "providers", "copilot", "linked.json"),
    );
    const integration = context.config.integrations.copilot!;
    expect(() =>
      resolveEffectiveProviderPolicy({
        repoRoot: context.root,
        membership: context.membership,
        profile: context.profile,
        config: {
          ...context.config,
          integrations: {
            copilot: {
              ...integration,
              providerFiles: {
                mcp: {
                  mode: "replace",
                  paths: [".nanasa/providers/copilot/linked.json"],
                },
              },
            },
          },
          groups: {
            team: {
              ...context.config.groups.team!,
              agents: {
                worker: {
                  ...context.config.groups.team!.agents.worker!,
                  providerFiles: {},
                },
              },
            },
          },
        },
        allowAutonomous: true,
        allowProviderFiles: true,
      }),
    ).toThrow(ProviderPolicyError);
  });
});
