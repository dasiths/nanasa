import { createHash } from "node:crypto";
import type { TerminalClientFrame, TerminalInputState } from "@nanasa/contracts";
import { DomainError } from "../store.js";
import type { AttachmentPty } from "./attachment-pty.js";
import type { TerminalControlService } from "./terminal-control-service.js";
import { TERMINAL_LIMITS } from "./terminal-transport-limits.js";

export function terminalViewSessionName(runId: string): string {
  return `nanasa-view-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
}

export class TerminalInputArbiter {
  readonly #pending = new Map<string, number>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #listeners = new Map<string, Set<(state: TerminalInputState) => void>>();

  public constructor(private readonly control: TerminalControlService) {}

  public dispatch(
    runId: string,
    streamId: string,
    pty: AttachmentPty,
    frame: Extract<TerminalClientFrame, { type: "input" | "paste" | "focus" | "resize" }>,
  ): void {
    if (this.inputState(runId) === "automated") {
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

  public inputState(runId: string): TerminalInputState {
    return (this.#pending.get(runId) ?? 0) > 0 ? "automated" : "interactive";
  }

  public subscribe(
    runId: string,
    listener: (state: TerminalInputState) => void,
  ): { dispose(): void } {
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return {
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.#listeners.delete(runId);
      },
    };
  }

  public dispatchAutomated<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    this.#incrementPending(runId);
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settle = () => {
      this.#decrementPending(runId);
      if (this.#queues.get(runId) === barrier) this.#queues.delete(runId);
    };
    const barrier = result.then(settle, settle);
    this.#queues.set(runId, barrier);
    return result;
  }

  #incrementPending(runId: string): void {
    const pending = this.#pending.get(runId) ?? 0;
    this.#pending.set(runId, pending + 1);
    if (pending === 0) this.#emit(runId, "automated");
  }

  #decrementPending(runId: string): void {
    const pending = this.#pending.get(runId) ?? 0;
    if (pending <= 1) {
      this.#pending.delete(runId);
      this.#emit(runId, "interactive");
      return;
    }
    this.#pending.set(runId, pending - 1);
  }

  #emit(runId: string, state: TerminalInputState): void {
    for (const listener of this.#listeners.get(runId) ?? []) {
      try {
        listener(state);
      } catch {
        // A viewer notification cannot interrupt terminal input arbitration.
      }
    }
  }
}
