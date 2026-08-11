import type { AgentRun } from "@nanasa/contracts";
import { describe, expect, it } from "vitest";

import { NanasaStore } from "../src/store.js";
import { TerminalEndpointRegistry } from "../src/terminal-endpoint-registry.js";

const detachedRun: AgentRun = {
  id: "console_test",
  groupId: "console_test",
  memberId: "console_test",
  agentProfileId: "console",
  generation: 1,
  status: "running",
  desiredState: "running",
  recoveryPhase: "idle",
  recoveryAttempts: 0,
  terminal: {
    serverName: "nanasa",
    sessionId: "$1",
    windowId: "@1",
    paneId: "%1",
  },
  startedAt: "2026-08-11T00:00:00.000Z",
};

describe("TerminalEndpointRegistry detached endpoints", () => {
  it("serves an ephemeral endpoint without a persisted run", () => {
    const store = new NanasaStore(":memory:");
    const registry = new TerminalEndpointRegistry(store);

    const endpoint = registry.begin(detachedRun, 1, true);
    registry.publishReady(detachedRun.id, 1, 4123);

    expect(registry.status(detachedRun.id)).toEqual({
      runId: detachedRun.id,
      provider: "ttyd",
      state: "ready",
      url: `${endpoint.basePath}/`,
    });
    expect(registry.resolve(endpoint.endpointKey)).toMatchObject({
      runId: detachedRun.id,
      upstream: "http://127.0.0.1:4123",
    });

    registry.stop(detachedRun.id);
    expect(registry.status(detachedRun.id).state).toBe("stopped");
    store.close();
  });
});
