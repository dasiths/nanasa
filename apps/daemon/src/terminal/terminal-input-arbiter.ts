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
  public constructor(private readonly control: TerminalControlService) {}

  public dispatch(
    runId: string,
    streamId: string,
    pty: AttachmentPty,
    frame: Extract<TerminalClientFrame, { type: "input" | "paste" | "focus" | "resize" }>,
  ): void {
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
}
