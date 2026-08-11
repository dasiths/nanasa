import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal endpoint API", () => {
  it("fetches and validates a ready same-origin endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runId: "run/one",
        provider: "ttyd",
        state: "ready",
        url: "/terminals/0123456789abcdef0123456789abcdef/",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getTerminalEndpointStatus("run/one")).resolves.toMatchObject({
      state: "ready",
      url: "/terminals/0123456789abcdef0123456789abcdef/",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run%2Fone/terminal", undefined);
  });

  it("rejects an endpoint response that exposes an upstream URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          runId: "run-one",
          provider: "ttyd",
          state: "ready",
          url: "http://127.0.0.1:7681/",
        }),
      }),
    );

    await expect(api.getTerminalEndpointStatus("run-one")).rejects.toThrow();
  });
});

describe("portal operations API", () => {
  it("creates and closes an ad hoc console", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "console/one", runId: "console-run" }),
      })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.createConsole()).resolves.toEqual({
      id: "console/one",
      runId: "console-run",
    });
    await expect(api.closeConsole("console/one")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/consoles",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/consoles/console%2Fone",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("updates role presentation and sends complete agent order permutations", async () => {
    const responses = [
      {
        name: "Reviewer",
        instructions: [],
        permissionPolicy: "read-only",
        presentation: { icon: "scan-search", color: "rose", shortName: "Inspect" },
      },
      { groupId: "group/one", agentIds: ["reviewer", "builder"], agentRevision: 8 },
    ];
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => responses.shift(),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.updateRolePresentation("reviewer/lead", {
      icon: "scan-search",
      color: "rose",
      shortName: "Inspect",
    });
    await api.reorderAgents("group/one", {
      agentIds: ["reviewer", "builder"],
      expectedAgentRevision: 7,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/roles/reviewer%2Flead/presentation",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ icon: "scan-search", color: "rose", shortName: "Inspect" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/groups/group%2Fone/agent-order",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          agentIds: ["reviewer", "builder"],
          expectedAgentRevision: 7,
        }),
      }),
    );
  });

  it("updates direct agent settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "agent-one",
        groupId: "group/one",
        memberId: "member-one",
        agentProfileId: "agent-one",
        alias: "Reviewer",
        roleId: "reviewer",
        state: "active",
        joinedAt: "2026-08-10T08:00:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.updateAgent("group/one", "agent/one", {
      name: " Reviewer ",
      integrationId: "copilot",
      roleId: "reviewer",
      instructions: [".nanasa/instructions/agents/reviewer.md"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/groups/group%2Fone/agents/agent%2Fone",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          name: "Reviewer",
          integrationId: "copilot",
          roleId: "reviewer",
          instructions: [".nanasa/instructions/agents/reviewer.md"],
        }),
      }),
    );
  });

  it("loads cursor pages and clears authoritative message history", async () => {
    const state = {
      groupId: "group/one",
      latestGroupSeq: 7,
      retainedMessageCount: 0,
      activeDeliveryCount: 0,
      failedRecipientMemberIds: [],
    };
    const responses = [
      {
        groupId: "group/one",
        messages: [],
        deliveryOutcomes: [],
        state,
        pageInfo: { hasOlder: false, hasNewer: false },
      },
      { groupId: "group/one", deletedMessages: 7, deletedDeliveries: 8, state },
    ];
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => responses.shift(),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.loadMessages("group/one", { limit: 20, before: 42 });
    await api.clearMessages("group/one");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/groups/group%2Fone/messages?limit=20&before=42",
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/groups/group%2Fone/messages",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "Content-Type": "application/json; charset=utf-8",
        }),
      }),
    );
  });

  it("sends encoded group and direct agent CRUD commands", async () => {
    const responses = [
      {
        id: "group/one",
        name: "Renamed group",
        membershipRevision: 2,
        createdAt: "2026-08-10T08:00:00.000Z",
        updatedAt: "2026-08-10T08:01:00.000Z",
      },
      {
        id: "agent-one",
        groupId: "group/one",
        memberId: "member/one",
        agentProfileId: "agent-one",
        alias: "New agent",
        state: "active",
        joinedAt: "2026-08-10T08:00:00.000Z",
      },
      {
        groupId: "group/one",
        agentId: "agent-one",
        deletedRuns: 1,
        revokedDeliveries: 2,
      },
      {
        groupId: "group/one",
        deletedMemberships: 1,
        deletedRuns: 1,
        deletedMessages: 0,
        deletedDeliveries: 0,
      },
    ];
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => responses.shift(),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.updateGroup("group/one", { name: "  Renamed group  " });
    await api.createAgent("group/one", { name: " New agent ", integrationId: "copilot" });
    await api.removeAgent("group/one", "agent/one");
    await api.deleteGroup("group/one");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/groups/group%2Fone",
      expect.objectContaining({ method: "PATCH", body: '{"name":"Renamed group"}' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/groups/group%2Fone/agents",
      expect.objectContaining({
        method: "POST",
        body: '{"name":"New agent","integrationId":"copilot"}',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/groups/group%2Fone/agents/agent%2Fone",
      expect.objectContaining({ method: "DELETE", body: "{}" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/groups/group%2Fone",
      expect.objectContaining({ method: "DELETE", body: "{}" }),
    );
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }),
        }),
      );
    }
  });

  it("loads and validates configured integrations and group agents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          instructions: [],
          integrations: {
            "custom-agent": {
              id: "custom-agent",
              name: "Custom agent",
              kind: "opencode",
              adapter: "terminal",
              command: ["custom-agent"],
              environment: {},
              recovery: "restart",
              capabilities: ["queue"],
            },
          },
          roles: {},
          groups: {
            team: {
              name: "Team",
              instructions: [],
              agents: {
                reviewer: {
                  memberId: "custom-agent.reviewer",
                  name: "Reviewer",
                  integrationId: "custom-agent",
                  instructions: [],
                },
              },
            },
          },
          messages: { retentionPerGroup: 1000 },
        }),
      }),
    );

    await expect(api.loadConfig()).resolves.toMatchObject({
      integrations: { "custom-agent": { name: "Custom agent" } },
      groups: { team: { agents: { reviewer: { integrationId: "custom-agent" } } } },
    });
  });

  it("starts and stops runs through agent routes", async () => {
    const run = {
      id: "run-one",
      groupId: "group/one",
      memberId: "member-one",
      agentProfileId: "agent-one",
      generation: 1,
      status: "running",
      desiredState: "running",
      recoveryPhase: "idle",
      recoveryAttempts: 0,
      startedAt: "2026-08-10T08:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => run,
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.startRun("group/one", "agent/one");
    await api.stopRun("group/one", "agent/one");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/groups/group%2Fone/agents/agent%2Fone/run",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/groups/group%2Fone/agents/agent%2Fone/run",
      expect.objectContaining({ method: "DELETE", body: "{}" }),
    );
  });

  it("posts Start all with the supplied idempotency key and validates outcomes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        groupId: "group/one",
        outcomes: [
          {
            groupId: "group/one",
            memberId: "member-one",
            status: "already-running",
            runId: "run-one",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.startAllRuns("group/one", "start-all-key")).resolves.toMatchObject({
      outcomes: [{ status: "already-running" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/groups/group%2Fone/runs/start-all",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({ "Idempotency-Key": "start-all-key" }),
      }),
    );
  });
});
