import { useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type TerminalLayout = "tabs" | "grid";

export interface PortalPreferences {
  theme: ThemePreference;
  terminalLayout: TerminalLayout;
}

export const PORTAL_PREFERENCES_KEY = "nanasa.portal.preferences.v1";

const preferencesEvent = "nanasa:portal-preferences";
const defaultPreferences: PortalPreferences = {
  theme: "system",
  terminalLayout: "tabs",
};

function parsePreferences(value: string | null): PortalPreferences {
  if (value === null) return defaultPreferences;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return defaultPreferences;
    const record = parsed as Record<string, unknown>;
    return {
      theme:
        record.theme === "light" || record.theme === "dark" || record.theme === "system"
          ? record.theme
          : defaultPreferences.theme,
      terminalLayout:
        record.terminalLayout === "tabs" || record.terminalLayout === "grid"
          ? record.terminalLayout
          : defaultPreferences.terminalLayout,
    };
  } catch {
    return defaultPreferences;
  }
}

function readPreferences(): PortalPreferences {
  try {
    return parsePreferences(window.localStorage.getItem(PORTAL_PREFERENCES_KEY));
  } catch {
    return defaultPreferences;
  }
}

function persistPreferences(preferences: PortalPreferences): void {
  try {
    window.localStorage.setItem(PORTAL_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences remain usable for this tab when storage is unavailable.
  }
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
      if (event.key === PORTAL_PREFERENCES_KEY) setPreferences(parsePreferences(event.newValue));
    };
    const synchronizeCurrentTab = (event: Event) => {
      setPreferences((event as CustomEvent<PortalPreferences>).detail);
    };
    window.addEventListener("storage", synchronize);
    window.addEventListener(preferencesEvent, synchronizeCurrentTab);
    return () => {
      window.removeEventListener("storage", synchronize);
      window.removeEventListener(preferencesEvent, synchronizeCurrentTab);
    };
  }, []);

  const updatePreferences = (next: Partial<PortalPreferences>) => {
    const updated = { ...preferences, ...next };
    setPreferences(updated);
    persistPreferences(updated);
    window.dispatchEvent(new CustomEvent(preferencesEvent, { detail: updated }));
  };

  return {
    preferences,
    setTheme: (theme: ThemePreference) => updatePreferences({ theme }),
    setTerminalLayout: (terminalLayout: TerminalLayout) => updatePreferences({ terminalLayout }),
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
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);
  return resolved;
}
