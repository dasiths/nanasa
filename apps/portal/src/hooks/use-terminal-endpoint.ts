import type { TerminalEndpointStatus } from "@nanasa/contracts";
import { useCallback, useEffect, useState } from "react";

import type { PortalClient } from "../api.js";
import { type PortalError, toPortalError } from "../errors.js";

interface TerminalEndpointResult {
  status?: TerminalEndpointStatus;
  loading: boolean;
  error?: PortalError;
  retry(): void;
}

function retryDelay(
  status: TerminalEndpointStatus | undefined,
  attempt: number,
): number | undefined {
  if (status?.state === "ready" || status?.state === "stopped") {
    return undefined;
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

export function useTerminalEndpoint(
  client: PortalClient,
  runId: string,
  runRevision: string,
): TerminalEndpointResult {
  const [status, setStatus] = useState<TerminalEndpointStatus>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortalError>();
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempt = 0;

    const load = async () => {
      try {
        const nextStatus = await client.getTerminalEndpointStatus(runId);
        if (cancelled) return;
        setStatus(nextStatus);
        setLoading(false);
        setError(undefined);
        const delay = retryDelay(nextStatus, attempt);
        if (delay !== undefined) {
          attempt += 1;
          retryTimer = window.setTimeout(() => void load(), delay);
        }
      } catch (cause) {
        if (cancelled) return;
        setLoading(false);
        setError(toPortalError(cause, "Unable to load terminal status"));
        const delay = retryDelay(undefined, attempt);
        attempt += 1;
        retryTimer = window.setTimeout(() => void load(), delay);
      }
    };

    setLoading(true);
    setStatus(undefined);
    setError(undefined);
    void load();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [client, requestVersion, runId, runRevision]);

  const retry = useCallback(() => setRequestVersion((current) => current + 1), []);
  return {
    ...(status === undefined ? {} : { status }),
    loading,
    ...(error === undefined ? {} : { error }),
    retry,
  };
}
