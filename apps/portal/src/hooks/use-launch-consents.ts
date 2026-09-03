import type { CustomLaunchConsentRequest } from "@nanasa/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PortalClient } from "../api.js";
import { type PortalError, toPortalError } from "../errors.js";

export function latestLaunchConsentRequests(
  requests: readonly CustomLaunchConsentRequest[],
): CustomLaunchConsentRequest[] {
  const latest = new Map<string, CustomLaunchConsentRequest>();
  for (const request of requests) {
    const key = `${request.groupId}\u0000${request.memberId}`;
    const current = latest.get(key);
    if (
      current === undefined ||
      request.requestedAt > current.requestedAt ||
      (request.requestedAt === current.requestedAt && request.id > current.id)
    ) {
      latest.set(key, request);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.groupId.localeCompare(right.groupId) || left.memberId.localeCompare(right.memberId),
  );
}

export function useLaunchConsents(
  client: PortalClient,
  hydrationKey: string | undefined,
  eventSequence: number | undefined,
) {
  const [requests, setRequests] = useState<CustomLaunchConsentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortalError>();
  const loadRevision = useRef(0);

  const reload = useCallback(async () => {
    const revision = ++loadRevision.current;
    setLoading(true);
    try {
      const next = await client.listLaunchConsents();
      if (revision !== loadRevision.current) return;
      setRequests(next);
      setError(undefined);
    } catch (cause) {
      if (revision !== loadRevision.current) return;
      setError(toPortalError(cause, "Unable to load launch consent requests"));
    } finally {
      if (revision === loadRevision.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (hydrationKey === undefined) return;
    void reload();
  }, [eventSequence, hydrationKey, reload]);

  return {
    requests,
    latestRequests: latestLaunchConsentRequests(requests),
    loading,
    error,
    reload,
  };
}
