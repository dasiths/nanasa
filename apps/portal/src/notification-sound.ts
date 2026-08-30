const SOUND_DEDUPE_KEY = "nanasa.portal.attention-sound.v1";
const SOUND_DEDUPE_MS = 5_000;

interface AttentionSoundRequest {
  enabled: boolean;
  eventId: string;
}

function eventDigest(value: string): string {
  let digest = 2_166_136_261;
  for (const character of value.slice(0, 4_096)) {
    digest ^= character.codePointAt(0) ?? 0;
    digest = Math.imul(digest, 16_777_619);
  }
  return (digest >>> 0).toString(16).padStart(8, "0");
}

function claimEvent(eventId: string): boolean {
  const now = Date.now();
  const digest = eventDigest(eventId);
  try {
    const previous = JSON.parse(window.localStorage.getItem(SOUND_DEDUPE_KEY) ?? "null") as {
      eventDigest?: string;
      expiresAt?: number;
    } | null;
    if (
      previous?.eventDigest === digest &&
      typeof previous.expiresAt === "number" &&
      previous.expiresAt > now
    ) {
      return false;
    }
    const candidate = { eventDigest: digest, expiresAt: now + SOUND_DEDUPE_MS };
    window.localStorage.setItem(SOUND_DEDUPE_KEY, JSON.stringify(candidate));
    return window.localStorage.getItem(SOUND_DEDUPE_KEY) === JSON.stringify(candidate);
  } catch {
    return false;
  }
}

async function claimBrowserLocalEvent(eventId: string): Promise<boolean> {
  if (navigator.locks === undefined) return false;
  return navigator.locks.request("nanasa-attention-sound", { mode: "exclusive" }, () =>
    claimEvent(eventId),
  );
}

export async function playAttentionSound(request: AttentionSoundRequest): Promise<boolean> {
  if (
    request.enabled !== true ||
    request.eventId.length === 0 ||
    navigator.userActivation?.hasBeenActive !== true ||
    typeof window.AudioContext !== "function" ||
    !(await claimBrowserLocalEvent(request.eventId))
  ) {
    return false;
  }
  try {
    const context = new window.AudioContext();
    const play = () => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(context.currentTime);
      oscillator.stop(context.currentTime + 0.18);
      oscillator.addEventListener("ended", () => void context.close(), { once: true });
    };
    if (context.state === "suspended") {
      void context.resume().then(play, () => context.close());
    } else {
      play();
    }
    return true;
  } catch {
    return false;
  }
}
