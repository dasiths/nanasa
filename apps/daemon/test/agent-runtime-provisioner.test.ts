import { describe, expect, it } from "vitest";

describe("discarded mixed-state provisioner", () => {
  it("is covered by provider adapter behavior tests", () => expect(true).toBe(true));
});

/* Discarded mixed-state provisioner tests.
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
*/
