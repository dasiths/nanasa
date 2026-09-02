const NOTIFICATION_CLAIMS_KEY = "nanasa.portal.notification-claims.v1";
const NOTIFICATION_CLAIM_MS = 24 * 60 * 60 * 1_000;
const NOTIFICATION_CLAIM_LIMIT = 512;

interface AttentionSoundRequest {
  enabled: boolean;
  eventId: string;
}

export type NotificationDeliveryClaim = "claimed" | "duplicate" | "unavailable";

function eventDigest(value: string): string {
  let digest = 2_166_136_261;
  for (const character of value.slice(0, 4_096)) {
    digest ^= character.codePointAt(0) ?? 0;
    digest = Math.imul(digest, 16_777_619);
  }
  return (digest >>> 0).toString(16).padStart(8, "0");
}

interface NotificationClaim {
  key: string;
  expiresAt: number;
}

function storedClaims(value: string | null, now: number): NotificationClaim[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (claim): claim is NotificationClaim =>
        typeof claim === "object" &&
        claim !== null &&
        typeof (claim as NotificationClaim).key === "string" &&
        typeof (claim as NotificationClaim).expiresAt === "number" &&
        (claim as NotificationClaim).expiresAt > now,
    );
  } catch {
    return [];
  }
}

function claimEvent(channel: "desktop" | "sound", eventId: string): NotificationDeliveryClaim {
  const now = Date.now();
  const key = eventDigest(`${channel}:${eventId}`);
  try {
    const claims = storedClaims(window.localStorage.getItem(NOTIFICATION_CLAIMS_KEY), now);
    if (claims.some((claim) => claim.key === key)) return "duplicate";
    const candidate = [
      { key, expiresAt: now + NOTIFICATION_CLAIM_MS },
      ...claims.sort((left, right) => right.expiresAt - left.expiresAt),
    ].slice(0, NOTIFICATION_CLAIM_LIMIT);
    const serialized = JSON.stringify(candidate);
    window.localStorage.setItem(NOTIFICATION_CLAIMS_KEY, serialized);
    return window.localStorage.getItem(NOTIFICATION_CLAIMS_KEY) === serialized
      ? "claimed"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function claimNotificationDelivery(
  channel: "desktop" | "sound",
  eventId: string,
): Promise<NotificationDeliveryClaim> {
  try {
    if (navigator.locks === undefined) return "unavailable";
    return await navigator.locks.request(
      "nanasa-notification-delivery",
      { mode: "exclusive" },
      () => claimEvent(channel, eventId),
    );
  } catch {
    return "unavailable";
  }
}

export async function playAttentionSound(request: AttentionSoundRequest): Promise<boolean> {
  if (
    request.enabled !== true ||
    request.eventId.length === 0 ||
    navigator.userActivation?.hasBeenActive !== true ||
    typeof window.AudioContext !== "function" ||
    (await claimNotificationDelivery("sound", request.eventId)) !== "claimed"
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
