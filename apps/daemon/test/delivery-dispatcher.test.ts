import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryTarget } from "../src/delivery-dispatcher.js";
import { DeliveryDispatcher } from "../src/delivery-dispatcher.js";
import { NanasaStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(
  store = new NanasaStore(":memory:"),
  mode: "queue" | "steer" | "terminal" = "steer",
) {
  const group = store.createGroup({ name: "Dispatchers" });
  const profile = store.createInternalAgentProfile({
    name: "Native",
    agentType: "pi",
    kind: "pi",
    adapter: "pi-rpc",
    capabilities: ["queue", "steer"],
    command: "pi",
    args: [],
    environment: {},
  });
  const membership = store.addMembership(group.id, {
    memberId: "worker",
    agentProfileId: profile.id,
    alias: "Worker",
  });
  store.createRun({
    id: "run_worker",
    groupId: group.id,
    memberId: membership.memberId,
    agentProfileId: profile.id,
    generation: 1,
    status: "running",
    startedAt: "2026-08-10T12:00:00.000Z",
  });
  const submission = store.submitMessage(group.id, {
    intent: "request",
    sender: { kind: "operator", operatorId: "operator" },
    audience: { kind: "dm", memberId: membership.memberId },
    body: { contentType: "text/plain", text: "Review this." },
    delivery: { mode },
    hop: 0,
  });
  return { store, group, membership, submission };
}

describe("DeliveryDispatcher", () => {
  it("leases a delivery once across concurrent ticks and records settlement", async () => {
    const { store, submission } = createFixture();
    let settle!: (value: { status: "processed" }) => void;
    const settlement = new Promise<{ status: "processed" }>((resolve) => {
      settle = resolve;
    });
    const target: DeliveryTarget = {
      capabilities: () => new Set(["queue", "steer"]),
      deliver: vi.fn(async (_claim, mode) => ({
        appliedMode: mode,
        adapterSessionId: "session-1",
        adapterMessageId: submission.message.id,
        settlement,
      })),
    };
    const dispatcher = new DeliveryDispatcher(store, target, { owner: "test-owner" });

    await Promise.all([dispatcher.tick(), dispatcher.tick(), dispatcher.tick()]);

    expect(target.deliver).toHaveBeenCalledTimes(1);
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      {
        status: "consumed",
        attempts: 1,
        appliedMode: "steer",
        adapterSessionId: "session-1",
        adapterMessageId: submission.message.id,
      },
    ]);

    settle({ status: "processed" });
    await vi.waitFor(() =>
      expect(store.listDeliveries(submission.message.id)).toMatchObject([
        { status: "processed", attempts: 1 },
      ]),
    );
    await dispatcher.close();
    store.close();
  });

  it("prevents duplicate processing across dispatcher owners and database connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-dispatch-lease-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const primary = new NanasaStore(databasePath);
    const { submission } = createFixture(primary);
    const secondary = new NanasaStore(databasePath);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target: DeliveryTarget = {
      capabilities: () => new Set(["queue", "steer"]),
      deliver: vi.fn(async (_claim, mode) => {
        await blocked;
        return { appliedMode: mode };
      }),
    };
    const first = new DeliveryDispatcher(primary, target, { owner: "first" });
    const second = new DeliveryDispatcher(secondary, target, { owner: "second" });

    const firstTick = first.tick();
    const secondTick = second.tick();
    await vi.waitFor(() => expect(target.deliver).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([firstTick, secondTick]);

    expect(primary.listDeliveries(submission.message.id)).toMatchObject([
      { status: "consumed", attempts: 1 },
    ]);
    await Promise.all([first.close(), second.close()]);
    secondary.close();
    primary.close();
  });

  it("falls back from steer to queue using the adapter's current capabilities", async () => {
    const { store, submission } = createFixture();
    const target: DeliveryTarget = {
      capabilities: () => new Set(["queue"]),
      deliver: vi.fn(async (_claim, mode) => ({ appliedMode: mode })),
    };
    const dispatcher = new DeliveryDispatcher(store, target);

    await dispatcher.tick();

    expect(target.deliver).toHaveBeenCalledWith(expect.any(Object), "queue");
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      {
        status: "consumed",
        requestedMode: "steer",
        appliedMode: "queue",
        fallbackApplied: true,
        reason: "requested_mode_not_supported",
      },
    ]);
    await dispatcher.close();
    store.close();
  });

  it("keeps explicit terminal delivery on the terminal transport without fallback", async () => {
    const { store, submission } = createFixture(new NanasaStore(":memory:"), "terminal");
    const target: DeliveryTarget = {
      capabilities: () => new Set(["terminal"]),
      deliver: vi.fn(async (_claim, mode) => ({
        appliedMode: mode,
        adapterMessageId: submission.message.id,
      })),
    };
    const dispatcher = new DeliveryDispatcher(store, target);

    await dispatcher.tick();

    expect(target.deliver).toHaveBeenCalledWith(expect.any(Object), "terminal");
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      {
        status: "consumed",
        requestedMode: "terminal",
        appliedMode: "terminal",
        fallbackApplied: false,
        adapter: "terminal",
        adapterMessageId: submission.message.id,
      },
    ]);
    await dispatcher.close();
    store.close();
  });

  it("rejects unavailable terminal delivery instead of converting it to queue", async () => {
    const { store, submission } = createFixture(new NanasaStore(":memory:"), "terminal");
    const target: DeliveryTarget = {
      capabilities: () => new Set(["queue"]),
      deliver: vi.fn(async (_claim, mode) => ({ appliedMode: mode })),
    };
    const dispatcher = new DeliveryDispatcher(store, target);

    await dispatcher.tick();

    expect(target.deliver).not.toHaveBeenCalled();
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      {
        status: "rejected",
        requestedMode: "terminal",
        appliedMode: "terminal",
        fallbackApplied: false,
        reason: "adapter_capability_unsupported",
      },
    ]);
    await dispatcher.close();
    store.close();
  });

  it("retries adapter failures with capped attempts and then dead-letters", async () => {
    const { store, submission } = createFixture();
    let now = new Date("2026-08-10T12:00:00.000Z");
    const target: DeliveryTarget = {
      capabilities: () => new Set(["queue", "steer"]),
      deliver: vi.fn(async () => {
        throw new Error("fake_adapter_failure");
      }),
    };
    const dispatcher = new DeliveryDispatcher(store, target, {
      maxAttempts: 2,
      retryBaseMs: 100,
      now: () => now,
    });

    await dispatcher.tick();
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      { status: "retrying", attempts: 1, reason: "fake_adapter_failure" },
    ]);

    now = new Date(now.getTime() + 100);
    await dispatcher.tick();
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      { status: "dead-letter", attempts: 2, reason: "fake_adapter_failure" },
    ]);
    expect(target.deliver).toHaveBeenCalledTimes(2);
    await dispatcher.close();
    store.close();
  });

  it("retries terminal writer conflicts and dead-letters without duplicate acceptance", async () => {
    const { store, submission } = createFixture(new NanasaStore(":memory:"), "terminal");
    let now = new Date("2026-08-10T12:00:00.000Z");
    const target: DeliveryTarget = {
      capabilities: () => new Set(["terminal"]),
      deliver: vi.fn(async () => {
        throw new Error("terminal_writer_conflict");
      }),
    };
    const dispatcher = new DeliveryDispatcher(store, target, {
      maxAttempts: 2,
      retryBaseMs: 100,
      now: () => now,
    });

    await dispatcher.tick();
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      {
        status: "retrying",
        attempts: 1,
        requestedMode: "terminal",
        appliedMode: "terminal",
        fallbackApplied: false,
        reason: "terminal_writer_conflict",
      },
    ]);

    now = new Date(now.getTime() + 100);
    await dispatcher.tick();
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      { status: "dead-letter", attempts: 2, reason: "terminal_writer_conflict" },
    ]);
    expect(target.deliver).toHaveBeenCalledTimes(2);
    await dispatcher.close();
    store.close();
  });

  it("marks authoritative settlement rejection as failed", async () => {
    const { store, submission } = createFixture();
    const target: DeliveryTarget = {
      capabilities: () => new Set(["queue", "steer"]),
      deliver: async (_claim, mode) => ({
        appliedMode: mode,
        settlement: Promise.reject(new Error("settlement_lost")),
      }),
    };
    const dispatcher = new DeliveryDispatcher(store, target);

    await dispatcher.tick();
    await vi.waitFor(() =>
      expect(store.listDeliveries(submission.message.id)).toMatchObject([
        { status: "failed", reason: "settlement_lost" },
      ]),
    );
    await dispatcher.close();
    store.close();
  });

  it("keeps a delivery revoked when membership is removed during adapter acceptance", async () => {
    const { store, group, membership, submission } = createFixture();
    let accept!: () => void;
    const acceptance = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const target: DeliveryTarget = {
      capabilities: () => new Set(["queue", "steer"]),
      deliver: vi.fn(async (_claim, mode) => {
        await acceptance;
        return { appliedMode: mode };
      }),
    };
    const dispatcher = new DeliveryDispatcher(store, target);

    const tick = dispatcher.tick();
    await vi.waitFor(() => expect(target.deliver).toHaveBeenCalledOnce());
    store.removeMembership(group.id, membership.memberId);
    accept();
    await tick;

    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      { status: "revoked", reason: "membership_removed" },
    ]);
    await dispatcher.close();
    store.close();
  });

  it("dispatches queued work after the store is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-dispatch-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nanasa.sqlite");
    const original = new NanasaStore(databasePath);
    const { submission } = createFixture(original);
    original.close();

    const reopened = new NanasaStore(databasePath);
    const target: DeliveryTarget = {
      capabilities: () => new Set(["queue", "steer"]),
      deliver: vi.fn(async (_claim, mode) => ({ appliedMode: mode })),
    };
    const dispatcher = new DeliveryDispatcher(reopened, target);
    await dispatcher.tick();

    expect(target.deliver).toHaveBeenCalledOnce();
    expect(reopened.listDeliveries(submission.message.id)).toMatchObject([
      { status: "consumed", attempts: 1 },
    ]);
    await dispatcher.close();
    reopened.close();
  });
});
