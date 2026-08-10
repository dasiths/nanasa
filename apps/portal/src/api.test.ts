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

describe("effective delivery modes API", () => {
  it("posts encoded recipient selection and validates terminal in the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ memberIds: ["member/one"], modes: ["queue", "terminal"] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.getEffectiveDeliveryModes("group/one", { memberIds: ["member/one"] }),
    ).resolves.toEqual({ memberIds: ["member/one"], modes: ["queue", "terminal"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/groups/group%2Fone/delivery-modes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ memberIds: ["member/one"] }),
      }),
    );
  });

  it("rejects duplicate recipients before request and invalid response modes after request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ memberIds: ["member-one"], modes: ["inbox"] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(() =>
      api.getEffectiveDeliveryModes("group-one", {
        memberIds: ["member-one", "member-one"],
      }),
    ).toThrow();
    await expect(
      api.getEffectiveDeliveryModes("group-one", { memberIds: ["member-one"] }),
    ).rejects.toThrow();
  });
});

describe("portal operations API", () => {
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
