import type { UrlOpenRequest } from "@nanasa/contracts";
import { useEffect, useState } from "react";
import type { PortalClient } from "../api.js";
import { type PortalError, toPortalError } from "../errors.js";

export function useUrlOpenRequests(
  client: PortalClient,
  hydrationKey: string | undefined,
  eventSequence: number | undefined,
) {
  const [state, setState] = useState<{
    key?: string;
    requests: UrlOpenRequest[];
    error?: PortalError;
  }>({ requests: [] });
  useEffect(() => {
    if (hydrationKey === undefined) return;
    let active = true;
    void client.listUrlOpenRequests().then(
      (requests) => {
        if (active) setState({ key: hydrationKey, requests });
      },
      (cause: unknown) => {
        if (active)
          setState({
            key: hydrationKey,
            requests: [],
            error: toPortalError(cause, "Unable to load browser requests"),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client, hydrationKey, eventSequence]);
  useEffect(() => {
    if (state.requests.length === 0) return;
    const expiry = Math.min(...state.requests.map((request) => Date.parse(request.expiresAt)));
    const timer = window.setTimeout(
      () => {
        setState((current) => ({
          ...current,
          requests: current.requests.filter(
            (request) => Date.parse(request.expiresAt) > Date.now(),
          ),
        }));
      },
      Math.max(0, expiry - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [state.requests]);
  return {
    requests: state.key === hydrationKey ? state.requests : [],
    ready: hydrationKey !== undefined && state.key === hydrationKey,
    error: state.key === hydrationKey ? state.error : undefined,
  };
}
