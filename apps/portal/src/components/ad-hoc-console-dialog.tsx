import type { AdHocConsoleSession } from "@nanasa/contracts";
import { CircleAlert, LoaderCircle, RefreshCw, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PortalClient } from "../api.js";
import { useTerminalEndpoint } from "../hooks/use-terminal-endpoint.js";

function ConsoleTerminal({
  client,
  session,
  onRestart,
}: {
  client: PortalClient;
  session: AdHocConsoleSession;
  onRestart(): void;
}) {
  const { status, loading, error, retry } = useTerminalEndpoint(client, session.runId, session.id);

  if (status?.state === "ready") {
    return (
      <iframe
        className="console-frame"
        src={status.url}
        title="Ad hoc console terminal"
        referrerPolicy="same-origin"
      />
    );
  }

  return (
    <div className="console-state" role={error === undefined ? "status" : "alert"}>
      {loading || status?.state === "starting" || status?.state === "backoff" ? (
        <LoaderCircle className="spin" aria-hidden="true" size={22} />
      ) : (
        <CircleAlert aria-hidden="true" size={22} />
      )}
      <strong>{error ?? status?.error?.message ?? "Starting console"}</strong>
      {(error !== undefined || status?.state === "unavailable") && (
        <button
          type="button"
          className="compact-button"
          onClick={error === undefined ? retry : onRestart}
        >
          <RefreshCw aria-hidden="true" size={14} />
          Retry
        </button>
      )}
    </div>
  );
}

export function AdHocConsoleDialog({ client, onClose }: { client: PortalClient; onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState<AdHocConsoleSession>();
  const [error, setError] = useState<string>();
  const [requestRevision, setRequestRevision] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let activeSession: AdHocConsoleSession | undefined;
    setSession(undefined);
    setError(undefined);
    void client
      .createConsole()
      .then((created) => {
        activeSession = created;
        if (disposed) return client.closeConsole(created.id);
        setSession(created);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Unable to open console");
      });
    return () => {
      disposed = true;
      if (activeSession !== undefined) {
        void client.closeConsole(activeSession.id).catch(() => undefined);
      }
    };
  }, [client, requestRevision]);

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog console-dialog"
      aria-labelledby="console-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="console-dialog-heading">
        <div>
          <SquareTerminal aria-hidden="true" size={18} />
          <h2 id="console-dialog-title">Console</h2>
          <span>bash</span>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close console"
          title="Close console"
          onClick={onClose}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </header>
      <div className="console-dialog-body">
        {session !== undefined ? (
          <ConsoleTerminal
            client={client}
            session={session}
            onRestart={() => setRequestRevision((current) => current + 1)}
          />
        ) : error !== undefined ? (
          <div className="console-state" role="alert">
            <CircleAlert aria-hidden="true" size={22} />
            <strong>{error}</strong>
            <button
              type="button"
              className="compact-button"
              onClick={() => setRequestRevision((current) => current + 1)}
            >
              <RefreshCw aria-hidden="true" size={14} />
              Retry
            </button>
          </div>
        ) : (
          <div className="console-state" role="status">
            <LoaderCircle className="spin" aria-hidden="true" size={22} />
            <strong>Starting console</strong>
          </div>
        )}
      </div>
    </dialog>
  );
}
