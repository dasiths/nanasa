import { Clock3, FolderGit2, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { EventConnectionStatus } from "../hooks/use-portal-snapshot.js";

export function snapshotFreshness(receivedAt: number | undefined, now: number): string {
  if (receivedAt === undefined) return "Awaiting snapshot";
  const seconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
  if (seconds < 5) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.floor(seconds / 60)}m ago`;
}

export function ProjectContext({
  name,
  source,
  connectionStatus,
  receivedAt,
  snapshotFailed = false,
  onOpenStatus,
}: {
  name: string;
  source?: string;
  connectionStatus: EventConnectionStatus;
  receivedAt?: number;
  snapshotFailed?: boolean;
  onOpenStatus(): void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const stale = snapshotFailed || (receivedAt !== undefined && now - receivedAt > 30000);
  const label =
    connectionStatus === "connected" && stale
      ? "Updates stale"
      : connectionStatus === "connected"
        ? "Connected"
        : connectionStatus === "reconnecting"
          ? "Reconnecting"
          : "Disconnected";
  const tone =
    connectionStatus === "disconnected"
      ? "danger"
      : stale || connectionStatus === "reconnecting"
        ? "warning"
        : "ready";
  const Icon = connectionStatus === "disconnected" ? WifiOff : stale ? Clock3 : Wifi;
  return (
    <section className="portal-project-context" aria-label="Project context">
      <div className="portal-project-identity">
        <FolderGit2 className="portal-project-glyph" size={18} aria-hidden="true" />
        <strong className="portal-project-name">Project: {name}</strong>
        {source && (
          <span className="portal-project-source" title={source}>
            {source}
          </span>
        )}
      </div>
      <button
        type="button"
        className={`portal-project-connection connection-${tone}`}
        aria-label={`System ${connectionStatus}, open System status`}
        title="Connection, snapshot freshness, and system details"
        onClick={onOpenStatus}
      >
        <Icon size={13} aria-hidden="true" />
        <span className="portal-connection-name">{label}</span>
        <span className="portal-connection-freshness">{snapshotFreshness(receivedAt, now)}</span>
      </button>
    </section>
  );
}
