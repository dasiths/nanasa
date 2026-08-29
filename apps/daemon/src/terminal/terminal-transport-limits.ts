import type { TerminalLimits } from "@nanasa/contracts";

export const TERMINAL_LIMITS: TerminalLimits = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxInputBytes: 64 * 1024,
  maxPasteBytes: 192 * 1024,
  maxOutputQueueBytes: 1024 * 1024,
  maxViewers: 4,
  maxObservers: 3,
  maxReadLines: 5_000,
  maxReadBytes: 1024 * 1024,
  heartbeatMs: 5_000,
  leaseMs: 15_000,
  reconnectHistoryFrames: 256,
});

export const TERMINAL_CLIPBOARD_MAX_BYTES = 192 * 1024;
export const TERMINAL_EFFECT_TTL_MS = 30_000;
export const TERMINAL_HANDSHAKE_TIMEOUT_MS = 5_000;
export const TERMINAL_RATE_WINDOW_MS = 1_000;
export const TERMINAL_MAX_MESSAGES_PER_WINDOW = 256;
export const TERMINAL_MAX_BYTES_PER_WINDOW = 1024 * 1024;
