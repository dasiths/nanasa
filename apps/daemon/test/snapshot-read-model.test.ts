import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, type NanasaConfig, type PortalSnapshot } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRestartAdvisories } from "../src/snapshot-read-model.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("restart advisories", () => {
  it("reports current config, provider-file, and provider snapshot drift", () => {
    const root = mkdtempSync(join(tmpdir(), "nanasa-restart-advisory-"));
    roots.push(root);
    mkdirSync(join(root, ".nanasa", "providers"), { recursive: true });
    const providerContent = '{"mcpServers":{"docs":{"url":"https://docs.example/mcp"}}}\n';
    writeFileSync(join(root, ".nanasa", "providers", "mcp.json"), providerContent);
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
            mcp: { mode: "append", paths: [".nanasa/providers/mcp.json"] },
          },
        },
      },
      groups: {
        team: {
          agents: {
            worker: { integrationId: "copilot" },
          },
        },
      },
    } as unknown as NanasaConfig;
    const snapshot = {
      runs: [
        {
          id: "run-one",
          generation: 1,
          groupId: "team",
          memberId: "worker-member",
          status: "running",
        },
      ],
      memberships: [{ id: "worker", groupId: "team", memberId: "worker-member" }],
    } as unknown as PortalSnapshot;
    const currentRevision = "b".repeat(64);
    const advisories = resolveRestartAdvisories(snapshot, {
      configRepository: {
        load: () => ({ repoRoot: root, config, status: { revision: currentRevision } }),
      } as never,
      providerBindings: {
        getForRun: () => ({
          providerId: "copilot",
          snapshotDigest: "c".repeat(64),
          launchPlan: {
            configRevision: "a".repeat(64),
            executionProfile: {
              id: "autonomous",
              digest: createHash("sha256")
                .update(canonicalJson(config.executionProfiles!.autonomous))
                .digest("hex"),
            },
            providerFiles: [
              {
                path: ".nanasa/providers/mcp.json",
                scope: "integration",
                digest: "d".repeat(64),
              },
            ],
          },
        }),
      } as never,
      providerRuntimeIndex: {
        get: () => ({ snapshotDigest: "e".repeat(64) }),
      } as never,
    });

    expect(advisories).toEqual([
      {
        runId: "run-one",
        groupId: "team",
        memberId: "worker-member",
        reasons: ["configuration-changed", "provider-files-changed", "provider-changed"],
      },
    ]);
  });
});
