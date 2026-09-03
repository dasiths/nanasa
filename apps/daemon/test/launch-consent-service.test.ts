import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomLaunchConsentSubject } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  type CurrentLaunchConsentSubject,
  LaunchConsentService,
  LaunchConsentServiceError,
} from "../src/launch-consent-service.js";
import { NanasaStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-launch-consent-"));
  directories.push(directory);
  return join(directory, "nanasa.sqlite");
}

function subject(
  command: readonly string[] = ["sh", "bin/launch-provider"],
): CustomLaunchConsentSubject {
  return {
    repositoryIdentity: "repo-one",
    integrationId: "custom-claude",
    providerKind: "claude-code",
    adapterId: "nanasa.claude-code",
    adapterSecurityVersion: "1",
    configuredCommand: [...command],
    launcher: "append",
    launcherFiles: [{ path: "bin/launch-provider", digest: "b".repeat(64) }],
    workingDirectory: "/workspace/repo-one",
    environmentNames: ["ANTHROPIC_API_KEY", "NANASA_MCP_TOKEN"],
    credentialReference: { kind: "broker-profile", profileId: "work" },
    permissionFloor: "inherit",
  };
}

function customInput(currentSubject: CustomLaunchConsentSubject, configRevision = "c".repeat(64)) {
  return {
    commandSource: "custom" as const,
    repositoryIdentity: "repo-one",
    groupId: "group-one",
    agentId: "engineer-1",
    memberId: "member-one",
    integrationId: "custom-claude",
    subject: currentSubject,
    configRevision,
  };
}

function exact(request: { subjectDigest: string; configRevision: string }) {
  return {
    expectedSubjectDigest: request.subjectDigest,
    configRevision: request.configRevision,
  };
}

describe("LaunchConsentService", () => {
  it("inspects custom launch consent without creating requests or events", () => {
    const store = new NanasaStore(":memory:");
    const current: CurrentLaunchConsentSubject = {
      subject: subject(),
      configRevision: "c".repeat(64),
    };
    const service = new LaunchConsentService(store, () => current);
    try {
      expect(service.inspect(customInput(current.subject, current.configRevision)).status).toBe(
        "approval-required",
      );
      expect(
        store.database.prepare("SELECT COUNT(*) AS count FROM launch_consent_requests").get(),
      ).toEqual({ count: 0 });
      expect(store.listEvents()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("reuses one pending request and preserves it across store reopen", () => {
    const path = databasePath();
    const current: CurrentLaunchConsentSubject = {
      subject: subject(),
      configRevision: "c".repeat(64),
    };
    const firstStore = new NanasaStore(path);
    const firstService = new LaunchConsentService(firstStore, () => current);
    const first = firstService.resolve(customInput(current.subject, current.configRevision));
    const duplicate = firstService.resolve(customInput(current.subject, current.configRevision));
    expect(first.status).toBe("approval-required");
    expect(duplicate.status).toBe("approval-required");
    if (first.status !== "approval-required" || duplicate.status !== "approval-required") return;
    expect(duplicate.request.id).toBe(first.request.id);
    expect(
      firstStore.database.prepare("SELECT COUNT(*) AS count FROM launch_consent_requests").get(),
    ).toEqual({
      count: 1,
    });
    expect(
      firstStore.database
        .prepare("SELECT redacted_subject_json FROM launch_consent_requests WHERE id = ?")
        .get(first.request.id),
    ).toEqual({ redacted_subject_json: JSON.stringify(current.subject) });
    firstStore.close();

    const reopenedStore = new NanasaStore(path);
    const reopenedService = new LaunchConsentService(reopenedStore, () => current);
    const reopened = reopenedService.resolve(customInput(current.subject, current.configRevision));
    expect(reopened.status).toBe("approval-required");
    if (reopened.status === "approval-required") expect(reopened.request.id).toBe(first.request.id);
    reopenedStore.close();
  });

  it("marks changed pending requests stale and rejects stale approval", async () => {
    const store = new NanasaStore(":memory:");
    let current: CurrentLaunchConsentSubject = {
      subject: subject(),
      configRevision: "c".repeat(64),
    };
    const service = new LaunchConsentService(store, () => current);
    try {
      const initial = service.resolve(customInput(current.subject, current.configRevision));
      expect(initial.status).toBe("approval-required");
      if (initial.status !== "approval-required") return;

      current = {
        subject: subject(["sh", "bin/launch-provider", "--changed"]),
        configRevision: "d".repeat(64),
      };
      await expect(
        service.approve(initial.request.id, exact(initial.request), "operator-one"),
      ).rejects.toEqual(
        expect.objectContaining<Partial<LaunchConsentServiceError>>({
          code: "launch_consent_stale",
        }),
      );
      expect(store.findLaunchConsentRequest(initial.request.id)?.state).toBe("stale");
      expect(service.findDecision("repo-one", initial.request.subjectDigest)).toBeUndefined();

      const replacement = service.resolve(customInput(current.subject, current.configRevision));
      expect(replacement.status).toBe("approval-required");
      if (replacement.status === "approval-required") {
        expect(replacement.request.id).not.toBe(initial.request.id);
        current = {
          subject: subject(["sh", "bin/launch-provider", "--newer"]),
          configRevision: "e".repeat(64),
        };
        const reconciled = service.resolve(customInput(current.subject, current.configRevision));
        expect(reconciled.status).toBe("approval-required");
        expect(store.findLaunchConsentRequest(replacement.request.id)?.state).toBe("stale");
      }
    } finally {
      store.close();
    }
  });

  it("persists approval, supports revocation, and asks again afterward", async () => {
    const store = new NanasaStore(":memory:");
    const current: CurrentLaunchConsentSubject = {
      subject: subject(),
      configRevision: "c".repeat(64),
    };
    const service = new LaunchConsentService(store, () => current);
    try {
      const pending = service.resolve(customInput(current.subject, current.configRevision));
      expect(pending.status).toBe("approval-required");
      if (pending.status !== "approval-required") return;
      const approved = await service.approve(
        pending.request.id,
        exact(pending.request),
        "operator-one",
      );
      expect(approved.request.state).toBe("approved");
      expect(approved.decision.decision).toBe("trusted");
      expect(service.resolve(customInput(current.subject, current.configRevision)).status).toBe(
        "trusted",
      );

      const revoked = service.revoke(
        "repo-one",
        approved.decision.id,
        { expectedSubjectDigest: pending.request.subjectDigest },
        "operator-two",
      );
      expect(revoked.decision).toBe("revoked");
      const bounds = store.eventBounds();
      const events = store.listEventPage(0, bounds.highWater, 100);
      expect(events.map((event) => event.type)).toEqual([
        "launch-consent.pending",
        "launch-consent.approved",
        "launch-consent.revoked",
      ]);
      expect(JSON.stringify(events.map((event) => event.payload))).not.toContain(
        "bin/launch-provider",
      );
      expect(JSON.stringify(events.map((event) => event.payload))).not.toContain(
        "ANTHROPIC_API_KEY",
      );
      const replacement = service.resolve(customInput(current.subject, current.configRevision));
      expect(replacement.status).toBe("approval-required");
      if (replacement.status === "approval-required") {
        expect(replacement.request.id).not.toBe(pending.request.id);
      }
    } finally {
      store.close();
    }
  });

  it("keeps denial durable while cancellation permits a new request", () => {
    const store = new NanasaStore(":memory:");
    let current: CurrentLaunchConsentSubject = {
      subject: subject(),
      configRevision: "c".repeat(64),
    };
    const service = new LaunchConsentService(store, () => current);
    try {
      const deniedPending = service.resolve(customInput(current.subject, current.configRevision));
      if (deniedPending.status !== "approval-required") return;
      const denied = service.deny(
        deniedPending.request.id,
        exact(deniedPending.request),
        "operator-one",
      );
      expect(denied.request.state).toBe("denied");
      const deniedAgain = service.resolve(customInput(current.subject, current.configRevision));
      expect(deniedAgain.status).toBe("denied");
      if (deniedAgain.status === "denied") {
        expect(deniedAgain.request.id).toBe(deniedPending.request.id);
      }

      current = {
        subject: subject(["sh", "bin/another-provider"]),
        configRevision: "d".repeat(64),
      };
      const cancellable = service.resolve(customInput(current.subject, current.configRevision));
      if (cancellable.status !== "approval-required") return;
      const cancelled = service.cancel(
        cancellable.request.id,
        exact(cancellable.request),
        "operator-one",
      );
      expect(cancelled.state).toBe("cancelled");
      expect(service.findDecision("repo-one", cancellable.request.subjectDigest)).toBeUndefined();
      const retried = service.resolve(customInput(current.subject, current.configRevision));
      expect(retried.status).toBe("approval-required");
      if (retried.status === "approval-required") {
        expect(retried.request.id).not.toBe(cancellable.request.id);
      }
    } finally {
      store.close();
    }
  });

  it("bypasses consent for built-in command origins", () => {
    const store = new NanasaStore(":memory:");
    const service = new LaunchConsentService(store, () => {
      throw new Error("Built-in resolution must not inspect a custom subject");
    });
    try {
      expect(service.resolve({ commandSource: "builtin" })).toEqual({ status: "built-in" });
      expect(
        store.database.prepare("SELECT COUNT(*) AS count FROM launch_consent_requests").get(),
      ).toEqual({
        count: 0,
      });
    } finally {
      store.close();
    }
  });
});
