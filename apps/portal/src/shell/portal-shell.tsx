import type { PropsWithChildren, ReactNode } from "react";
import { LiveAnnouncer, RouteAnnouncer, SkipLink } from "../a11y/primitives.js";
import type { AttentionToast } from "../attention-notifications.js";

export function PortalShell({
  rail,
  routeLabel,
  density,
  motion,
  contrast,
  notifications = [],
  onOpenNotification,
  onDismissNotification,
  onPauseNotification,
  onResumeNotification,
  children,
}: PropsWithChildren<{
  rail: ReactNode;
  routeLabel: string;
  density: "comfortable" | "compact";
  motion: "system" | "reduce" | "full";
  contrast: "system" | "forced" | "standard";
  notifications?: readonly AttentionToast[];
  onOpenNotification?(toast: AttentionToast): void;
  onDismissNotification?(id: string): void;
  onPauseNotification?(id: string): void;
  onResumeNotification?(id: string): void;
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
        {notifications.length > 0 && (
          <aside
            className="attention-toast-region"
            aria-label="Attention notifications"
            aria-live="polite"
          >
            {notifications.map((toast) => (
              <article
                className={`attention-toast attention-toast-${toast.tier}`}
                key={toast.id}
                onMouseEnter={() => onPauseNotification?.(toast.id)}
                onMouseLeave={() => onResumeNotification?.(toast.id)}
                onFocus={() => onPauseNotification?.(toast.id)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    onResumeNotification?.(toast.id);
                  }
                }}
              >
                <div>
                  <strong>{toast.item.title}</strong>
                  <span>{toast.item.group.name}</span>
                  <p>{toast.item.summary}</p>
                </div>
                <div className="attention-toast-actions">
                  <button type="button" onClick={() => onOpenNotification?.(toast)}>
                    Open
                  </button>
                  <button type="button" onClick={() => onDismissNotification?.(toast.id)}>
                    Dismiss
                  </button>
                </div>
              </article>
            ))}
          </aside>
        )}
      </main>
    </LiveAnnouncer>
  );
}
