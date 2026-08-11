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
  it("updates reusable profile role and Markdown instruction defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "profile/one",
        name: "Reviewer",
        agentType: "copilot",
        kind: "copilot",
        command: "copilot",
        args: [],
        environment: {},
        createdAt: "2026-08-10T08:00:00.000Z",
        updatedAt: "2026-08-10T08:01:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.updateAgentProfile("profile/one", {
      name: " Reviewer ",
      defaultRoleId: "reviewer",
      instructions: [".nanasa/instructions/profiles/reviewer.md"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-profiles/profile%2Fone",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          name: "Reviewer",
          defaultRoleId: "reviewer",
          instructions: [".nanasa/instructions/profiles/reviewer.md"],
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

  it("sends encoded group and membership CRUD commands", async () => {
    const responses = [
      {
        id: "group/one",
        name: "Renamed group",
        membershipRevision: 2,
        createdAt: "2026-08-10T08:00:00.000Z",
        updatedAt: "2026-08-10T08:01:00.000Z",
      },
      {
        id: "membership-one",
        groupId: "group/one",
        memberId: "member/one",
        agentProfileId: "profile-one",
        alias: "Renamed member",
        state: "active",
        joinedAt: "2026-08-10T08:00:00.000Z",
      },
      {
        id: "membership-one",
        groupId: "group/one",
        memberId: "member/one",
        agentProfileId: "profile-one",
        alias: "Renamed member",
        state: "removed",
        joinedAt: "2026-08-10T08:00:00.000Z",
        removedAt: "2026-08-10T08:02:00.000Z",
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
    await api.updateMembership("group/one", "member/one", { alias: " Renamed member " });
    await api.removeMembership("group/one", "member/one");
    await api.deleteGroup("group/one");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/groups/group%2Fone",
      expect.objectContaining({ method: "PATCH", body: '{"name":"Renamed group"}' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/groups/group%2Fone/memberships/member%2Fone",
      expect.objectContaining({ method: "PATCH", body: '{"alias":"Renamed member"}' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/groups/group%2Fone/memberships/member%2Fone",
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

  it("loads and validates configured agent types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          version: 1,
          agentTypes: {
            "custom-agent": {
              key: "custom-agent",
              name: "Custom agent",
              kind: "opencode",
              adapter: "terminal",
              command: ["custom-agent"],
              environment: {},
              recovery: "restart",
              capabilities: ["queue"],
            },
          },
        }),
      }),
    );

    await expect(api.loadConfig()).resolves.toMatchObject({
      agentTypes: { "custom-agent": { name: "Custom agent" } },
    });
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
