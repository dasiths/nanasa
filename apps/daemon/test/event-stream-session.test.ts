import type { DomainEvent } from "@nanasa/contracts";
import { describe, expect, it } from "vitest";
import { EventStreamSession, type EventStreamSocket } from "../src/event-stream-session.js";
import type { EventLog } from "../src/event-log.js";

function event(sequence: number, payload: Record<string, unknown> = {}): DomainEvent {
  return {
    sequence,
    id: `event-${sequence}`,
    type: "fixture.changed",
    aggregateType: "fixture",
    aggregateId: "fixture-one",
    occurredAt: "2026-08-29T12:00:00.000Z",
    payload,
  };
}

class SocketFixture implements EventStreamSocket {
  public readyState = 1;
  public bufferedAmount = 0;
  public readonly frames: string[] = [];
  public closeCode: number | undefined;
  readonly #closeListeners: Array<() => void> = [];

  public send(data: string): void {
    this.frames.push(data);
  }

  public close(code?: number): void {
    this.closeCode = code;
    this.readyState = 3;
  }

  public once(_event: "close", listener: () => void): void {
    this.#closeListeners.push(listener);
  }
}

describe("EventStreamSession", () => {
  it("installs live delivery before replay and deduplicates the overlap exactly", () => {
    const socket = new SocketFixture();
    let listener: ((value: DomainEvent) => void) | undefined;
    let pageRead = false;
    const log = {
      subscribe(callback: (value: DomainEvent) => void) {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
      bounds: () => ({ earliestAvailable: 1, highWater: 2 }),
      page: () => {
        if (!pageRead) {
          pageRead = true;
          listener?.(event(2));
          listener?.(event(3));
          return [event(1), event(2)];
        }
        return [];
      },
    };
    const session = new EventStreamSession(socket, log as EventLog, {
      afterSequence: 0,
      instanceId: "daemon-one",
      daemonEpoch: 1,
      heartbeatMs: 60_000,
    });
    session.start();

    const frames = socket.frames.map((frame) => JSON.parse(frame));
    expect(frames[0]).toMatchObject({ type: "subscription.started", highWater: 2 });
    expect(
      frames.filter((frame) => frame.type === "domain.event").map((frame) => frame.event.sequence),
    ).toEqual([1, 2, 3]);
    session.close();
  });

  it("bounds pending live bytes and emits a typed slow-consumer close", () => {
    const socket = new SocketFixture();
    let listener: ((value: DomainEvent) => void) | undefined;
    const log = {
      subscribe(callback: (value: DomainEvent) => void) {
        listener = callback;
        return () => undefined;
      },
      bounds: () => ({ earliestAvailable: 1, highWater: 1 }),
      page: () => {
        listener?.(event(2, { body: "x".repeat(512) }));
        return [event(1)];
      },
    };
    const session = new EventStreamSession(socket, log as EventLog, {
      afterSequence: 0,
      instanceId: "daemon-one",
      daemonEpoch: 1,
      pendingByteLimit: 256,
      heartbeatMs: 60_000,
    });
    session.start();

    expect(socket.closeCode).toBe(1013);
    expect(socket.frames.map((frame) => JSON.parse(frame))).toContainEqual(
      expect.objectContaining({ type: "subscription.slow-consumer" }),
    );
  });
});
