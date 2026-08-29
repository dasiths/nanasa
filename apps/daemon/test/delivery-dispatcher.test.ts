import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalDeliveryTarget } from "../src/delivery-dispatcher.js";
import { DeliveryDispatcher } from "../src/delivery-dispatcher.js";
import { NanasaStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(store = new NanasaStore(":memory:"), delivery: { expiresAt?: string } = {}) {
  const group = store.createGroup({ name: "Dispatchers" });
  const profile = store.createInternalAgentProfile({
    name: "Native",
    agentType: "pi",
    kind: "pi",
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
    delivery,
    hop: 0,
  });
  return { store, group, membership, submission };
}

describe("DeliveryDispatcher", () => {
  it("leases a delivery once across concurrent ticks and records terminal injection", async () => {
    const { store, submission } = createFixture();
    const publishedEventTypes: string[] = [];
    const unsubscribe = store.onEvent((event) => publishedEventTypes.push(event.type));
    const target: TerminalDeliveryTarget = {
      deliver: vi.fn(async () => undefined),
    };
    const dispatcher = new DeliveryDispatcher(store, target, { owner: "test-owner" });

    await Promise.all([dispatcher.tick(), dispatcher.tick(), dispatcher.tick()]);

    expect(target.deliver).toHaveBeenCalledTimes(1);
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      {
        status: "terminal_injected",
        attempts: 1,
      },
    ]);
    expect(publishedEventTypes).toContain("delivery.status-changed");
    expect(store.listEvents().at(-1)).toMatchObject({
      type: "delivery.status-changed",
      aggregateType: "message",
      aggregateId: submission.message.id,
      payload: {
        messageId: submission.message.id,
        recipientMemberId: "worker",
        status: "terminal_injected",
      },
    });
    unsubscribe();
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
    const target: TerminalDeliveryTarget = {
      deliver: vi.fn(async () => {
        await blocked;
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
      { status: "terminal_injected", attempts: 1 },
    ]);
    await Promise.all([first.close(), second.close()]);
    secondary.close();
    primary.close();
  });

  it("retries terminal failures with capped attempts and then dead-letters", async () => {
    const { store, submission } = createFixture();
    let now = new Date("2026-08-10T12:00:00.000Z");
    const target: TerminalDeliveryTarget = {
      deliver: vi.fn(async () => {
        throw new Error("terminal_owner_pane_unavailable");
      }),
    };
    const dispatcher = new DeliveryDispatcher(store, target, {
      maxAttempts: 2,
      retryBaseMs: 100,
      now: () => now,
    });

    await dispatcher.tick();
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      { status: "retrying", attempts: 1, reason: "terminal_owner_pane_unavailable" },
    ]);
    expect(store.listEvents().at(-1)).toMatchObject({
      type: "delivery.status-changed",
      payload: { status: "retrying", reason: "terminal_owner_pane_unavailable", attempts: 1 },
    });

    now = new Date(now.getTime() + 100);
    await dispatcher.tick();
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      { status: "dead-letter", attempts: 2, reason: "terminal_owner_pane_unavailable" },
    ]);
    expect(store.listEvents().at(-1)).toMatchObject({
      type: "delivery.status-changed",
      payload: { status: "dead-letter", reason: "terminal_owner_pane_unavailable", attempts: 2 },
    });
    expect(target.deliver).toHaveBeenCalledTimes(2);
    await dispatcher.close();
    store.close();
  });

  it("rejects expired delivery without injecting it", async () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const { store, submission } = createFixture(new NanasaStore(":memory:"), {
      expiresAt: "2026-08-10T11:59:59.000Z",
    });
    const target: TerminalDeliveryTarget = {
      deliver: vi.fn(async () => undefined),
    };
    const dispatcher = new DeliveryDispatcher(store, target, { now: () => now });

    await dispatcher.tick();

    expect(target.deliver).not.toHaveBeenCalled();
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      { status: "rejected", attempts: 1, reason: "delivery_expired" },
    ]);
    expect(store.listEvents().at(-1)).toMatchObject({
      type: "delivery.status-changed",
      payload: { status: "rejected", reason: "delivery_expired", attempts: 1 },
    });
    await dispatcher.close();
    store.close();
  });

  it("retries terminal writer conflicts and dead-letters without duplicate acceptance", async () => {
    const { store, submission } = createFixture();
    let now = new Date("2026-08-10T12:00:00.000Z");
    const target: TerminalDeliveryTarget = {
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

  it("keeps a delivery revoked when membership is removed during terminal injection", async () => {
    const { store, group, membership, submission } = createFixture();
    let accept!: () => void;
    const acceptance = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const target: TerminalDeliveryTarget = {
      deliver: vi.fn(async () => {
        await acceptance;
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

  it("publishes revoked delivery status changes", () => {
    const { store, submission } = createFixture();
    const claim = store.claimDeliveries({
      owner: "revocation-test",
      now: new Date(),
      leaseMs: 30_000,
      limit: 1,
    })[0]!;

    expect(store.revokeClaim(claim, "revocation-test", "operator_revoked")).toBe(true);
    expect(store.listDeliveries(submission.message.id)).toMatchObject([
      { status: "revoked", attempts: 1, reason: "operator_revoked" },
    ]);
    expect(store.listEvents().at(-1)).toMatchObject({
      type: "delivery.status-changed",
      payload: { status: "revoked", reason: "operator_revoked", attempts: 1 },
    });
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
    const target: TerminalDeliveryTarget = {
      deliver: vi.fn(async () => undefined),
    };
    const dispatcher = new DeliveryDispatcher(reopened, target);
    await dispatcher.tick();

    expect(target.deliver).toHaveBeenCalledOnce();
    expect(reopened.listDeliveries(submission.message.id)).toMatchObject([
      { status: "terminal_injected", attempts: 1 },
    ]);
    await dispatcher.close();
    reopened.close();
  });
});
