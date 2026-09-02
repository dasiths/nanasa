import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

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
    expect(fetchMock).toHaveBeenLastCalledWith("/api/v1/runs/run-one/terminal", undefined);
  });
});
