import { useCallback, useEffect, useRef, useState } from "react";
import type { AttentionItem } from "./attention-items.js";
import { claimNotificationDelivery, playAttentionSound } from "./notification-sound.js";
import type { PortalRoute } from "./router/portal-router.js";

export type AttentionNotificationTier = "urgent" | "standard" | "quiet";

export interface AttentionToast {
  id: string;
  item: AttentionItem;
  tier: AttentionNotificationTier;
  createdAt: number;
  remainingMs: number;
  expiresAt?: number | undefined;
}

interface AttentionNotificationPreferences {
  desktop: boolean;
  sound: boolean;
}

interface UseAttentionNotificationsOptions {
  items: readonly AttentionItem[];
  ready: boolean;
  hydrationKey: string | undefined;
  route: PortalRoute;
  visibleTerminalRunIds: ReadonlySet<string>;
  preferences: AttentionNotificationPreferences;
  navigate(path: string): void;
}

interface VisibleTerminalRunOptions {
  route: PortalRoute;
  runIds: readonly string[];
  focusedRunId?: string;
}

const TOAST_LIMIT = 4;
const TOAST_LIFETIME_MS = 5_000;

export function attentionNotificationTier(item: AttentionItem): AttentionNotificationTier {
  switch (item.kind) {
    case "launch-consent":
    case "wait":
    case "response":
      return "urgent";
    case "health":
      return item.healthType === "failed" ? "urgent" : "standard";
    case "delivery":
      return "standard";
    case "completion":
      return "quiet";
    case "action":
    case "provider-update":
    case "unread":
      return "quiet";
  }
}

export function deriveVisibleTerminalRunIds({
  route,
  runIds,
  focusedRunId,
}: VisibleTerminalRunOptions): ReadonlySet<string> {
  if (route.kind !== "group" || route.section !== "terminals" || runIds.length === 0) {
    return new Set();
  }
  const availableRunIds = new Set(runIds);
  if (focusedRunId !== undefined && availableRunIds.has(focusedRunId)) {
    return new Set([focusedRunId]);
  }
  return availableRunIds;
}

export function routeOwnsAttentionItem(
  route: PortalRoute,
  item: AttentionItem,
  visibleTerminalRunIds: ReadonlySet<string>,
): boolean {
  if (route.kind === "global") return route.destination === "attention";
  if (route.kind !== "group" || route.groupId !== item.groupId) return false;
  switch (item.kind) {
    case "launch-consent":
      return route.section === "terminals";
    case "wait":
    case "action":
    case "provider-update":
      return route.section === "activity";
    case "response":
    case "health":
    case "completion":
      return (
        route.section === "terminals" &&
        item.runId !== undefined &&
        visibleTerminalRunIds.has(item.runId)
      );
    case "delivery":
    case "unread":
      return route.section === "messages";
  }
}

function notificationTag(itemId: string): string {
  let digest = 2_166_136_261;
  for (const character of itemId.slice(0, 4_096)) {
    digest ^= character.codePointAt(0) ?? 0;
    digest = Math.imul(digest, 16_777_619);
  }
  return `nanasa-attention-${(digest >>> 0).toString(16).padStart(8, "0")}`;
}

export async function deliverAttentionDesktopNotification(
  item: AttentionItem,
  navigate: (path: string) => void,
): Promise<boolean> {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return false;
  }
  const claim = await claimNotificationDelivery("desktop", item.id);
  if (claim === "duplicate") return false;
  try {
    const notification = new Notification(item.title, {
      body: `${item.group.name} · ${item.summary}`,
      tag: notificationTag(item.id),
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      navigate(item.targetPath);
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

export function useAttentionNotifications({
  items,
  ready,
  hydrationKey,
  route,
  visibleTerminalRunIds,
  preferences,
  navigate,
}: UseAttentionNotificationsOptions) {
  const [toasts, setToasts] = useState<AttentionToast[]>([]);
  const previousIds = useRef<Set<string>>(new Set());
  const seededHydrationKey = useRef<string | undefined>(undefined);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pauseToast = useCallback((id: string) => {
    const now = Date.now();
    setToasts((current) =>
      current.map((toast) =>
        toast.id !== id || toast.expiresAt === undefined
          ? toast
          : {
              ...toast,
              remainingMs: Math.max(0, toast.expiresAt - now),
              expiresAt: undefined,
            },
      ),
    );
  }, []);

  const resumeToast = useCallback((id: string) => {
    const now = Date.now();
    setToasts((current) =>
      current.map((toast) =>
        toast.id !== id || toast.expiresAt !== undefined
          ? toast
          : { ...toast, expiresAt: now + toast.remainingMs },
      ),
    );
  }, []);

  const openToast = useCallback(
    (toast: AttentionToast) => {
      dismissToast(toast.id);
      navigate(toast.item.targetPath);
    },
    [dismissToast, navigate],
  );

  useEffect(() => {
    if (!ready || hydrationKey === undefined) return;
    const currentIds = new Set(items.map((item) => item.id));
    if (seededHydrationKey.current !== hydrationKey) {
      seededHydrationKey.current = hydrationKey;
      previousIds.current = currentIds;
      setToasts([]);
      return;
    }

    const additions = items.filter((item) => !previousIds.current.has(item.id));
    previousIds.current = new Set([...previousIds.current, ...currentIds]);
    if (additions.length === 0) return;

    const createdAt = Date.now();
    const nextToasts = additions.map((item): AttentionToast => {
      const tier = attentionNotificationTier(item);
      return {
        id: item.id,
        item,
        tier,
        createdAt,
        remainingMs: TOAST_LIFETIME_MS,
        expiresAt: createdAt + TOAST_LIFETIME_MS,
      };
    });
    if (nextToasts.length > 0) {
      setToasts((current) => {
        const addedIds = new Set(nextToasts.map((toast) => toast.id));
        return [...nextToasts, ...current.filter((toast) => !addedIds.has(toast.id))].slice(
          0,
          TOAST_LIMIT,
        );
      });
    }

    const portalInForeground =
      document.visibilityState === "visible" &&
      (typeof document.hasFocus !== "function" || document.hasFocus());
    for (const item of portalInForeground ? [] : additions) {
      const tier = attentionNotificationTier(item);
      if (preferences.desktop) {
        void deliverAttentionDesktopNotification(item, navigate);
      }
      if (item.kind !== "completion" && tier === "urgent" && preferences.sound) {
        void playAttentionSound({ enabled: true, eventId: item.id });
      }
    }
  }, [
    hydrationKey,
    items,
    navigate,
    preferences.desktop,
    preferences.sound,
    ready,
    route,
    visibleTerminalRunIds,
  ]);

  useEffect(() => {
    const active = toasts.flatMap((toast) =>
      toast.expiresAt === undefined ? [] : [toast.expiresAt],
    );
    if (active.length === 0) return;
    const delay = Math.max(0, Math.min(...active) - Date.now());
    const timeout = window.setTimeout(() => {
      const now = Date.now();
      setToasts((current) =>
        current.filter((toast) => toast.expiresAt === undefined || toast.expiresAt > now),
      );
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [toasts]);

  return { toasts, dismissToast, openToast, pauseToast, resumeToast };
}
