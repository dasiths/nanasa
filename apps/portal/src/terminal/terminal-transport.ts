import {
  TERMINAL_PROTOCOL,
  TerminalServerFrameSchema,
  type TerminalEndpointStatus,
  type TerminalLease,
  type TerminalRole,
  type TerminalServerFrame,
} from "@nanasa/contracts";

export interface TerminalTransportOptions {
  endpoint: Extract<TerminalEndpointStatus, { state: "ready" }>;
  runGeneration: number;
  viewerId: string;
  requestedRole: TerminalRole;
  cols: number;
  rows: number;
  onFrame(frame: TerminalServerFrame): void;
  onState(state: "connecting" | "connected" | "reconnecting" | "closed"): void;
}

export class TerminalTransport {
  #socket: WebSocket | undefined;
  #lease: TerminalLease | undefined;
  #sequence = 0;
  #closed = false;
  #attempt = 0;
  #heartbeat: number | undefined;
  #reconnect: number | undefined;
  #takeoverOnReconnect = false;
  #requestedRole: TerminalRole;
  #cols: number;
  #rows: number;
  #initialized = false;

  public constructor(private readonly options: TerminalTransportOptions) {
    this.#requestedRole = options.requestedRole;
    this.#cols = options.cols;
    this.#rows = options.rows;
  }

  public connect(takeover = this.#takeoverOnReconnect): void {
    this.disposeSocket();
    this.#initialized = false;
    this.options.onState(this.#attempt === 0 ? "connecting" : "reconnecting");
    const url = new URL(this.options.endpoint.streamUrl, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, TERMINAL_PROTOCOL);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#attempt = 0;
      socket.send(
        JSON.stringify({
          type: "hello",
          version: 1,
          runId: this.options.endpoint.runId,
          runGeneration: this.options.runGeneration,
          viewerId: this.options.viewerId,
          requestedRole: this.#requestedRole,
          takeover,
          cols: this.#cols,
          rows: this.#rows,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = TerminalServerFrameSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success) {
        socket.close(1007, "Malformed terminal server frame");
        return;
      }
      const frame = parsed.data;
      if (frame.type === "welcome" || frame.type === "lease") {
        if (frame.lease === undefined) this.#lease = undefined;
        else this.#lease = frame.lease;
      }
      if (frame.type === "welcome") {
        this.#heartbeat = window.setInterval(
          () =>
            this.send({
              type: "heartbeat",
              ...(this.#lease === undefined ? {} : { leaseId: this.#lease.id }),
            }),
          Math.max(1_000, Math.floor(frame.limits.heartbeatMs / 2)),
        );
      }
      if (frame.type === "baseline" || frame.type === "reset") {
        this.#initialized = true;
        this.options.onState("connected");
      }
      this.options.onFrame(frame);
    });
    socket.addEventListener("close", (event) => {
      this.disposeSocket();
      if (event.code === 4001) {
        this.#takeoverOnReconnect = false;
        this.#requestedRole = "observer";
      }
      if (this.#closed || event.code === 1000) {
        this.options.onState("closed");
        return;
      }
      if (this.#attempt >= 6) {
        this.options.onState("closed");
        return;
      }
      const delay = Math.min(5_000, 250 * 2 ** this.#attempt) + Math.floor(Math.random() * 100);
      this.#attempt += 1;
      this.options.onState("reconnecting");
      this.#reconnect = window.setTimeout(() => this.connect(), delay);
    });
  }

  public input(data: string): void {
    if (!this.#initialized || this.#lease === undefined) return;
    this.send({ type: "input", leaseId: this.#lease.id, sequence: this.#sequence++, data });
  }

  public paste(data: string): void {
    if (!this.#initialized || this.#lease === undefined) return;
    this.send({ type: "paste", leaseId: this.#lease.id, data });
  }

  public focus(focused: boolean): void {
    if (!this.#initialized || this.#lease === undefined) return;
    this.send({ type: "focus", leaseId: this.#lease.id, focused });
  }

  public resize(cols: number, rows: number): void {
    this.#cols = cols;
    this.#rows = rows;
    if (this.#lease === undefined) return;
    this.send({ type: "resize", leaseId: this.#lease.id, cols, rows });
  }

  public takeover(): void {
    this.#requestedRole = "controller";
    this.#takeoverOnReconnect = true;
    this.send({
      type: "takeover",
      ...(this.#lease === undefined ? {} : { expectedLeaseId: this.#lease.id }),
    });
  }

  public releaseController(): void {
    this.#requestedRole = "observer";
    this.#takeoverOnReconnect = false;
    if (this.#lease === undefined) return;
    this.send({ type: "release", leaseId: this.#lease.id });
    this.#lease = undefined;
  }

  public dispose(): void {
    this.#closed = true;
    if (this.#reconnect !== undefined) window.clearTimeout(this.#reconnect);
    if (this.#lease !== undefined) this.send({ type: "release", leaseId: this.#lease.id });
    this.disposeSocket();
    this.options.onState("closed");
  }

  #sendable(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  #send(frame: unknown): void {
    if (this.#sendable()) this.#socket?.send(JSON.stringify(frame));
  }

  private send(frame: unknown): void {
    this.#send(frame);
  }

  private disposeSocket(): void {
    if (this.#heartbeat !== undefined) window.clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) socket.close();
  }
}
