import type { PropsWithChildren, ReactNode } from "react";
import { LiveAnnouncer, RouteAnnouncer, SkipLink } from "../a11y/primitives.js";

export function PortalShell({
  rail,
  routeLabel,
  density,
  motion,
  contrast,
  children,
}: PropsWithChildren<{
  rail: ReactNode;
  routeLabel: string;
  density: "comfortable" | "compact";
  motion: "system" | "reduce" | "full";
  contrast: "system" | "forced" | "standard";
}>) {
  return (
    <LiveAnnouncer>
      <SkipLink />
      <main
        className="portal-shell"
        data-density={density}
        data-motion={motion}
        data-contrast={contrast}
      >
        {rail}
        <section id="portal-content" className="workspace" tabIndex={-1}>
          <RouteAnnouncer label={routeLabel} />
          {children}
        </section>
      </main>
    </LiveAnnouncer>
  );
}
