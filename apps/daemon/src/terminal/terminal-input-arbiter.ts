import { createHash } from "node:crypto";
import type { TerminalClientFrame } from "@nanasa/contracts";
import { DomainError } from "../store.js";
import type { AttachmentPty } from "./attachment-pty.js";
import type { TerminalControlService } from "./terminal-control-service.js";
import { TERMINAL_LIMITS } from "./terminal-transport-limits.js";

export function terminalViewSessionName(runId: string): string {
  return `nanasa-view-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
}

export class TerminalInputArbiter {
  readonly #automated = new Set<string>();
  readonly #queues = new Map<string, Promise<void>>();

  public constructor(private readonly control: TerminalControlService) {}

  public dispatch(
    runId: string,
    streamId: string,
    pty: AttachmentPty,
    frame: Extract<TerminalClientFrame, { type: "input" | "paste" | "focus" | "resize" }>,
  ): void {
    if (this.#automated.has(runId)) {
      throw new DomainError(
        "terminal_input_automation_active",
        "Automated terminal input is already in progress",
        409,
      );
    }
    this.control.assertController(runId, streamId, frame.leaseId);
    if (frame.type === "resize") {
      pty.resize(frame.cols, frame.rows);
      return;
    }
    if (frame.type === "focus") {
      pty.write(frame.focused ? "\u001b[I" : "\u001b[O");
      return;
    }
    const bytes = Buffer.byteLength(frame.data, "utf8");
    const limit =
      frame.type === "paste" ? TERMINAL_LIMITS.maxPasteBytes : TERMINAL_LIMITS.maxInputBytes;
    if (bytes > limit)
      throw new DomainError(
        "terminal_input_too_large",
        `Terminal ${frame.type} exceeds ${limit} bytes`,
        413,
      );
    pty.write(frame.data);
  }

  public dispatchAutomated<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    let result!: T;
    let failure: unknown;
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        this.#automated.add(runId);
        try {
          result = await operation();
        } catch (error) {
          failure = error;
        } finally {
          this.#automated.delete(runId);
        }
      });
    const settled = queued.finally(() => {
      if (this.#queues.get(runId) === settled) this.#queues.delete(runId);
    });
    this.#queues.set(runId, settled);
    return settled.then(() => {
      if (failure !== undefined) throw failure;
      return result;
    });
  }
}
