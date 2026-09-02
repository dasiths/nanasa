import { type MouseEvent, useCallback, useEffect, useState } from "react";
import type { WorkspaceSection } from "../hooks/use-portal-preferences.js";
import {
  type GlobalDestination,
  globalDestinations,
  groupDestinations,
} from "./portal-destinations.js";

export { type GlobalDestination, globalDestinations } from "./portal-destinations.js";

export type PortalRoute =
  | { kind: "home" }
  | { kind: "group"; groupId: string; section: WorkspaceSection; runId?: string }
  | { kind: "global"; destination: GlobalDestination }
  | { kind: "invalid"; path: string };

const workspaceSections: readonly WorkspaceSection[] = groupDestinations.map(({ id }) => id);

export function parsePortalRoute(pathname: string): PortalRoute {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 0) return { kind: "home" };
  if (segments[0] === "groups" && segments[1] !== undefined) {
    const section = segments[2] ?? "terminals";
    if (!workspaceSections.includes(section as WorkspaceSection)) {
      return { kind: "invalid", path: pathname };
    }
    if (segments.length > 4 || (section !== "terminals" && segments.length > 3)) {
      return { kind: "invalid", path: pathname };
    }
    return {
      kind: "group",
      groupId: segments[1],
      section: section as WorkspaceSection,
      ...(section === "terminals" && segments[3] !== undefined ? { runId: segments[3] } : {}),
    };
  }
  if (segments.length === 1 && globalDestinations.includes(segments[0] as GlobalDestination)) {
    return { kind: "global", destination: segments[0] as GlobalDestination };
  }
  return { kind: "invalid", path: pathname };
}

export function groupRoute(
  groupId: string,
  section: WorkspaceSection = "terminals",
  runId?: string,
): string {
  const base = `/groups/${encodeURIComponent(groupId)}/${section}`;
  return runId === undefined || section !== "terminals"
    ? base
    : `${base}/${encodeURIComponent(runId)}`;
}

interface PortalHistoryState {
  nanasa?: { focusKey?: string };
}

function activeFocusKey(): string | undefined {
  const active = document.activeElement;
  return active instanceof HTMLElement
    ? (active.dataset.focusKey ?? active.id ?? undefined)
    : undefined;
}

export function usePortalRouter() {
  const [route, setRoute] = useState<PortalRoute>(() => parsePortalRoute(window.location.pathname));

  const navigate = useCallback((path: string, options: { replace?: boolean } = {}) => {
    const currentState = (window.history.state ?? {}) as PortalHistoryState;
    window.history.replaceState(
      { ...currentState, nanasa: { focusKey: activeFocusKey() } },
      "",
      window.location.href,
    );
    if (options.replace === true) window.history.replaceState({}, "", path);
    else window.history.pushState({}, "", path);
    setRoute(parsePortalRoute(window.location.pathname));
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      setRoute(parsePortalRoute(window.location.pathname));
      const focusKey = (event.state as PortalHistoryState | null)?.nanasa?.focusKey;
      window.setTimeout(() => {
        const target =
          focusKey === undefined
            ? document.querySelector<HTMLElement>("[data-route-heading]")
            : document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`);
        target?.focus();
      }, 50);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const link = useCallback(
    (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      navigate(path);
    },
    [navigate],
  );

  return { route, navigate, link };
}
