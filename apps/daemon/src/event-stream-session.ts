import { EventServerFrameSchema, type DomainEvent, type EventServerFrame } from "@nanasa/contracts";
import { EVENT_PENDING_BYTE_LIMIT, EVENT_REPLAY_PAGE_SIZE } from "./protocol-metadata.js";
import type { EventLog } from "./event-log.js";

export interface EventStreamSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  once(event: "close", listener: () => void): void;
}

export interface EventStreamSessionOptions {
  afterSequence: number;
  requestedInstanceId?: string;
  instanceId: string;
  daemonEpoch: number;
  replayPageSize?: number;
  pendingByteLimit?: number;
  heartbeatMs?: number;
}

export class EventStreamSession {
  readonly #socket: EventStreamSocket;
  readonly #eventLog: EventLog;
  readonly #options: Required<Omit<EventStreamSessionOptions, "requestedInstanceId">> & {
    requestedInstanceId?: string;
  };
  readonly #pending: DomainEvent[] = [];
  readonly #unsubscribe: () => void;
  #pendingBytes = 0;
  #cursor: number;
  #replaying = true;
  #closed = false;
  #heartbeat: NodeJS.Timeout | undefined;

  public constructor(
    socket: EventStreamSocket,
    eventLog: EventLog,
    options: EventStreamSessionOptions,
  ) {
    this.#socket = socket;
    this.#eventLog = eventLog;
    this.#options = {
      ...options,
      replayPageSize: options.replayPageSize ?? EVENT_REPLAY_PAGE_SIZE,
      pendingByteLimit: options.pendingByteLimit ?? EVENT_PENDING_BYTE_LIMIT,
      heartbeatMs: options.heartbeatMs ?? 15_000,
    };
    this.#cursor = options.afterSequence;
    this.#unsubscribe = this.#eventLog.subscribe((event) => this.#onLiveEvent(event));
    this.#socket.once("close", () => this.close());
  }

  public start(): void {
    if (
      this.#options.requestedInstanceId !== undefined &&
      this.#options.requestedInstanceId !== this.#options.instanceId
    ) {
      this.#reset("instance_changed", this.#options.afterSequence);
      return;
    }
    const bounds = this.#eventLog.bounds();
    if (this.#options.afterSequence > bounds.highWater) {
      this.#reset("cursor_ahead", bounds.highWater);
      return;
    }
    if (
      bounds.earliestAvailable > 0 &&
      this.#options.afterSequence < bounds.earliestAvailable - 1
    ) {
      this.#reset("cursor_expired", bounds.highWater);
      return;
    }

    this.#send({
      type: "subscription.started",
      version: 1,
      cursor: this.#options.afterSequence,
      highWater: bounds.highWater,
      earliestAvailable: bounds.earliestAvailable,
      instanceId: this.#options.instanceId,
      daemonEpoch: this.#options.daemonEpoch,
    });
    while (!this.#closed && this.#cursor < bounds.highWater) {
      const page = this.#eventLog.page(
        this.#cursor,
        bounds.highWater,
        this.#options.replayPageSize,
      );
      if (page.length === 0) {
        this.#reset("cursor_expired", bounds.highWater);
        return;
      }
      for (const event of page) this.#sendEvent(event);
    }
    this.#replaying = false;
    for (const event of this.#pending
      .splice(0)
      .sort((left, right) => left.sequence - right.sequence)) {
      if (this.#closed) break;
      if (event.sequence > this.#cursor) this.#sendEvent(event);
    }
    this.#pendingBytes = 0;
    if (!this.#closed) {
      this.#heartbeat = setInterval(() => {
        this.#send({
          type: "subscription.heartbeat",
          cursor: this.#cursor,
          sentAt: new Date().toISOString(),
        });
      }, this.#options.heartbeatMs);
      this.#heartbeat.unref();
    }
  }

  public plannedRestart(retryAfterMs = 1_000): void {
    if (this.#closed) return;
    this.#sendBestEffort({
      type: "subscription.planned-restart",
      daemonEpoch: this.#options.daemonEpoch,
      retryAfterMs,
    });
    this.#closed = true;
    this.#socket.close(1012, "Planned daemon restart");
    this.#cleanup();
  }

  public close(): void {
    if (this.#closed) {
      this.#cleanup();
      return;
    }
    this.#closed = true;
    this.#cleanup();
  }

  #onLiveEvent(event: DomainEvent): void {
    if (this.#closed || event.sequence <= this.#cursor) return;
    if (!this.#replaying) {
      this.#sendEvent(event);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    this.#pendingBytes += bytes;
    if (this.#pendingBytes > this.#options.pendingByteLimit) {
      this.#slowConsumer();
      return;
    }
    this.#pending.push(event);
  }

  #sendEvent(event: DomainEvent): void {
    if (event.sequence <= this.#cursor) return;
    if (this.#send({ type: "domain.event", event })) this.#cursor = event.sequence;
  }

  #send(frame: EventServerFrame): boolean {
    if (this.#closed || this.#socket.readyState !== 1) return false;
    const serialized = JSON.stringify(EventServerFrameSchema.parse(frame));
    if (
      this.#socket.bufferedAmount + Buffer.byteLength(serialized, "utf8") >
      this.#options.pendingByteLimit
    ) {
      this.#slowConsumer();
      return false;
    }
    this.#socket.send(serialized);
    return true;
  }

  #sendBestEffort(frame: EventServerFrame): void {
    if (this.#socket.readyState !== 1) return;
    const serialized = JSON.stringify(EventServerFrameSchema.parse(frame));
    if (
      this.#socket.bufferedAmount + Buffer.byteLength(serialized, "utf8") <=
      this.#options.pendingByteLimit
    ) {
      this.#socket.send(serialized);
    }
  }

  #slowConsumer(): void {
    if (this.#closed) return;
    this.#sendBestEffort({
      type: "subscription.slow-consumer",
      cursor: this.#cursor,
      retryAfterMs: 1_000,
    });
    this.#closed = true;
    this.#socket.close(1013, "Event consumer exceeded the pending-byte limit");
    this.#cleanup();
  }

  #reset(reason: "cursor_expired" | "cursor_ahead" | "instance_changed", cursor: number): void {
    this.#sendBestEffort({
      type: "subscription.reset-required",
      reason,
      cursor,
      snapshotUrl: "/api/v1/snapshot",
    });
    this.#closed = true;
    this.#socket.close(4009, "Event cursor reset required");
    this.#cleanup();
  }

  #cleanup(): void {
    this.#unsubscribe();
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
    this.#pending.length = 0;
    this.#pendingBytes = 0;
  }
}
