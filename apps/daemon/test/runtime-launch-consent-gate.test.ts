import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomLaunchConsentRequest, NanasaConfig } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LaunchConsentService } from "../src/launch-consent-service.js";
import { RuntimeLaunchConsentGate } from "../src/runtime-launch-consent-gate.js";
import { DomainError, NanasaStore } from "../src/store.js";

const roots: string[] = [];

function fixture(permissionPolicy: "inherit" | "read-only" = "inherit") {
  const root = mkdtempSync(join(tmpdir(), "nanasa-launch-gate-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "custom-pi"), '#!/bin/sh\nexec pi "$@"\n');
  const config: NanasaConfig = {
    version: 2,
    repository: { path: root, checkout: { kind: "current" } },
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
    integrations: {
      custom: {
        id: "custom",
        name: "Custom Pi",
        kind: "pi",
        command: ["sh", "bin/custom-pi"],
        commandSource: "custom",
        launcher: { providerArguments: "append" },
        cwd: root,
        providerState: { scope: "membership" },
        credentials: { kind: "provider-managed" },
        model: { resumePolicy: "preserve-session" },
        nativeRecovery: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
        extensions: [],
        environment: { CUSTOM_VISIBLE_NAME: "secret-value-not-in-subject" },
      },
    },
    extensions: {},
    roles: {
      worker: { name: "Worker", instructions: [], permissionPolicy },
    },
    groups: {
      team: {
        name: "Team",
        instructions: [],
        agents: {
          agent: {
            memberId: "member",
            name: "Member",
            integrationId: "custom",
            roleId: "worker",
            instructions: [],
          },
        },
      },
    },
    messages: { retentionPerGroup: 1_000 },
  };
  const loaded = {
    repoRoot: root,
    configPath: join(root, ".nanasa", "config.yaml"),
    stateDirectory: join(root, ".nanasa", "state"),
    dataPath: ":memory:",
    runtimeDirectory: join(root, ".nanasa", "runtime"),
    integrationsDirectory: join(root, ".nanasa", "integrations"),
    config,
    status: {
      state: "ready" as const,
      repoRoot: root,
      configPath: join(root, ".nanasa", "config.yaml"),
      revision: "a".repeat(64),
      diagnostics: [],
    },
  };
  const persistence = new NanasaStore(":memory:");
  const adapter = {
    body: {
      adapterId: "nanasa.pi-v2",
      extensionGeneration: "2.0.0",
      capabilities: [
        {
          id: "credentials",
          version: { major: 1, minor: 0 },
          payload: { slots: [{ targetNames: ["PI_API_KEY"] }] },
        },
        {
          id: "launch",
          version: { major: 1, minor: 0 },
          payload: { environmentNames: ["PI_LAUNCH_ENV"] },
        },
        {
          id: "state",
          version: { major: 1, minor: 0 },
          payload: { environmentNames: ["PI_CODING_AGENT_DIR"] },
        },
      ],
    },
  };
  let currentRequest: CustomLaunchConsentRequest | undefined;
  const consentService = new LaunchConsentService(persistence, (request) => ({
    subject: currentRequest?.subject ?? request.subject,
    configRevision: currentRequest?.configRevision ?? request.configRevision,
  }));
  const resolveActiveSnapshot = vi.fn(async () => adapter);
  const gate = new RuntimeLaunchConsentGate({
    repositoryIdentity: "repository-one",
    configRepository: { load: vi.fn(() => loaded) } as never,
    store: {
      listActiveMemberships: vi.fn(() => [
        {
          id: "agent",
          groupId: "team",
          memberId: "member",
          agentProfileId: "agent",
          alias: "Member",
          roleId: "worker",
          order: 0,
          state: "active",
          joinedAt: "2026-09-02T00:00:00.000Z",
        },
      ]),
    } as never,
    providerBindings: { resolveActiveSnapshot } as never,
    consentService,
    runtimeEnvironmentNames: ["NANASA_MCP_URL"],
  });
  return {
    loaded,
    persistence,
    consentService,
    gate,
    resolveActiveSnapshot,
    setCurrentRequest: (request: CustomLaunchConsentRequest) => {
      currentRequest = request;
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RuntimeLaunchConsentGate", () => {
  it("bypasses built-in commands without resolving provider metadata", async () => {
    const context = fixture();
    context.loaded.config.integrations.custom = {
      ...context.loaded.config.integrations.custom!,
      command: ["pi"],
      commandSource: "builtin",
      launcher: undefined,
    } as never;
    try {
      await expect(context.gate.resolve("team", "member")).resolves.toEqual({
        status: "built-in",
      });
      expect(context.resolveActiveSnapshot).not.toHaveBeenCalled();
    } finally {
      context.persistence.close();
    }
  });

  it("reuses trusted and denied decisions for the exact stable subject", async () => {
    const trusted = fixture();
    const denied = fixture();
    try {
      const pendingApproval = await trusted.gate.resolve("team", "member");
      expect(pendingApproval.status).toBe("approval-required");
      if (pendingApproval.status !== "approval-required") return;
      trusted.setCurrentRequest(pendingApproval.request);
      await trusted.consentService.approve(
        pendingApproval.request.id,
        {
          expectedSubjectDigest: pendingApproval.request.subjectDigest,
          configRevision: pendingApproval.request.configRevision,
        },
        "operator-one",
      );
      await expect(trusted.gate.resolve("team", "member")).resolves.toMatchObject({
        status: "trusted",
      });
      expect(pendingApproval.request.subject.environmentNames).toEqual(
        expect.arrayContaining([
          "CUSTOM_VISIBLE_NAME",
          "NANASA_MCP_URL",
          "PI_API_KEY",
          "PI_CODING_AGENT_DIR",
          "PI_LAUNCH_ENV",
        ]),
      );
      expect(JSON.stringify(pendingApproval.request.subject)).not.toContain("secret-value");
      expect(pendingApproval.request.subject.launcherFiles).toHaveLength(1);

      const pendingDenial = await denied.gate.resolve("team", "member");
      expect(pendingDenial.status).toBe("approval-required");
      if (pendingDenial.status !== "approval-required") return;
      denied.consentService.deny(
        pendingDenial.request.id,
        {
          expectedSubjectDigest: pendingDenial.request.subjectDigest,
          configRevision: pendingDenial.request.configRevision,
        },
        "operator-two",
      );
      await expect(denied.gate.resolve("team", "member")).resolves.toMatchObject({
        status: "denied",
        request: { id: pendingDenial.request.id },
      });
    } finally {
      trusted.persistence.close();
      denied.persistence.close();
    }
  });

  it("stales changed subjects and creates a replacement only for manual starts", async () => {
    const context = fixture();
    try {
      const first = await context.gate.resolve("team", "member");
      expect(first.status).toBe("approval-required");
      if (first.status !== "approval-required") return;
      context.loaded.config.integrations.custom!.command.push("--changed");
      context.loaded.status.revision = "b".repeat(64);
      const replacement = await context.gate.resolve("team", "member");
      expect(replacement.status).toBe("approval-required");
      if (replacement.status !== "approval-required") return;
      expect(replacement.request.id).not.toBe(first.request.id);
      expect(context.persistence.findLaunchConsentRequest(first.request.id)?.state).toBe("stale");

      const automatic = fixture();
      try {
        await expect(automatic.gate.resolveForAutomaticRecovery("team", "member")).resolves.toEqual(
          { status: "approval-required" },
        );
        const count = automatic.persistence.database
          .prepare("SELECT count(*) AS value FROM launch_consent_requests")
          .get() as { value: number };
        expect(count.value).toBe(0);
      } finally {
        automatic.persistence.close();
      }
    } finally {
      context.persistence.close();
    }
  });

  it("rejects a read-only custom launcher before creating consent", async () => {
    const context = fixture("read-only");
    try {
      await expect(context.gate.resolve("team", "member")).rejects.toEqual(
        expect.objectContaining<Partial<DomainError>>({
          code: "custom_launcher_permission_floor_unsupported",
        }),
      );
      const count = context.persistence.database
        .prepare("SELECT count(*) AS value FROM launch_consent_requests")
        .get() as { value: number };
      expect(count.value).toBe(0);
    } finally {
      context.persistence.close();
    }
  });
});
