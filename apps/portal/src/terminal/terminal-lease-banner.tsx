import type { TerminalRole } from "@nanasa/contracts";

export function TerminalLeaseBanner({
  role,
  state,
  onTakeover,
}: {
  role: TerminalRole;
  state: "connecting" | "connected" | "reconnecting" | "closed";
  onTakeover(): void;
}) {
  return (
    <div className={`terminal-lease-banner terminal-lease-${role}`} role="status">
      <strong>{role === "controller" ? "Controller" : "Observer"}</strong>
      <span>{state}</span>
      {role === "observer" && state === "connected" && (
        <button type="button" onClick={onTakeover}>
          Take control
        </button>
      )}
    </div>
  );
}
