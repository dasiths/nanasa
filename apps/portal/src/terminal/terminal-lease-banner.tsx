import type { TerminalRole } from "@nanasa/contracts";
import { Eye, MousePointerClick } from "lucide-react";
import type { ReactNode } from "react";

export function TerminalLeaseBanner({
  role,
  state,
  title,
  identity,
  memberIdentity,
  paneActions,
  actions,
  onTakeover,
  onRelease,
}: {
  role: TerminalRole;
  state: "connecting" | "connected" | "reconnecting" | "closed";
  title: string;
  identity: ReactNode;
  memberIdentity: ReactNode;
  paneActions: ReactNode;
  actions: ReactNode;
  onTakeover(): void;
  onRelease(): void;
}) {
  return (
    <div className={`terminal-statusbar terminal-lease-banner terminal-lease-${role}`}>
      <div className="terminal-header-identity">{identity}</div>
      <span className="status-separator" aria-hidden="true" />
      <div className="terminal-lease-status" role="status">
        <strong>{role === "controller" ? "Control mode" : "Observe mode"}</strong>
        <span>{state}</span>
      </div>
      {title.length > 0 && (
        <span className="terminal-window-title" title={title}>
          {title}
        </span>
      )}
      <span className="terminal-header-spacer" />
      {memberIdentity}
      <div className="terminal-banner-actions">
        {role === "controller" && state === "connected" ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Observe"
            title="Switch to Observe mode"
            onClick={onRelease}
          >
            <Eye aria-hidden="true" size={15} />
          </button>
        ) : role === "observer" && state === "connected" ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Take control"
            title="Take control of terminal"
            onClick={onTakeover}
          >
            <MousePointerClick aria-hidden="true" size={15} />
          </button>
        ) : null}
        {paneActions}
        {actions}
      </div>
    </div>
  );
}
