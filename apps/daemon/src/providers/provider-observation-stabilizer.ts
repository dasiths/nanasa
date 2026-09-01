export type ProviderScreenState = "idle" | "working" | "blocked" | "unknown";

export interface ProviderScreenSignal {
  readonly state: ProviderScreenState;
  readonly visibleIdle: boolean;
  readonly visibleWorking: boolean;
  readonly visibleBlocker: boolean;
}

export interface StabilizedScreenDecision {
  readonly publish: boolean;
  readonly signal: ProviderScreenSignal;
  readonly reason:
    | "startup-grace"
    | "idle-confirmation"
    | "idle-confirmed"
    | "idle-cap"
    | "changed"
    | "unchanged";
}

const STARTUP_GRACE_MS = 3_000;
const IDLE_CONFIRMATION_INTERVAL_MS = 100;
const IDLE_CONFIRMATIONS = 3;
const IDLE_CONFIRMATION_CAP_MS = 700;

export class ProviderScreenStabilizer {
  #processStartedAt = 0;
  #published: ProviderScreenSignal = {
    state: "unknown",
    visibleIdle: false,
    visibleWorking: false,
    visibleBlocker: false,
  };
  #pendingIdleStartedAt: number | undefined;
  #lastIdleConfirmationAt: number | undefined;
  #idleConfirmations = 0;

  public resetForProcess(processStartedAt: number): void {
    this.#processStartedAt = processStartedAt;
    this.#published = {
      state: "unknown",
      visibleIdle: false,
      visibleWorking: false,
      visibleBlocker: false,
    };
    this.#clearPendingIdle();
  }

  public observe(signal: ProviderScreenSignal, now: number): StabilizedScreenDecision {
    if (
      now - this.#processStartedAt < STARTUP_GRACE_MS &&
      signal.state !== "working" &&
      signal.state !== "blocked"
    ) {
      this.#clearPendingIdle();
      return { publish: false, signal: this.#published, reason: "startup-grace" };
    }
    const plainIdle =
      this.#published.state === "working" &&
      signal.state === "idle" &&
      !signal.visibleIdle &&
      !signal.visibleBlocker;
    if (plainIdle) {
      if (this.#pendingIdleStartedAt === undefined) {
        this.#pendingIdleStartedAt = now;
        this.#lastIdleConfirmationAt = now;
        this.#idleConfirmations = 1;
        return { publish: false, signal: this.#published, reason: "idle-confirmation" };
      }
      if (now - this.#pendingIdleStartedAt >= IDLE_CONFIRMATION_CAP_MS) {
        this.#published = signal;
        this.#clearPendingIdle();
        return { publish: true, signal, reason: "idle-cap" };
      }
      if (now - (this.#lastIdleConfirmationAt ?? 0) < IDLE_CONFIRMATION_INTERVAL_MS) {
        return { publish: false, signal: this.#published, reason: "idle-confirmation" };
      }
      this.#lastIdleConfirmationAt = now;
      this.#idleConfirmations += 1;
      if (this.#idleConfirmations < IDLE_CONFIRMATIONS) {
        return { publish: false, signal: this.#published, reason: "idle-confirmation" };
      }
      this.#published = signal;
      this.#clearPendingIdle();
      return { publish: true, signal, reason: "idle-confirmed" };
    }
    this.#clearPendingIdle();
    const changed =
      this.#published.state !== signal.state ||
      this.#published.visibleIdle !== signal.visibleIdle ||
      this.#published.visibleWorking !== signal.visibleWorking ||
      this.#published.visibleBlocker !== signal.visibleBlocker;
    if (changed) this.#published = signal;
    return { publish: changed, signal: this.#published, reason: changed ? "changed" : "unchanged" };
  }

  #clearPendingIdle(): void {
    this.#pendingIdleStartedAt = undefined;
    this.#lastIdleConfirmationAt = undefined;
    this.#idleConfirmations = 0;
  }
}

export interface ProviderCaptureToken {
  readonly key: string;
  readonly dirtySequence: number;
  readonly fenceDigest: string;
}

export class ProviderDirtySequence {
  readonly #sequences = new Map<string, number>();

  public markDirty(key: string): number {
    const next = (this.#sequences.get(key) ?? 0) + 1;
    this.#sequences.set(key, next);
    return next;
  }

  public beginCapture(key: string, fenceDigest: string): ProviderCaptureToken {
    return Object.freeze({
      key,
      dirtySequence: this.#sequences.get(key) ?? 0,
      fenceDigest,
    });
  }

  public accepts(token: ProviderCaptureToken, currentFenceDigest: string): boolean {
    return (
      token.fenceDigest === currentFenceDigest &&
      token.dirtySequence === (this.#sequences.get(token.key) ?? 0)
    );
  }

  public clear(key: string): void {
    this.#sequences.delete(key);
  }
}
