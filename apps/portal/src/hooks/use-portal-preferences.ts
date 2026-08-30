import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type TerminalLayout = "tabs" | "grid";
export type WorkspaceSection = "terminals" | "messages" | "activity" | "settings";
export type MotionPreference = "system" | "reduce" | "full";
export type ContrastPreference = "system" | "forced" | "standard";

export interface PortalPreferences {
  version: 2;
  theme: ThemePreference;
  terminalLayout: TerminalLayout;
  selectedGroupId?: string;
  expandedGroupIds: string[];
  lastSectionByGroup: Record<string, WorkspaceSection>;
  activeRunByGroup: Record<string, string>;
  railCollapsed: boolean;
  density: "comfortable" | "compact";
  motion: MotionPreference;
  contrast: ContrastPreference;
  notifications: { inApp: boolean; desktop: boolean; sound: boolean };
  mobileGroupFilter: string;
  seenRelease?: string;
}

export const PORTAL_PREFERENCES_KEY = "nanasa.portal.preferences.v2";

const preferencesEvent = "nanasa:portal-preferences-v2";
export const defaultPortalPreferences: PortalPreferences = {
  version: 2,
  theme: "system",
  terminalLayout: "tabs",
  expandedGroupIds: [],
  lastSectionByGroup: {},
  activeRunByGroup: {},
  railCollapsed: false,
  density: "comfortable",
  motion: "system",
  contrast: "system",
  notifications: { inApp: true, desktop: false, sound: false },
  mobileGroupFilter: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord<T extends string>(value: unknown, allowed?: readonly T[]): Record<string, T> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, T] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        (allowed === undefined || allowed.includes(entry[1] as T)),
    ),
  );
}

export function parsePortalPreferences(value: string | null): PortalPreferences {
  if (value === null) return defaultPortalPreferences;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return defaultPortalPreferences;
    if (parsed.version !== 2) return defaultPortalPreferences;
    const notifications = isRecord(parsed.notifications) ? parsed.notifications : {};
    const theme = ["light", "dark", "system"].includes(String(parsed.theme))
      ? (parsed.theme as ThemePreference)
      : defaultPortalPreferences.theme;
    const terminalLayout = ["tabs", "grid"].includes(String(parsed.terminalLayout))
      ? (parsed.terminalLayout as TerminalLayout)
      : defaultPortalPreferences.terminalLayout;
    return {
      version: 2,
      theme,
      terminalLayout,
      ...(typeof parsed.selectedGroupId === "string" && parsed.selectedGroupId.length > 0
        ? { selectedGroupId: parsed.selectedGroupId }
        : {}),
      expandedGroupIds: Array.isArray(parsed.expandedGroupIds)
        ? [
            ...new Set(
              parsed.expandedGroupIds.filter(
                (item): item is string => typeof item === "string" && item.length > 0,
              ),
            ),
          ]
        : [],
      lastSectionByGroup: stringRecord(parsed.lastSectionByGroup, [
        "terminals",
        "messages",
        "activity",
        "settings",
      ]),
      activeRunByGroup: stringRecord(parsed.activeRunByGroup),
      railCollapsed: parsed.railCollapsed === true,
      density: parsed.density === "compact" ? "compact" : "comfortable",
      motion: ["system", "reduce", "full"].includes(String(parsed.motion))
        ? (parsed.motion as MotionPreference)
        : "system",
      contrast: ["system", "forced", "standard"].includes(String(parsed.contrast))
        ? (parsed.contrast as ContrastPreference)
        : "system",
      notifications: {
        inApp: notifications.inApp !== false,
        desktop: notifications.desktop === true,
        sound: notifications.sound === true,
      },
      mobileGroupFilter:
        typeof parsed.mobileGroupFilter === "string" ? parsed.mobileGroupFilter.slice(0, 100) : "",
      ...(typeof parsed.seenRelease === "string" && parsed.seenRelease.length > 0
        ? { seenRelease: parsed.seenRelease.slice(0, 100) }
        : {}),
    };
  } catch {
    return defaultPortalPreferences;
  }
}

function readPreferences(): PortalPreferences {
  try {
    return parsePortalPreferences(window.localStorage.getItem(PORTAL_PREFERENCES_KEY));
  } catch {
    return defaultPortalPreferences;
  }
}

function publishPreferences(preferences: PortalPreferences): void {
  try {
    window.localStorage.setItem(PORTAL_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences remain usable for this tab when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(preferencesEvent, { detail: preferences }));
}

export function cleanStalePortalPreferences(
  preferences: PortalPreferences,
  groups: ReadonlyMap<string, ReadonlySet<string>>,
): PortalPreferences {
  const groupIds = new Set(groups.keys());
  const selectedGroupId =
    preferences.selectedGroupId !== undefined && groupIds.has(preferences.selectedGroupId)
      ? preferences.selectedGroupId
      : undefined;
  const next = {
    ...preferences,
    expandedGroupIds: preferences.expandedGroupIds.filter((groupId) => groupIds.has(groupId)),
    lastSectionByGroup: Object.fromEntries(
      Object.entries(preferences.lastSectionByGroup).filter(([groupId]) => groupIds.has(groupId)),
    ),
    activeRunByGroup: Object.fromEntries(
      Object.entries(preferences.activeRunByGroup).filter(
        ([groupId, runId]) => groups.get(groupId)?.has(runId) === true,
      ),
    ),
  };
  if (selectedGroupId === undefined) delete next.selectedGroupId;
  else next.selectedGroupId = selectedGroupId;
  return JSON.stringify(next) === JSON.stringify(preferences) ? preferences : next;
}

function resolveTheme(preference: ThemePreference): "light" | "dark" {
  return preference === "system"
    ? typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : preference;
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function initializePortalTheme(): void {
  applyTheme(resolveTheme(readPreferences().theme));
}

export function usePortalPreferences() {
  const [preferences, setPreferences] = useState<PortalPreferences>(readPreferences);

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (event.key === PORTAL_PREFERENCES_KEY)
        setPreferences(parsePortalPreferences(event.newValue));
    };
    const synchronizeCurrentTab = (event: Event) =>
      setPreferences((event as CustomEvent<PortalPreferences>).detail);
    window.addEventListener("storage", synchronize);
    window.addEventListener(preferencesEvent, synchronizeCurrentTab);
    return () => {
      window.removeEventListener("storage", synchronize);
      window.removeEventListener(preferencesEvent, synchronizeCurrentTab);
    };
  }, []);

  const updatePreferences = useCallback(
    (update: (current: PortalPreferences) => PortalPreferences) => {
      setPreferences((current) => {
        const updated = update(current);
        if (updated !== current) publishPreferences(updated);
        return updated;
      });
    },
    [],
  );
  const patchPreferences = useCallback(
    (next: Partial<PortalPreferences>) =>
      updatePreferences((current) => ({ ...current, ...next, version: 2 })),
    [updatePreferences],
  );
  const reconcileResources = useCallback(
    (groups: ReadonlyMap<string, ReadonlySet<string>>) =>
      updatePreferences((current) => cleanStalePortalPreferences(current, groups)),
    [updatePreferences],
  );
  const setSelectedGroup = useCallback(
    (selectedGroupId: string, section?: WorkspaceSection) =>
      updatePreferences((current) => ({
        ...current,
        selectedGroupId,
        lastSectionByGroup:
          section === undefined
            ? current.lastSectionByGroup
            : { ...current.lastSectionByGroup, [selectedGroupId]: section },
      })),
    [updatePreferences],
  );
  const setActiveRun = useCallback(
    (groupId: string, runId: string) =>
      updatePreferences((current) => ({
        ...current,
        activeRunByGroup: { ...current.activeRunByGroup, [groupId]: runId },
      })),
    [updatePreferences],
  );

  return {
    preferences,
    updatePreferences,
    reconcileResources,
    setTheme: (theme: ThemePreference) => patchPreferences({ theme }),
    setTerminalLayout: (terminalLayout: TerminalLayout) => patchPreferences({ terminalLayout }),
    setSelectedGroup,
    setActiveRun,
    patchPreferences,
  };
}

export function useAppliedTheme(preference: ThemePreference): "light" | "dark" {
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const synchronize = (event: MediaQueryListEvent) =>
      setSystemTheme(event.matches ? "dark" : "light");
    media.addEventListener("change", synchronize);
    return () => media.removeEventListener("change", synchronize);
  }, []);

  const resolved = preference === "system" ? systemTheme : preference;
  useEffect(() => applyTheme(resolved), [resolved]);
  return resolved;
}
