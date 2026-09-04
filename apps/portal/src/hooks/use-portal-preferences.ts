import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type TerminalColumnsPreference = "auto" | 1 | 2 | 3;
export type WorkspaceSection = "terminals" | "messages" | "activity";
export type MotionPreference = "system" | "reduce" | "full";
export type ContrastPreference = "system" | "forced" | "standard";

export interface PortalPreferences {
  version: 2;
  theme: ThemePreference;
  selectedGroupId?: string;
  expandedGroupIds: string[];
  lastSectionByGroup: Record<string, WorkspaceSection>;
  activeRunByGroup: Record<string, string>;
  pinnedRunIdsByGroup: Record<string, string[]>;
  terminalColumnsByGroup: Record<string, TerminalColumnsPreference>;
  dismissedProviderUpdateIds: string[];
  railCollapsed: boolean;
  density: "comfortable" | "compact";
  motion: MotionPreference;
  contrast: ContrastPreference;
  notifications: { desktop: boolean; sound: boolean };
  mobileGroupFilter: string;
  seenRelease?: string;
}

export const PORTAL_PREFERENCES_KEY = "nanasa.portal.preferences.v2";

const preferencesEvent = "nanasa:portal-preferences-v2";
export const defaultPortalPreferences: PortalPreferences = {
  version: 2,
  theme: "system",
  expandedGroupIds: [],
  lastSectionByGroup: {},
  activeRunByGroup: {},
  pinnedRunIdsByGroup: {},
  terminalColumnsByGroup: {},
  dismissedProviderUpdateIds: [],
  railCollapsed: false,
  density: "comfortable",
  motion: "system",
  contrast: "system",
  notifications: { desktop: false, sound: false },
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

function stringArrayRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (!Array.isArray(item)) return [];
      return [
        [
          key,
          [
            ...new Set(
              item.filter(
                (entry): entry is string => typeof entry === "string" && entry.length > 0,
              ),
            ),
          ],
        ],
      ];
    }),
  );
}

function terminalColumnsRecord(value: unknown): Record<string, TerminalColumnsPreference> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, TerminalColumnsPreference] =>
        entry[0].length > 0 &&
        (entry[1] === "auto" || entry[1] === 1 || entry[1] === 2 || entry[1] === 3),
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
    return {
      version: 2,
      theme,
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
      ]),
      activeRunByGroup: stringRecord(parsed.activeRunByGroup),
      pinnedRunIdsByGroup: stringArrayRecord(parsed.pinnedRunIdsByGroup),
      terminalColumnsByGroup: terminalColumnsRecord(parsed.terminalColumnsByGroup),
      dismissedProviderUpdateIds: Array.isArray(parsed.dismissedProviderUpdateIds)
        ? [
            ...new Set(
              parsed.dismissedProviderUpdateIds.filter(
                (item): item is string => typeof item === "string" && item.length > 0,
              ),
            ),
          ].slice(-100)
        : [],
      railCollapsed: parsed.railCollapsed === true,
      density: parsed.density === "compact" ? "compact" : "comfortable",
      motion: ["system", "reduce", "full"].includes(String(parsed.motion))
        ? (parsed.motion as MotionPreference)
        : "system",
      contrast: ["system", "forced", "standard"].includes(String(parsed.contrast))
        ? (parsed.contrast as ContrastPreference)
        : "system",
      notifications: {
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

let localPreferenceQueue: Promise<void> = Promise.resolve();

export function commitPortalPreferenceUpdate(
  update: (current: PortalPreferences) => PortalPreferences,
): Promise<PortalPreferences> {
  const commit = () => {
    const current = readPreferences();
    const updated = update(current);
    if (updated !== current) publishPreferences(updated);
    return updated;
  };
  if (navigator.locks !== undefined) {
    return navigator.locks.request("nanasa-portal-preferences-v2", { mode: "exclusive" }, commit);
  }
  const result = localPreferenceQueue.then(commit, commit);
  localPreferenceQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const RESOURCE_RECORD_FIELDS = [
  "lastSectionByGroup",
  "activeRunByGroup",
  "pinnedRunIdsByGroup",
  "terminalColumnsByGroup",
] as const;

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergePortalPreferenceUpdate(
  current: PortalPreferences,
  updated: PortalPreferences,
  stored: PortalPreferences,
): PortalPreferences {
  const merged: PortalPreferences = { ...stored, version: 2 };
  for (const key of Object.keys(updated) as Array<keyof PortalPreferences>) {
    if (
      key === "version" ||
      key === "notifications" ||
      RESOURCE_RECORD_FIELDS.includes(key as (typeof RESOURCE_RECORD_FIELDS)[number])
    ) {
      continue;
    }
    if (!equal(current[key], updated[key])) {
      Object.assign(merged, { [key]: updated[key] });
      if (updated[key] === undefined) delete (merged as unknown as Record<string, unknown>)[key];
    }
  }
  for (const field of RESOURCE_RECORD_FIELDS) {
    const currentRecord = current[field] as Record<string, unknown>;
    const updatedRecord = updated[field] as Record<string, unknown>;
    const mergedRecord = { ...(stored[field] as Record<string, unknown>) };
    for (const resourceId of new Set([
      ...Object.keys(currentRecord),
      ...Object.keys(updatedRecord),
    ])) {
      if (equal(currentRecord[resourceId], updatedRecord[resourceId])) continue;
      if (field === "pinnedRunIdsByGroup") {
        const before = (currentRecord[resourceId] ?? []) as string[];
        const after = (updatedRecord[resourceId] ?? []) as string[];
        const latest = (mergedRecord[resourceId] ?? []) as string[];
        const removals = new Set(before.filter((runId) => !after.includes(runId)));
        const additions = after.filter((runId) => !before.includes(runId));
        const next = latest.filter((runId) => !removals.has(runId));
        for (const runId of additions) if (!next.includes(runId)) next.push(runId);
        if (next.length === 0 && updatedRecord[resourceId] === undefined) {
          delete mergedRecord[resourceId];
        } else {
          mergedRecord[resourceId] = next;
        }
      } else if (updatedRecord[resourceId] === undefined) {
        if (equal(mergedRecord[resourceId], currentRecord[resourceId])) {
          delete mergedRecord[resourceId];
        }
      } else {
        mergedRecord[resourceId] = updatedRecord[resourceId];
      }
    }
    Object.assign(merged, { [field]: mergedRecord });
  }
  const notifications = { ...stored.notifications };
  for (const field of ["desktop", "sound"] as const) {
    if (current.notifications[field] !== updated.notifications[field]) {
      notifications[field] = updated.notifications[field];
    }
  }
  merged.notifications = notifications;
  return merged;
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
    pinnedRunIdsByGroup: Object.fromEntries(
      Object.entries(preferences.pinnedRunIdsByGroup)
        .filter(([groupId]) => groupIds.has(groupId))
        .map(([groupId, runIds]) => [
          groupId,
          runIds.filter((runId) => groups.get(groupId)?.has(runId) === true),
        ]),
    ),
    terminalColumnsByGroup: Object.fromEntries(
      Object.entries(preferences.terminalColumnsByGroup).filter(([groupId]) =>
        groupIds.has(groupId),
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
      void commitPortalPreferenceUpdate(update).then(setPreferences);
    },
    [],
  );
  const patchPreferences = useCallback(
    (next: Partial<PortalPreferences>) =>
      updatePreferences((current) => ({ ...current, ...next, version: 2 })),
    [updatePreferences],
  );
  const reconcileResources = useCallback(
    (groups: ReadonlyMap<string, ReadonlySet<string>>) => {
      const observed = preferences;
      const cleaned = cleanStalePortalPreferences(observed, groups);
      if (cleaned === observed) return;
      void commitPortalPreferenceUpdate((stored) =>
        mergePortalPreferenceUpdate(observed, cleaned, stored),
      ).then(setPreferences);
    },
    [preferences],
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
  const setTerminalColumns = useCallback(
    (groupId: string, columns: TerminalColumnsPreference) =>
      updatePreferences((current) => ({
        ...current,
        terminalColumnsByGroup: {
          ...current.terminalColumnsByGroup,
          [groupId]: columns,
        },
      })),
    [updatePreferences],
  );

  return {
    preferences,
    updatePreferences,
    reconcileResources,
    setTheme: (theme: ThemePreference) => patchPreferences({ theme }),
    setSelectedGroup,
    setActiveRun,
    setTerminalColumns,
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
