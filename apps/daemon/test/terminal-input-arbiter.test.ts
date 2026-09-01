import type { AgentRun, TerminalClientFrame } from "@nanasa/contracts";
import { describe, expect, it, vi } from "vitest";

import { NanasaStore } from "../src/store.js";
import type { AttachmentPty } from "../src/terminal/attachment-pty.js";
import { TerminalControlService } from "../src/terminal/terminal-control-service.js";
import { TerminalInputArbiter } from "../src/terminal/terminal-input-arbiter.js";

const run: AgentRun = {
  id: "arbiter_run",
  groupId: "arbiter_group",
  memberId: "arbiter_member",
  agentProfileId: "arbiter_profile",
  generation: 1,
  status: "running",
  desiredState: "running",
  recoveryPhase: "idle",
  recoveryAttempts: 0,
  launchKind: "fresh",
  requestedModelSource: "provider-default",
  startedAt: "2026-09-01T00:00:00.000Z",
  terminal: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
};

describe("TerminalInputArbiter", () => {
  it("keeps one automated state across queued work and preserves the controller lease", async () => {
    const store = new NanasaStore(":memory:");
    const control = new TerminalControlService(store);
    control.register(run);
    const connected = control.connect({
      runId: run.id,
      runGeneration: run.generation,
      viewerId: "viewer-one",
      requestedRole: "controller",
      takeover: false,
      close: vi.fn(),
    });
    const lease = connected.viewer.lease!;
    const arbiter = new TerminalInputArbiter(control);
    const states: string[] = [];
    const subscription = arbiter.subscribe(run.id, (state) => states.push(state));
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const operations: string[] = [];

    const first = arbiter.dispatchAutomated(run.id, async () => {
      operations.push("first:start");
      await firstBlocked;
      operations.push("first:end");
    });
    const second = arbiter.dispatchAutomated(run.id, async () => {
      operations.push("second");
    });

    expect(arbiter.inputState(run.id)).toBe("automated");
    expect(states).toEqual(["automated"]);
    await vi.waitFor(() => expect(operations).toEqual(["first:start"]));
    expect(control.heartbeat(run.id, connected.viewer.streamId, lease.id)?.id).toBe(lease.id);
    expect(control.hasController(run.id)).toBe(true);

    const input: Extract<TerminalClientFrame, { type: "input" }> = {
      type: "input",
      leaseId: lease.id,
      sequence: 0,
      data: "blocked",
    };
    expect(() =>
      arbiter.dispatch(
        run.id,
        connected.viewer.streamId,
        { write: vi.fn() } as unknown as AttachmentPty,
        input,
      ),
    ).toThrow(/automated terminal input/i);

    releaseFirst();
    await Promise.all([first, second]);
    expect(operations).toEqual(["first:start", "first:end", "second"]);
    expect(states).toEqual(["automated", "interactive"]);
    expect(arbiter.inputState(run.id)).toBe("interactive");
    expect(control.hasController(run.id)).toBe(true);

    subscription.dispose();
    control.close();
    store.close();
  });

  it("isolates runs and returns to interactive state after failure", async () => {
    const store = new NanasaStore(":memory:");
    const control = new TerminalControlService(store);
    const arbiter = new TerminalInputArbiter(control);
    const otherRunId = "other_run";
    const states: string[] = [];
    arbiter.subscribe(run.id, (state) => states.push(state));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = arbiter.dispatchAutomated(run.id, () => blocked);
    const other = arbiter.dispatchAutomated(otherRunId, async () => "other complete");
    await expect(other).resolves.toBe("other complete");
    expect(arbiter.inputState(run.id)).toBe("automated");
    expect(arbiter.inputState(otherRunId)).toBe("interactive");
    release();
    await first;

    await expect(
      arbiter.dispatchAutomated(run.id, async () => {
        throw new Error("injection failed");
      }),
    ).rejects.toThrow("injection failed");
    expect(arbiter.inputState(run.id)).toBe("interactive");
    expect(states).toEqual(["automated", "interactive", "automated", "interactive"]);
    control.close();
    store.close();
  });
});
