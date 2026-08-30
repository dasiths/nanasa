import type { AgentRun } from "@nanasa/contracts";
import { describe, expect, it, vi } from "vitest";
import { NanasaStore } from "../src/store.js";
import { TerminalControlService } from "../src/terminal/terminal-control-service.js";

const run: AgentRun = {
  id: "console_test",
  groupId: "console_test",
  memberId: "console_test",
  agentProfileId: "console",
  generation: 1,
  status: "running",
  desiredState: "running",
  recoveryPhase: "idle",
  recoveryAttempts: 0,
  launchKind: "fresh",
  requestedModelSource: "provider-default",
  startedAt: "2026-08-29T00:00:00.000Z",
  terminal: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
};

describe("TerminalControlService", () => {
  it("enforces one controller, bounded observers, takeover, generation fences, and cleanup", () => {
    const store = new NanasaStore(":memory:");
    let now = new Date("2026-08-29T00:00:00.000Z");
    const service = new TerminalControlService(store, () => now);
    service.register(run);
    const firstClose = vi.fn();
    const first = service.connect({
      runId: run.id,
      runGeneration: 1,
      viewerId: "viewer-one",
      requestedRole: "controller",
      takeover: false,
      close: firstClose,
    });
    expect(first.viewer.role).toBe("controller");
    const observer = service.connect({
      runId: run.id,
      runGeneration: 1,
      viewerId: "viewer-two",
      requestedRole: "controller",
      takeover: false,
      close: vi.fn(),
    });
    expect(observer.viewer.role).toBe("observer");
    const lease = service.takeover(run.id, observer.viewer.streamId, first.viewer.lease?.id);
    expect(lease.viewerId).toBe("viewer-two");
    expect(firstClose).toHaveBeenCalledWith(4001, "terminal_controller_taken_over");
    expect(service.release(run.id, observer.viewer.streamId, lease.id).role).toBe("observer");
    expect(service.hasController(run.id)).toBe(false);
    expect(service.takeover(run.id, observer.viewer.streamId).viewerId).toBe("viewer-two");
    expect(() =>
      service.connect({
        runId: run.id,
        runGeneration: 2,
        viewerId: "stale",
        requestedRole: "observer",
        takeover: false,
        close: vi.fn(),
      }),
    ).toThrow(/generation/i);
    now = new Date("2026-08-29T00:01:00.000Z");
    service.expire();
    expect(service.hasController(run.id)).toBe(false);
    service.close();
    store.close();
  });
});
