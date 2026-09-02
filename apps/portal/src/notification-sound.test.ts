import { afterEach, describe, expect, it, vi } from "vitest";
import { claimNotificationDelivery, playAttentionSound } from "./notification-sound.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("attention notification sound", () => {
  it("bounds channel-qualified claims, expires them, and fails closed without storage", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => boolean) =>
          Promise.resolve(callback()),
      },
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await expect(claimNotificationDelivery("sound", "same-item")).resolves.toBe("claimed");
    await expect(claimNotificationDelivery("sound", "same-item")).resolves.toBe("duplicate");
    await expect(claimNotificationDelivery("desktop", "same-item")).resolves.toBe("claimed");

    for (let index = 0; index < 520; index += 1) {
      await claimNotificationDelivery("sound", `item-${index}`);
    }
    const claims = JSON.parse(
      window.localStorage.getItem("nanasa.portal.notification-claims.v1") ?? "[]",
    ) as unknown[];
    expect(claims).toHaveLength(512);

    now.mockReturnValue(24 * 60 * 60 * 1_000 + 1_001);
    await expect(claimNotificationDelivery("sound", "same-item")).resolves.toBe("claimed");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    await expect(claimNotificationDelivery("sound", "storage-failure")).resolves.toBe(
      "unavailable",
    );
  });

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

  it("suppresses playback when cross-tab claiming is unavailable", async () => {
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { hasBeenActive: true },
    });
    const audio = vi.fn();
    vi.stubGlobal("AudioContext", audio);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: () => Promise.reject(new Error("lock unavailable")) },
    });
    await expect(
      playAttentionSound({ enabled: true, eventId: "attention-lock-error" }),
    ).resolves.toBe(false);
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    await expect(playAttentionSound({ enabled: true, eventId: "attention-no-lock" })).resolves.toBe(
      false,
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => boolean) =>
          Promise.resolve(callback()),
      },
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    await expect(
      playAttentionSound({ enabled: true, eventId: "attention-storage-error" }),
    ).resolves.toBe(false);
    expect(audio).not.toHaveBeenCalled();
  });
});
