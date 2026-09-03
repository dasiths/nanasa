import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { launchConsentRequest } from "./test/launch-consent-fixture.js";

beforeEach(() => vi.restoreAllMocks());

describe("terminal v1 API", () => {
  it("loads final gateway status and bounded reads", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            operatorId: "operator-test",
            csrfToken: "csrf-test-0123456789abcdef0123456789abcdef",
            expiresAt: "2026-08-30T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: "run-one",
            provider: "nanasa-terminal.v1",
            state: "ready",
            streamUrl: "/api/v1/terminal-stream/run-one",
            protocol: "nanasa-terminal.v1",
            limits: {
              maxFrameBytes: 262144,
              maxInputBytes: 65536,
              maxPasteBytes: 196608,
              maxOutputQueueBytes: 1048576,
              maxViewers: 4,
              maxObservers: 3,
              maxReadLines: 5000,
              maxReadBytes: 1048576,
              heartbeatMs: 5000,
              leaseMs: 15000,
              reconnectHistoryFrames: 256,
            },
            observers: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    await expect(api.getTerminalEndpointStatus("run-one")).resolves.toMatchObject({
      provider: "nanasa-terminal.v1",
      state: "ready",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/runs/run-one/terminal",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
});

describe("launch consent API", () => {
  it("lists and submits exact digest commands to operator routes", async () => {
    const request = launchConsentRequest();
    const decision = {
      id: "decision-one",
      repositoryIdentity: request.repositoryIdentity,
      subjectDigest: request.subjectDigest,
      principalId: "operator-test",
      decision: "trusted",
      decidedAt: "2026-09-02T10:01:00.000Z",
    } as const;
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/v1/auth/operator-session") {
        return json({
          operatorId: "operator-test",
          csrfToken: "csrf-test-0123456789abcdef0123456789abcdef",
          expiresAt: "2026-09-03T00:00:00.000Z",
        });
      }
      if (path === "/api/v1/launch-consents?state=pending") return json([request]);
      if (path === "/api/v1/launch-consents/consent-one") return json(request);
      if (path.endsWith("/approve")) {
        return json({ request: { ...request, state: "approved" }, decision });
      }
      if (path.endsWith("/deny")) {
        return json({
          request: { ...request, state: "denied" },
          decision: { ...decision, decision: "denied" },
        });
      }
      if (path.endsWith("/cancel")) return json({ ...request, state: "cancelled" });
      if (path.endsWith("/revoke")) {
        return json({ ...decision, decision: "revoked", revokedAt: decision.decidedAt });
      }
      return json({ message: "Unexpected API path", code: "unexpected_path", details: {} });
    });

    await expect(api.listLaunchConsents("pending")).resolves.toEqual([request]);
    await expect(api.getLaunchConsent(request.id)).resolves.toEqual(request);
    await expect(
      api.approveLaunchConsent(request.id, {
        expectedSubjectDigest: request.subjectDigest,
        configRevision: request.configRevision,
      }),
    ).resolves.toMatchObject({ request: { state: "approved" }, decision: { decision: "trusted" } });
    await expect(
      api.denyLaunchConsent(request.id, {
        expectedSubjectDigest: request.subjectDigest,
        configRevision: request.configRevision,
      }),
    ).resolves.toMatchObject({ request: { state: "denied" }, decision: { decision: "denied" } });
    await expect(
      api.cancelLaunchConsent(request.id, {
        expectedSubjectDigest: request.subjectDigest,
        configRevision: request.configRevision,
      }),
    ).resolves.toMatchObject({ state: "cancelled" });
    await expect(
      api.revokeLaunchConsent(decision.id, { expectedSubjectDigest: request.subjectDigest }),
    ).resolves.toMatchObject({ decision: "revoked" });

    const apiCalls = fetchMock.mock.calls.filter(
      ([path]) => path !== "/api/v1/auth/operator-session",
    );
    expect(apiCalls.map(([path]) => path)).toEqual([
      "/api/v1/launch-consents?state=pending",
      "/api/v1/launch-consents/consent-one",
      "/api/v1/launch-consents/consent-one/approve",
      "/api/v1/launch-consents/consent-one/deny",
      "/api/v1/launch-consents/consent-one/cancel",
      "/api/v1/trust/decision-one/revoke",
    ]);
    expect(JSON.parse(String(apiCalls[2]?.[1]?.body))).toEqual({
      expectedSubjectDigest: request.subjectDigest,
      configRevision: request.configRevision,
    });
  });
});

describe("provider update recovery API", () => {
  it("delegates group previews and agent recovery to control-client resources", async () => {
    const digest = "a".repeat(64);
    const outcome = {
      runId: "run-one",
      generation: 1,
      memberId: "member-one",
      providerId: "copilot",
      previousSnapshotDigest: digest,
      currentSnapshotDigest: "b".repeat(64),
      status: "restarted",
      replacementRunId: "run-two",
    } as const;
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/v1/auth/operator-session") {
        return json({
          operatorId: "operator-test",
          csrfToken: "csrf-test-0123456789abcdef0123456789abcdef",
          expiresAt: "2026-09-03T00:00:00.000Z",
        });
      }
      if (path.endsWith("/runs/recover")) {
        return json({ groupId: "group-one", dryRun: true, outcomes: [outcome] });
      }
      return json(outcome);
    });

    await expect(
      api.recoverGroupRuns("group-one", { dryRun: true, forceIndeterminate: false }),
    ).resolves.toMatchObject({
      dryRun: true,
      outcomes: [outcome],
    });
    await expect(
      api.recoverAgentRun("group-one", "member-one", {
        dryRun: false,
        forceIndeterminate: true,
      }),
    ).resolves.toEqual(outcome);

    const apiCalls = fetchMock.mock.calls.filter(
      ([path]) => path !== "/api/v1/auth/operator-session",
    );
    expect(apiCalls.map(([path]) => path)).toEqual([
      "/api/v1/groups/group-one/runs/recover",
      "/api/v1/groups/group-one/agents/member-one/run/recover",
    ]);
    expect(JSON.parse(String(apiCalls[0]?.[1]?.body))).toEqual({
      dryRun: true,
      forceIndeterminate: false,
    });
    expect(JSON.parse(String(apiCalls[1]?.[1]?.body))).toEqual({
      dryRun: false,
      forceIndeterminate: true,
    });
  });
});
