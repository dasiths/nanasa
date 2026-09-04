import type { CustomLaunchConsentRequest } from "@nanasa/contracts";

const digest = "a".repeat(64);

export function launchConsentRequest(
  overrides: Partial<CustomLaunchConsentRequest> = {},
): CustomLaunchConsentRequest {
  return {
    id: "consent-one",
    repositoryIdentity: "repo-test",
    groupId: "group-backend",
    agentId: "builder-agent",
    memberId: "builder",
    integrationId: "copilot",
    subjectDigest: digest,
    configRevision: "b".repeat(64),
    subject: {
      repositoryIdentity: "repo-test",
      integrationId: "copilot",
      providerKind: "copilot",
      adapterId: "builtin-copilot",
      adapterSecurityVersion: "1",
      configuredCommand: ["sh", "bin/custom launcher", "--mode=review"],
      launcher: "append",
      launcherFiles: [{ path: "bin/custom launcher", digest: "c".repeat(64) }],
      workingDirectory: "/repo/worktree",
      environmentNames: ["NANASA_MCP_URL", "NANASA_MCP_TOKEN", "CUSTOM_MODE"],
      credentialReference: { kind: "provider-managed" },
      permissionFloor: "inherit",
    },
    state: "pending",
    requestedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}
