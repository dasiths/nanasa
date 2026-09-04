import type {
  CustomLaunchConsentRequest,
  GroupMembership,
  RoleDefinition,
} from "@nanasa/contracts";
import { Ban, Check, CircleAlert, Clock3, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
import { RoleIdentity, roleColorClass } from "./role-identity.js";

function launcherLabel(request: CustomLaunchConsentRequest): string {
  const strategy = request.subject.launcher;
  return strategy === "append"
    ? "Append provider arguments"
    : `Environment variable ${strategy.name}`;
}

function credentialLabel(request: CustomLaunchConsentRequest): string {
  const reference = request.subject.credentialReference;
  return reference.kind === "provider-managed"
    ? "Provider managed"
    : `Broker profile ${reference.profileId}`;
}

function commandLabel(command: readonly string[]): string {
  return command.map((argument) => JSON.stringify(argument)).join(" ");
}

const stateCopy = {
  pending: {
    label: "Approval required",
    summary:
      "Review this repository-defined launcher before credentials and generated access are made available.",
    icon: Clock3,
  },
  approved: {
    label: "Approval recorded",
    summary: "The exact launcher was trusted. Terminal startup is continuing.",
    icon: Check,
  },
  denied: {
    label: "Launch denied",
    summary: "This exact launcher is durably denied and the agent remains stopped.",
    icon: Ban,
  },
  cancelled: {
    label: "Request cancelled",
    summary: "No trust decision was stored. Starting the agent again can create a new request.",
    icon: X,
  },
  stale: {
    label: "Request stale",
    summary:
      "The launch configuration changed. Start the agent again to review the replacement request.",
    icon: CircleAlert,
  },
} as const;

export function LaunchConsentPane({
  request,
  member,
  role,
  providerUpdate = false,
  onApprove,
  onCancel,
}: {
  request: CustomLaunchConsentRequest;
  member: GroupMembership;
  role: RoleDefinition | undefined;
  providerUpdate?: boolean;
  onApprove(request: CustomLaunchConsentRequest): Promise<void>;
  onCancel(request: CustomLaunchConsentRequest): Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "cancel">();
  const [error, setError] = useState<PortalError>();
  const paneRef = useRef<HTMLElement>(null);
  const copy = stateCopy[request.state];
  const StateIcon = copy.icon;
  const heading =
    providerUpdate && request.state === "pending"
      ? `Review before restarting ${member.alias}`
      : copy.label;
  const summary =
    providerUpdate && request.state === "pending"
      ? "The agent tools or launch settings changed. Confirm the command Nanasa will run."
      : copy.summary;

  useEffect(() => {
    if (window.location.hash !== `#launch-consent-${encodeURIComponent(request.id)}`) return;
    const frame = requestAnimationFrame(() => paneRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [request.id]);

  const act = async (action: "approve" | "cancel") => {
    setBusy(action);
    setError(undefined);
    try {
      await (action === "approve" ? onApprove(request) : onCancel(request));
    } catch (cause) {
      setError(
        toPortalError(
          cause,
          action === "approve"
            ? "Unable to trust and start this launcher"
            : "Unable to cancel this launch request",
        ),
      );
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section
      ref={paneRef}
      id={`launch-consent-${request.id}`}
      className={`terminal-pane launch-consent-pane ${roleColorClass(role)}`}
      aria-labelledby={`launch-consent-title-${request.id}`}
      tabIndex={-1}
    >
      <div className="terminal-statusbar">
        <span className={`consent-state-dot consent-state-${request.state}`} aria-hidden="true" />
        <strong>{member.alias}</strong>
        <span className="terminal-agent-kind">{request.subject.providerKind}</span>
        <RoleIdentity role={role} compact />
        <span className="terminal-header-spacer" />
        <span>{copy.label}</span>
      </div>
      <div className="launch-consent-content">
        <header className="launch-consent-heading">
          <StateIcon aria-hidden="true" size={22} />
          <div>
            <h2 id={`launch-consent-title-${request.id}`}>{heading}</h2>
            <p>{summary}</p>
          </div>
        </header>

        <div className="launch-consent-command" aria-label="Exact configured command and arguments">
          <span>Repository command</span>
          <code>{commandLabel(request.subject.configuredCommand)}</code>
        </div>

        <dl className="launch-consent-summary">
          <div>
            <dt>Provider</dt>
            <dd>{request.subject.providerKind}</dd>
          </div>
          <div>
            <dt>Adapter</dt>
            <dd>
              {request.subject.adapterId} security {request.subject.adapterSecurityVersion}
            </dd>
          </div>
          <div>
            <dt>Working directory</dt>
            <dd>{request.subject.workingDirectory ?? "Repository root"}</dd>
          </div>
          <div>
            <dt>Launcher</dt>
            <dd>{launcherLabel(request)}</dd>
          </div>
          <div>
            <dt>Credential mode</dt>
            <dd>{credentialLabel(request)}</dd>
          </div>
          <div>
            <dt>Permission floor</dt>
            <dd>
              {request.subject.permissionFloor}
              {request.subject.permissionFloorCapability === undefined
                ? " · wrapper behavior not enforced"
                : ` · enforced by ${request.subject.permissionFloorCapability}`}
            </dd>
          </div>
        </dl>

        <details className="launch-consent-details">
          <summary>Environment and generated access</summary>
          <div>
            <section aria-labelledby={`consent-env-${request.id}`}>
              <h3 id={`consent-env-${request.id}`}>Environment variable names</h3>
              {request.subject.environmentNames.length === 0 ? (
                <p>No integration environment variables.</p>
              ) : (
                <ul className="consent-token-list">
                  {request.subject.environmentNames.map((name) => (
                    <li key={name}>
                      <code>{name}</code>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby={`consent-access-${request.id}`}>
              <h3 id={`consent-access-${request.id}`}>Generated access</h3>
              <ul>
                <li>Effective agent prompt and provider settings</li>
                <li>Nanasa MCP endpoint and run-scoped credential</li>
                <li>Status reporter endpoint and run-scoped credential</li>
              </ul>
            </section>
            {request.subject.launcherFiles.length > 0 && (
              <section aria-labelledby={`consent-files-${request.id}`}>
                <h3 id={`consent-files-${request.id}`}>Repository launcher files</h3>
                <ul className="consent-file-list">
                  {request.subject.launcherFiles.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code>
                      <span>{file.digest}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </details>

        {error !== undefined && <ErrorNotice error={error} className="launch-consent-error" />}
        {request.state === "pending" && (
          <div className="launch-consent-actions">
            <button type="button" disabled={busy !== undefined} onClick={() => void act("cancel")}>
              <X aria-hidden="true" size={15} />
              {busy === "cancel" ? "Cancelling..." : providerUpdate ? "Not now" : "Cancel"}
            </button>
            <button
              type="button"
              className="primary-action"
              disabled={busy !== undefined}
              onClick={() => void act("approve")}
            >
              {busy === "approve" ? (
                <LoaderCircle className="spin" aria-hidden="true" size={15} />
              ) : (
                <ShieldCheck aria-hidden="true" size={15} />
              )}
              {busy === "approve"
                ? "Starting..."
                : providerUpdate
                  ? "Approve and restart"
                  : "Trust and start"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
