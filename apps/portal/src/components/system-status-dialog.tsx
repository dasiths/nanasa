import type {
  ConfigStatus,
  NanasaConfig,
  PortalSnapshot,
  RemoteDescriptor,
  ServiceDescriptor,
} from "@nanasa/contracts";
import { Check, Copy, FileCheck2, RefreshCw, Server, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "../a11y/primitives.js";
import type { PortalClient } from "../api.js";
import { copyToClipboard } from "../copy-to-clipboard.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";

interface SystemStatus {
  config: ConfigStatus;
  service: ServiceDescriptor;
  remote: RemoteDescriptor;
}

export function SystemStatusDialog({
  open,
  client,
  snapshot,
  config,
  connectionStatus,
  onClose,
}: {
  open: boolean;
  client: PortalClient;
  snapshot: PortalSnapshot;
  config: NanasaConfig;
  connectionStatus: "connected" | "reconnecting" | "disconnected";
  onClose(): void;
}) {
  const [status, setStatus] = useState<SystemStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PortalError>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    setCopied(false);
    void Promise.all([
      client.loadConfigStatus(),
      client.loadServiceStatus(),
      client.loadRemoteStatus(),
    ]).then(
      ([nextConfig, service, remote]) => {
        if (!active) return;
        setStatus({ config: nextConfig, service, remote });
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(toPortalError(cause, "Unable to load System status"));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [client, open]);

  const copyDiagnostics = async () => {
    if (status === undefined) return;
    await copyToClipboard(
      [
        `Nanasa ${status.remote.build.packageVersion}`,
        `daemon epoch ${snapshot.daemonEpoch}, sequence ${snapshot.sequence}`,
        `configuration ${status.config.state}`,
        `service ${status.service.state}`,
        `endpoint ${status.remote.loopbackHost}:${status.remote.port}`,
      ].join("; "),
    );
    setCopied(true);
  };
  const hasIssue =
    status !== undefined &&
    (status.config.state !== "ready" ||
      status.service.state === "failed" ||
      connectionStatus === "disconnected");
  const healthState = hasIssue
    ? "issue"
    : connectionStatus === "reconnecting"
      ? "reconnecting"
      : "healthy";

  return (
    <Dialog
      open={open}
      labelledBy="system-status-title"
      onClose={onClose}
      closeOnBackdrop
      className="system-status-dialog"
    >
      <div className="system-status-dialog-body">
        <header className="system-status-heading">
          <div>
            <span className="eyebrow">Repository</span>
            <h2 id="system-status-title">System status</h2>
            <p>Only conditions that require an operator response appear as alerts.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close System status"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        <div className="system-status-content">
          {loading && (
            <p className="system-status-loading" role="status">
              <RefreshCw className="spin" aria-hidden="true" size={15} /> Loading status
            </p>
          )}
          {error !== undefined && <ErrorNotice error={error} className="route-error" />}
          {status !== undefined && !loading && (
            <>
              <div className={`system-status-clear system-status-${healthState}`}>
                {healthState === "issue" ? (
                  <X aria-hidden="true" size={18} />
                ) : healthState === "reconnecting" ? (
                  <RefreshCw aria-hidden="true" size={18} />
                ) : (
                  <Check aria-hidden="true" size={18} />
                )}
                <div>
                  <strong>
                    {healthState === "issue"
                      ? "Review required"
                      : healthState === "reconnecting"
                        ? "Reconnecting"
                        : "No action needed"}
                  </strong>
                  <span>
                    {healthState === "issue"
                      ? "One or more repository systems need attention."
                      : healthState === "reconnecting"
                        ? "The portal is restoring its event connection."
                        : "Nanasa is ready for repository operations."}
                  </span>
                </div>
              </div>
              <dl className="system-status-list">
                <div>
                  <Server aria-hidden="true" size={16} />
                  <dt>Daemon</dt>
                  <dd>Connected · {status.remote.build.packageVersion}</dd>
                  <span>Ready</span>
                </div>
                <div>
                  <FileCheck2 aria-hidden="true" size={16} />
                  <dt>Configuration</dt>
                  <dd>
                    {status.config.state === "ready"
                      ? "Loaded successfully · no diagnostics"
                      : `${status.config.diagnostics.length} diagnostics`}
                  </dd>
                  <span
                    className={status.config.state === "ready" ? undefined : "system-status-review"}
                  >
                    {status.config.state === "ready" ? "Valid" : "Review"}
                  </span>
                </div>
                <div>
                  <ShieldCheck aria-hidden="true" size={16} />
                  <dt>Connection</dt>
                  <dd>
                    {connectionStatus === "disconnected"
                      ? "Portal event stream disconnected"
                      : connectionStatus === "reconnecting"
                        ? "Portal event stream reconnecting"
                        : "Loopback protected · protocols compatible"}
                  </dd>
                  <span
                    className={
                      connectionStatus === "disconnected"
                        ? "system-status-review"
                        : connectionStatus === "reconnecting"
                          ? "system-status-warning"
                          : undefined
                    }
                  >
                    {connectionStatus === "disconnected"
                      ? "Review"
                      : connectionStatus === "reconnecting"
                        ? "Retrying"
                        : "Secure"}
                  </span>
                </div>
                <div className="system-status-neutral">
                  <RefreshCw aria-hidden="true" size={16} />
                  <dt>Automatic recovery</dt>
                  <dd>
                    {status.service.state === "not-installed"
                      ? "Not installed · optional for this session"
                      : status.service.detail}
                  </dd>
                  <span
                    className={
                      status.service.state === "failed" ? "system-status-review" : undefined
                    }
                  >
                    {status.service.state === "not-installed" ? "Manual" : status.service.state}
                  </span>
                </div>
              </dl>
              <details className="system-technical-details">
                <summary>Technical details</summary>
                <dl>
                  <div>
                    <dt>Configuration</dt>
                    <dd>
                      <code>{status.config.configPath}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Daemon</dt>
                    <dd>
                      epoch {snapshot.daemonEpoch} · sequence {snapshot.sequence}
                    </dd>
                  </div>
                  <div>
                    <dt>Endpoint</dt>
                    <dd>
                      <code>
                        {status.remote.loopbackHost}:{status.remote.port}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>Service unit</dt>
                    <dd>
                      <code>{status.service.unitName}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Checkpoints</dt>
                    <dd>{config.terminal.checkpoints.enabled ? "Enabled" : "Disabled"}</dd>
                  </div>
                  <div>
                    <dt>SSH tunnels</dt>
                    <dd>CLI-owned and not browser-observable</dd>
                  </div>
                </dl>
              </details>
            </>
          )}
        </div>

        <footer className="system-status-actions">
          <button
            type="button"
            disabled={status === undefined}
            onClick={() => void copyDiagnostics()}
          >
            <Copy aria-hidden="true" size={14} /> {copied ? "Copied" : "Copy diagnostics"}
          </button>
          <button type="button" className="primary-button" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
