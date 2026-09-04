import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomLaunchConsentSubject } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  customLaunchConsentSubjectDigest,
  repositoryLauncherFiles,
} from "../src/custom-launch-consent-subject.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function subject(overrides: Partial<CustomLaunchConsentSubject> = {}): CustomLaunchConsentSubject {
  return {
    repositoryIdentity: "repo_1234567890abcdef",
    integrationId: "claude-wrapper",
    providerKind: "claude-code",
    adapterId: "nanasa.claude-code-v2",
    adapterSecurityVersion: "2.0.0",
    configuredCommand: ["sh", "bin/claude-wrapper"],
    launcher: "append",
    launcherFiles: [{ path: "bin/claude-wrapper", digest: "a".repeat(64) }],
    workingDirectory: "/repository",
    environmentNames: ["ANTHROPIC_BASE_URL", "NANASA_MCP_URL"],
    credentialReference: { kind: "provider-managed" },
    permissionFloor: "inherit",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("custom launch consent subjects", () => {
  it("canonicalizes set-like fields while preserving configured command order", () => {
    const baseline = customLaunchConsentSubjectDigest(subject());
    expect(
      customLaunchConsentSubjectDigest(
        subject({
          environmentNames: ["NANASA_MCP_URL", "ANTHROPIC_BASE_URL"],
        }),
      ),
    ).toBe(baseline);
    expect(
      customLaunchConsentSubjectDigest(
        subject({ configuredCommand: ["bin/claude-wrapper", "sh"] }),
      ),
    ).not.toBe(baseline);
  });

  it.each([
    ["repository identity", { repositoryIdentity: "repo_fedcba0987654321" }],
    ["integration", { integrationId: "other-wrapper" }],
    ["provider kind", { providerKind: "copilot" as const }],
    ["adapter", { adapterId: "nanasa.claude-code-v3" }],
    ["adapter security version", { adapterSecurityVersion: "2.0.1" }],
    ["command argument", { configuredCommand: ["sh", "bin/other-wrapper"] }],
    ["launcher strategy", { launcher: { kind: "environment" as const, name: "CLAUDE_ARGS" } }],
    ["working directory", { workingDirectory: "/repository/subdirectory" }],
    ["environment names", { environmentNames: ["NANASA_MCP_URL"] }],
    [
      "credential reference",
      { credentialReference: { kind: "broker-profile" as const, profileId: "claude" } },
    ],
    [
      "permission floor",
      { permissionFloor: "read-only" as const, permissionFloorCapability: "deny-floor" },
    ],
    [
      "launcher file content",
      { launcherFiles: [{ path: "bin/claude-wrapper", digest: "b".repeat(64) }] },
    ],
  ])("changes when the %s changes", (_field, override) => {
    expect(
      customLaunchConsentSubjectDigest(subject(override as Partial<CustomLaunchConsentSubject>)),
    ).not.toBe(customLaunchConsentSubjectDigest(subject()));
  });

  it("hashes each repository-owned command file once and renews after an edit", () => {
    const repository = temporaryDirectory("nanasa-launcher-");
    mkdirSync(join(repository, "bin"));
    const launcher = join(repository, "bin", "claude-wrapper");
    writeFileSync(launcher, '#!/bin/sh\nexec claude "$@"\n');

    const input = {
      repositoryRoot: repository,
      configuredCommand: ["/bin/sh", "bin/claude-wrapper", "bin/claude-wrapper"],
    };
    expect(repositoryLauncherFiles(input)).toEqual([
      {
        path: "bin/claude-wrapper",
        digest: createHash("sha256").update('#!/bin/sh\nexec claude "$@"\n').digest("hex"),
      },
    ]);

    writeFileSync(launcher, '#!/bin/sh\nexec claude --verbose "$@"\n');
    expect(repositoryLauncherFiles(input)[0]?.digest).not.toBe(
      createHash("sha256").update('#!/bin/sh\nexec claude "$@"\n').digest("hex"),
    );
  });

  it("rejects launcher symlinks, escaping parent symlinks, and foreign ownership", () => {
    const repository = temporaryDirectory("nanasa-launcher-");
    const outside = temporaryDirectory("nanasa-launcher-outside-");
    mkdirSync(join(repository, "bin"));
    writeFileSync(join(outside, "launcher"), "outside\n");
    symlinkSync(join(outside, "launcher"), join(repository, "bin", "direct-link"));
    symlinkSync(outside, join(repository, "linked-bin"), "dir");

    expect(() =>
      repositoryLauncherFiles({
        repositoryRoot: repository,
        configuredCommand: ["bin/direct-link"],
      }),
    ).toThrow(/symbolic link/);
    expect(() =>
      repositoryLauncherFiles({
        repositoryRoot: repository,
        configuredCommand: ["linked-bin/launcher"],
      }),
    ).toThrow(/beneath the repository root/);

    const launcher = join(repository, "bin", "owned-launcher");
    writeFileSync(launcher, "owned\n");
    const currentUid = process.getuid();
    vi.spyOn(process, "getuid").mockReturnValue(currentUid + 1);
    expect(() =>
      repositoryLauncherFiles({
        repositoryRoot: repository,
        configuredCommand: ["bin/owned-launcher"],
      }),
    ).toThrow(/owned by the current user/);
  });
});
