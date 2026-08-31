import { useCallback, useEffect, useRef, useState } from "react";
import type { AttentionItem } from "./attention-items.js";
import { claimNotificationDelivery, playAttentionSound } from "./notification-sound.js";
import type { PortalRoute } from "./router/portal-router.js";

export type AttentionNotificationTier = "urgent" | "standard" | "quiet" | "none";

export interface AttentionToast {
  id: string;
  item: AttentionItem;
  tier: Exclude<AttentionNotificationTier, "none">;
  createdAt: number;
}

interface AttentionNotificationPreferences {
  inApp: boolean;
  desktop: boolean;
  sound: boolean;
  completionNotificationMemberIdsByGroup: Record<string, string[]>;
}

interface UseAttentionNotificationsOptions {
  items: readonly AttentionItem[];
  ready: boolean;
  hydrationKey: string | undefined;
  route: PortalRoute;
  preferences: AttentionNotificationPreferences;
  navigate(path: string): void;
}

const TOAST_LIMIT = 3;
const TOAST_LIFETIME_MS = 8_000;

function completionNotificationsEnabled(
  item: AttentionItem,
  preferences: AttentionNotificationPreferences,
): boolean {
  return (
    item.kind !== "completion" ||
    (preferences.completionNotificationMemberIdsByGroup[item.groupId] ?? []).includes(item.memberId)
  );
}

export function attentionNotificationTier(item: AttentionItem): AttentionNotificationTier {
  switch (item.kind) {
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
    case "unread":
      return "none";
  }
}

export function routeOwnsAttentionItem(route: PortalRoute, item: AttentionItem): boolean {
  if (route.kind === "global") return route.destination === "attention";
  if (route.kind !== "group" || route.groupId !== item.groupId) return false;
  switch (item.kind) {
    case "wait":
    case "action":
      return route.section === "activity";
    case "response":
    case "health":
    case "completion":
      return (
        route.section === "terminals" &&
        (item.runId === undefined ? route.runId === undefined : route.runId === item.runId)
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
  preferences,
  navigate,
}: UseAttentionNotificationsOptions) {
  const [toasts, setToasts] = useState<AttentionToast[]>([]);
  const previousIds = useRef<Set<string>>(new Set());
  const seededHydrationKey = useRef<string | undefined>(undefined);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
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

    const visible = document.visibilityState === "visible";
    if (visible) {
      if (!preferences.inApp) return;
      const createdAt = Date.now();
      const nextToasts = additions.flatMap((item): AttentionToast[] => {
        if (!completionNotificationsEnabled(item, preferences)) return [];
        const tier = attentionNotificationTier(item);
        return tier === "none" || routeOwnsAttentionItem(route, item)
          ? []
          : [{ id: item.id, item, tier, createdAt }];
      });
      if (nextToasts.length > 0) {
        setToasts((current) => {
          const addedIds = new Set(nextToasts.map((toast) => toast.id));
          return [...current.filter((toast) => !addedIds.has(toast.id)), ...nextToasts].slice(
            -TOAST_LIMIT,
          );
        });
      }
      return;
    }

    for (const item of additions) {
      const tier = attentionNotificationTier(item);
      if (
        preferences.desktop &&
        ((item.kind === "completion" && completionNotificationsEnabled(item, preferences)) ||
          tier === "urgent" ||
          tier === "standard")
      ) {
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
    preferences.completionNotificationMemberIdsByGroup,
    preferences.inApp,
    preferences.sound,
    ready,
    route,
  ]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const delay = Math.max(
      0,
      Math.min(...toasts.map((toast) => toast.createdAt + TOAST_LIFETIME_MS)) - Date.now(),
    );
    const timeout = window.setTimeout(() => {
      const now = Date.now();
      setToasts((current) => current.filter((toast) => toast.createdAt + TOAST_LIFETIME_MS > now));
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [toasts]);

  return { toasts, dismissToast, openToast };
}
