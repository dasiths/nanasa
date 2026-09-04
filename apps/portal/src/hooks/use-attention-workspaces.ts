import type { AgentActionWorkspace } from "@nanasa/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PortalClient } from "../api.js";
import { type PortalError, toPortalError } from "../errors.js";

export interface AttentionWorkspaceState {
  workspaces: ReadonlyMap<string, AgentActionWorkspace>;
  loadingGroupIds: ReadonlySet<string>;
  errors: ReadonlyMap<string, PortalError>;
  ready: boolean;
  reloadGroup(groupId: string): Promise<void>;
}

export function useAttentionWorkspaces(
  client: PortalClient,
  groupIds: readonly string[],
  instanceId: string | undefined,
  daemonEpoch: number | undefined,
  snapshotSequence: number | undefined,
): AttentionWorkspaceState {
  const groupSignature = useMemo(() => [...new Set(groupIds)].sort().join("\u0000"), [groupIds]);
  const requestedGroupIds = useMemo(
    () => (groupSignature === "" ? [] : groupSignature.split("\u0000")),
    [groupSignature],
  );
  const [workspaces, setWorkspaces] = useState<Map<string, AgentActionWorkspace>>(new Map());
  const [loadingGroupIds, setLoadingGroupIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, PortalError>>(new Map());
  const [settledRequestKey, setSettledRequestKey] = useState<string>();
  const generationRef = useRef(0);
  const requestedRef = useRef<ReadonlySet<string>>(new Set());
  const requestKey = `${instanceId ?? ""}\u0000${daemonEpoch ?? ""}\u0000${snapshotSequence ?? ""}\u0000${groupSignature}`;

  useEffect(() => {
    const generation = ++generationRef.current;
    const requested = new Set(requestedGroupIds);
    requestedRef.current = requested;
    setWorkspaces((current) => new Map([...current].filter(([groupId]) => requested.has(groupId))));
    setErrors(new Map());
    setLoadingGroupIds(requested);
    if (requestedGroupIds.length === 0) {
      setSettledRequestKey(requestKey);
      return;
    }

    void Promise.allSettled(
      requestedGroupIds.map(
        async (groupId) => [groupId, await client.loadActionWorkspace(groupId)] as const,
      ),
    ).then((results) => {
      if (generationRef.current !== generation) return;
      setWorkspaces((current) => {
        const next = new Map(current);
        results.forEach((result) => {
          if (result.status === "fulfilled") next.set(result.value[0], result.value[1]);
        });
        return next;
      });
      setErrors(
        new Map(
          results.flatMap((result, index) =>
            result.status === "rejected"
              ? [
                  [
                    requestedGroupIds[index]!,
                    toPortalError(result.reason, "Unable to load Attention details"),
                  ] as const,
                ]
              : [],
          ),
        ),
      );
      setLoadingGroupIds(new Set());
      setSettledRequestKey(requestKey);
    });
  }, [client, daemonEpoch, groupSignature, instanceId, requestKey, snapshotSequence]);

  const reloadGroup = useCallback(
    async (groupId: string) => {
      if (!requestedRef.current.has(groupId)) return;
      const generation = generationRef.current;
      setLoadingGroupIds((current) => new Set(current).add(groupId));
      try {
        const workspace = await client.loadActionWorkspace(groupId);
        if (generationRef.current !== generation || !requestedRef.current.has(groupId)) return;
        setWorkspaces((current) => new Map(current).set(groupId, workspace));
        setErrors((current) => {
          const next = new Map(current);
          next.delete(groupId);
          return next;
        });
      } catch (cause) {
        if (generationRef.current !== generation || !requestedRef.current.has(groupId)) return;
        setErrors((current) =>
          new Map(current).set(groupId, toPortalError(cause, "Unable to load Attention details")),
        );
      } finally {
        if (generationRef.current === generation && requestedRef.current.has(groupId)) {
          setLoadingGroupIds((current) => {
            const next = new Set(current);
            next.delete(groupId);
            return next;
          });
        }
      }
    },
    [client],
  );

  return {
    workspaces,
    loadingGroupIds,
    errors,
    ready: settledRequestKey === requestKey,
    reloadGroup,
  };
}
