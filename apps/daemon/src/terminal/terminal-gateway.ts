import {
  type AgentRun,
  TERMINAL_PROTOCOL,
  type TerminalClientFrame,
  TerminalClientFrameSchema,
  TerminalEndpointStatusSchema,
  type TerminalReadResult,
  type TerminalServerFrame,
  TerminalServerFrameSchema,
} from "@nanasa/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import { AttachmentPty } from "./attachment-pty.js";
import { TerminalControlService, type TerminalViewer } from "./terminal-control-service.js";
import { TerminalEffectPolicy } from "./terminal-effect-policy.js";
import { TerminalInputArbiter } from "./terminal-input-arbiter.js";
import type { TerminalReadService } from "./terminal-read-service.js";
import {
  TERMINAL_HANDSHAKE_TIMEOUT_MS,
  TERMINAL_LIMITS,
  TERMINAL_MAX_BYTES_PER_WINDOW,
  TERMINAL_MAX_MESSAGES_PER_WINDOW,
  TERMINAL_RATE_WINDOW_MS,
} from "./terminal-transport-limits.js";

function messageBytes(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0);
  return data.byteLength;
}

function messageText(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Buffer.from(new Uint8Array(data)).toString("utf8");
}

export async function initializeTerminalAttachment(options: {
  read(): Promise<Pick<TerminalReadResult, "text" | "truncated">>;
  sendBaseline(baseline: Pick<TerminalReadResult, "text" | "truncated">): boolean;
  sendReset(): boolean;
  attach(): void;
  timeoutMs?: number;
}): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  let baseline: Pick<TerminalReadResult, "text" | "truncated">;
  try {
    baseline = await Promise.race([
      options.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("terminal_history_timeout")),
          options.timeoutMs ?? TERMINAL_HANDSHAKE_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } catch {
    if (options.sendReset()) options.attach();
    return;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (options.sendBaseline(baseline)) options.attach();
}

export function boundedBaselineFrame(
  sequence: number,
  baseline: Pick<TerminalReadResult, "text" | "truncated">,
): Extract<TerminalServerFrame, { type: "baseline" }> {
  const frame = (data: string, truncated: boolean) => ({
    type: "baseline" as const,
    sequence,
    data,
    truncated,
  });
  const encodedBytes = (candidate: ReturnType<typeof frame>) =>
    Buffer.byteLength(JSON.stringify(candidate), "utf8");
  const full = frame(baseline.text, baseline.truncated);
  if (encodedBytes(full) <= TERMINAL_LIMITS.maxFrameBytes) return full;

  let low = 0;
  let high = baseline.text.length;
  while (low < high) {
    const start = Math.floor((low + high) / 2);
    if (encodedBytes(frame(baseline.text.slice(start), true)) <= TERMINAL_LIMITS.maxFrameBytes) {
      high = start;
    } else {
      low = start + 1;
    }
  }
  if (/^[\uDC00-\uDFFF]/.test(baseline.text.slice(low))) low += 1;
  return frame(baseline.text.slice(low), true);
}

export class TerminalGateway {
  readonly #control: TerminalControlService;
  readonly #arbiter: TerminalInputArbiter;
  readonly #history = new Map<string, TerminalServerFrame[]>();

  public constructor(
    control: TerminalControlService,
    private readonly reads: TerminalReadService,
    private readonly daemonEpoch: number,
    private readonly tmuxPath = "tmux",
    arbiter?: TerminalInputArbiter,
  ) {
    this.#control = control;
    this.#arbiter = arbiter ?? new TerminalInputArbiter(control);
  }

  public start(run: AgentRun): void {
    this.#control.register(run);
  }

  public startDetached(run: AgentRun): void {
    this.start(run);
  }

  public async reconcile(runs: AgentRun[]): Promise<void> {
    for (const run of runs) this.start(run);
  }

  public unavailable(run: AgentRun): void {
    this.#control.unregister(run.id, "terminal_unavailable");
  }

  public async stop(runId: string): Promise<void> {
    this.#control.unregister(runId);
    this.#history.delete(runId);
  }

  public status(runId: string) {
    return TerminalEndpointStatusSchema.parse(this.#control.status(runId));
  }

  public hasController(runId: string): boolean {
    return this.#control.hasController(runId);
  }

  public hasWriter(runId: string): boolean {
    return this.hasController(runId);
  }

  public async close(): Promise<void> {
    this.#control.close();
    this.#history.clear();
  }

  public register(app: FastifyInstance): void {
    app.get<{ Params: { runId: string } }>(
      "/api/v1/terminal-stream/:runId",
      {
        websocket: true,
        preValidation(request, _reply, done) {
          const protocols = request.headers["sec-websocket-protocol"]
            ?.split(",")
            .map((value) => value.trim());
          if (protocols?.includes(TERMINAL_PROTOCOL) !== true) {
            done(new Error("nanasa-terminal.v1 WebSocket protocol is required"));
            return;
          }
          done();
        },
      },
      (socket, request) => this.#open(socket, request),
    );
  }

  #open(socket: WebSocket, request: FastifyRequest<{ Params: { runId: string } }>): void {
    let viewer: TerminalViewer | undefined;
    let pty: AttachmentPty | undefined;
    let dataSubscription: { dispose(): void } | undefined;
    let exitSubscription: { dispose(): void } | undefined;
    let sequence = 0;
    let windowStartedAt = Date.now();
    let windowBytes = 0;
    let windowMessages = 0;
    let closed = false;
    let initializing = false;
    let pendingResize: Extract<TerminalClientFrame, { type: "resize" }> | undefined;
    let attachmentSize = { cols: 120, rows: 40 };
    const effects = new TerminalEffectPolicy();
    let connectedRun: AgentRun | undefined;

    const close = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      pty?.close();
      if (viewer !== undefined) this.#control.disconnect(request.params.runId, viewer.streamId);
      if (socket.readyState === socket.OPEN) socket.close(code, reason.slice(0, 120));
    };

    const send = (frame: TerminalServerFrame): boolean => {
      if (closed || socket.readyState !== socket.OPEN) return false;
      const payload = JSON.stringify(TerminalServerFrameSchema.parse(frame));
      const bytes = Buffer.byteLength(payload, "utf8");
      if (
        bytes > TERMINAL_LIMITS.maxFrameBytes ||
        socket.bufferedAmount + bytes > TERMINAL_LIMITS.maxOutputQueueBytes
      ) {
        close(1009, "terminal_slow_consumer");
        return false;
      }
      socket.send(payload);
      return true;
    };

    const attach = (run: AgentRun, role: "controller" | "observer", cols: number, rows: number) => {
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      pty?.close();
      const attachment = new AttachmentPty(run, role, { cols, rows }, { tmuxPath: this.tmuxPath });
      attachmentSize = { cols, rows };
      pty = attachment;
      dataSubscription = attachment.onData((data) => {
        const filtered = effects.filter(data, viewer?.role === "controller");
        if (filtered.output.length > 0) {
          const frame: TerminalServerFrame = {
            type: "output",
            sequence: sequence++,
            data: filtered.output,
          };
          if (send(frame) && viewer?.role === "controller") this.#remember(run.id, frame);
        }
        for (const effect of filtered.effects) send(effect);
      });
      exitSubscription = attachment.onExit(() => close(1012, "terminal_attachment_exited"));
    };

    const handshakeTimer = setTimeout(
      () => close(1008, "terminal_handshake_timeout"),
      TERMINAL_HANDSHAKE_TIMEOUT_MS,
    );
    handshakeTimer.unref();
    socket.on("message", (data, binary) => {
      const now = Date.now();
      if (now - windowStartedAt >= TERMINAL_RATE_WINDOW_MS) {
        windowStartedAt = now;
        windowBytes = 0;
        windowMessages = 0;
      }
      windowBytes += messageBytes(data);
      windowMessages += 1;
      if (
        binary ||
        messageBytes(data) > TERMINAL_LIMITS.maxFrameBytes ||
        windowBytes > TERMINAL_MAX_BYTES_PER_WINDOW ||
        windowMessages > TERMINAL_MAX_MESSAGES_PER_WINDOW
      ) {
        close(1009, "terminal_frame_limit");
        return;
      }
      let frame: TerminalClientFrame;
      try {
        frame = TerminalClientFrameSchema.parse(JSON.parse(messageText(data)));
      } catch {
        close(1007, "terminal_frame_malformed");
        return;
      }
      try {
        if (viewer === undefined) {
          if (frame.type !== "hello" || frame.runId !== request.params.runId) {
            close(1008, "terminal_hello_required");
            return;
          }
          clearTimeout(handshakeTimer);
          const connected = this.#control.connect({
            runId: frame.runId,
            runGeneration: frame.runGeneration,
            viewerId: frame.viewerId,
            requestedRole: frame.requestedRole,
            takeover: frame.takeover,
            close,
          });
          connectedRun = connected.run;
          viewer = connected.viewer;
          const welcome: TerminalServerFrame = {
            type: "welcome",
            version: 1,
            daemonEpoch: this.daemonEpoch,
            streamId: viewer.streamId,
            streamGeneration: viewer.streamGeneration,
            runId: connected.run.id,
            runGeneration: connected.run.generation,
            binding: connected.run.terminal!,
            role: viewer.role,
            ...(viewer.lease === undefined ? {} : { lease: viewer.lease }),
            limits: TERMINAL_LIMITS,
            capabilities: {
              input: viewer.role === "controller",
              paste: viewer.role === "controller",
              focus: viewer.role === "controller",
              resize: viewer.role === "controller",
              effects: viewer.role === "controller",
              read: true,
              checkpoints: true,
            },
          };
          if (!send(welcome)) return;
          initializing = true;
          void initializeTerminalAttachment({
            read: () =>
              this.reads.read({
                runId: connected.run.id,
                generation: connected.run.generation,
                source: "history",
                maxLines: 500,
                maxBytes: 256 * 1024,
              }),
            sendBaseline: (baseline) => send(boundedBaselineFrame(sequence++, baseline)),
            sendReset: () => send({ type: "reset", reason: "history_lost" }),
            attach: () => {
              initializing = false;
              attach(
                connected.run,
                connected.viewer.role,
                pendingResize?.cols ?? frame.cols,
                pendingResize?.rows ?? frame.rows,
              );
            },
          }).catch((error: unknown) =>
            close(1011, error instanceof Error ? error.message : "terminal_attachment_failed"),
          );
          return;
        }
        if (frame.type === "hello") {
          close(1008, "terminal_hello_duplicate");
          return;
        }
        if (frame.type === "heartbeat") {
          const lease = this.#control.heartbeat(
            request.params.runId,
            viewer.streamId,
            frame.leaseId,
          );
          if (lease !== undefined) {
            send({ type: "lease", role: "controller", lease, reason: "acquired" });
          }
          return;
        }
        if (initializing) {
          if (frame.type === "resize") {
            this.#control.assertController(request.params.runId, viewer.streamId, frame.leaseId);
            pendingResize = frame;
            return;
          }
          if (frame.type === "ack") return;
          close(1008, "terminal_initializing");
          return;
        }
        if (frame.type === "takeover") {
          const lease = this.#control.takeover(
            request.params.runId,
            viewer.streamId,
            frame.expectedLeaseId,
          );
          attach(connectedRun as AgentRun, "controller", attachmentSize.cols, attachmentSize.rows);
          send({ type: "lease", role: "controller", lease, reason: "taken-over" });
          return;
        }
        if (frame.type === "release") {
          this.#control.release(request.params.runId, viewer.streamId, frame.leaseId);
          attach(connectedRun as AgentRun, "observer", attachmentSize.cols, attachmentSize.rows);
          send({ type: "lease", role: "observer", reason: "released" });
          return;
        }
        if (frame.type !== "ack") {
          if (frame.type === "resize") attachmentSize = { cols: frame.cols, rows: frame.rows };
          this.#arbiter.dispatch(
            request.params.runId,
            viewer.streamId,
            pty as AttachmentPty,
            frame,
          );
        }
      } catch (error) {
        close(1008, error instanceof Error ? error.message : "terminal_policy_rejected");
      }
    });
    socket.on("close", () => close(1000, "terminal_disconnected"));
    socket.on("error", () => close(1011, "terminal_transport_error"));
  }

  #remember(runId: string, frame: TerminalServerFrame): void {
    const history = this.#history.get(runId) ?? [];
    history.push(frame);
    if (history.length > TERMINAL_LIMITS.reconnectHistoryFrames) {
      history.splice(0, history.length - TERMINAL_LIMITS.reconnectHistoryFrames);
    }
    this.#history.set(runId, history);
  }
}
