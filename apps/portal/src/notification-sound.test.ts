import { afterEach, describe, expect, it, vi } from "vitest";
import { playAttentionSound } from "./notification-sound.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("attention notification sound", () => {
  it("requires the dedicated sound preference and browser activation", async () => {
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { hasBeenActive: false },
    });
    await expect(playAttentionSound({ enabled: true, eventId: "attention-one" })).resolves.toBe(
      false,
    );
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { hasBeenActive: true },
    });
    await expect(playAttentionSound({ enabled: false, eventId: "attention-one" })).resolves.toBe(
      false,
    );
  });

  it("plays one bounded tone per browser-local event and fails closed when audio throws", async () => {
    const oscillator = {
      type: "sine",
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
    const gain = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
    const context = {
      state: "running",
      currentTime: 1,
      destination: {},
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
      resume: vi.fn(),
      close: vi.fn(),
    };
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { hasBeenActive: true },
    });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => boolean) =>
          Promise.resolve(callback()),
      },
    });
    class WorkingAudioContext {
      public constructor() {
        return context as never;
      }
    }
    vi.stubGlobal("AudioContext", WorkingAudioContext);
    await expect(playAttentionSound({ enabled: true, eventId: "attention-one" })).resolves.toBe(
      true,
    );
    expect(oscillator.frequency.value).toBe(660);
    expect(oscillator.stop).toHaveBeenCalledWith(1.18);
    await expect(playAttentionSound({ enabled: true, eventId: "attention-one" })).resolves.toBe(
      false,
    );
    expect(oscillator.start).toHaveBeenCalledTimes(1);

    class FailingAudioContext {
      public constructor() {
        throw new Error("audio unavailable");
      }
    }
    vi.stubGlobal("AudioContext", FailingAudioContext);
    await expect(playAttentionSound({ enabled: true, eventId: "attention-two" })).resolves.toBe(
      false,
    );
  });

  it("suppresses playback when cross-tab Web Locks are unavailable", async () => {
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { hasBeenActive: true },
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const audio = vi.fn();
    vi.stubGlobal("AudioContext", audio);
    await expect(playAttentionSound({ enabled: true, eventId: "attention-no-lock" })).resolves.toBe(
      false,
    );
    expect(audio).not.toHaveBeenCalled();
  });
});
