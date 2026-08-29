import { EventServerFrameSchema, type NanasaConfig, type PortalSnapshot } from "@nanasa/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PortalClient } from "../api.js";

export type LoadStatus = "loading" | "ready" | "error";
export type EventConnectionStatus = "disconnected" | "connected" | "reconnecting";

export function usePortalSnapshot(client: PortalClient) {
  const [snapshot, setSnapshot] = useState<PortalSnapshot>();
  const [config, setConfig] = useState<NanasaConfig>();
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string>();
  const [errorSource, setErrorSource] = useState<"snapshot" | "config">();
  const acceptedRef = useRef<
    { instanceId: string; daemonEpoch: number; sequence: number } | undefined
  >(undefined);
  const inFlightRef = useRef<Promise<void> | undefined>(undefined);
  const trailingInvalidationRef = useRef(false);

  const refresh = useCallback(async () => {
    trailingInvalidationRef.current = true;
    if (inFlightRef.current !== undefined) return inFlightRef.current;

    const operation = (async () => {
      do {
        trailingInvalidationRef.current = false;
        const [metadataResult, snapshotResult, configResult] = await Promise.allSettled([
          client.loadMetadata(),
          client.loadSnapshot(),
          client.loadConfig(),
        ]);
        if (metadataResult.status === "rejected" || snapshotResult.status === "rejected") {
          const reason =
            metadataResult.status === "rejected"
              ? metadataResult.reason
              : snapshotResult.status === "rejected"
                ? snapshotResult.reason
                : undefined;
          setStatus("error");
          setErrorSource("snapshot");
          setError(reason instanceof Error ? reason.message : "Unable to load portal state");
          return;
        }
        const next = snapshotResult.value;
        if (
          next.instanceId !== metadataResult.value.instanceId ||
          next.daemonEpoch !== metadataResult.value.daemonEpoch
        ) {
          trailingInvalidationRef.current = true;
          continue;
        }
        const accepted = acceptedRef.current;
        const isStale =
          accepted !== undefined &&
          (next.daemonEpoch < accepted.daemonEpoch ||
            (next.daemonEpoch === accepted.daemonEpoch &&
              (next.instanceId !== accepted.instanceId || next.sequence < accepted.sequence)));
        if (!isStale) {
          acceptedRef.current = {
            instanceId: next.instanceId,
            daemonEpoch: next.daemonEpoch,
            sequence: next.sequence,
          };
          setSnapshot(next);
        }
        if (configResult.status === "rejected") {
          setStatus("error");
          setErrorSource("config");
          setError(
            configResult.reason instanceof Error
              ? configResult.reason.message
              : "Unable to load repository configuration",
          );
          return;
        }
        setConfig(configResult.value);
        setStatus("ready");
        setError(undefined);
        setErrorSource(undefined);
      } while (trailingInvalidationRef.current);
    })();
    inFlightRef.current = operation;
    try {
      await operation;
    } finally {
      if (inFlightRef.current === operation) inFlightRef.current = undefined;
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { snapshot, config, status, error, errorSource, refresh };
}

export function useDomainEvents(
  client: PortalClient,
  snapshot: PortalSnapshot | undefined,
  onEvent: () => void,
): EventConnectionStatus {
  const [status, setStatus] = useState<EventConnectionStatus>("disconnected");
  const sequenceRef = useRef(0);
  const instanceRef = useRef<string | undefined>(undefined);
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;
  if (snapshot !== undefined) {
    if (instanceRef.current !== snapshot.instanceId) {
      instanceRef.current = snapshot.instanceId;
      sequenceRef.current = snapshot.sequence;
    } else {
      sequenceRef.current = Math.max(sequenceRef.current, snapshot.sequence);
    }
  }

  useEffect(() => {
    if (snapshot === undefined) {
      return;
    }

    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let stopped = false;
    let attempt = 0;

    const connect = () => {
      if (stopped) {
        return;
      }
      socket = client.createEventsSocket(sequenceRef.current, snapshot.instanceId);
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (event) => {
        try {
          const frame = EventServerFrameSchema.parse(JSON.parse(String(event.data)));
          if (frame.type === "subscription.started") {
            if (
              frame.instanceId !== snapshot.instanceId ||
              frame.daemonEpoch !== snapshot.daemonEpoch
            ) {
              setStatus("reconnecting");
              callbackRef.current();
              socket?.close();
              return;
            }
            setStatus("connected");
          } else if (frame.type === "domain.event") {
            sequenceRef.current = Math.max(sequenceRef.current, frame.event.sequence);
            callbackRef.current();
          } else if (frame.type === "subscription.heartbeat") {
            sequenceRef.current = Math.max(sequenceRef.current, frame.cursor);
          } else {
            setStatus("reconnecting");
            if (frame.type === "subscription.reset-required") callbackRef.current();
            socket?.close();
          }
        } catch {
          setStatus("reconnecting");
          socket?.close();
        }
      };
      socket.onclose = () => {
        if (stopped) {
          return;
        }
        setStatus("reconnecting");
        const delay = Math.min(500 * 2 ** attempt, 8_000);
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
      setStatus("disconnected");
    };
  }, [client, snapshot?.daemonEpoch, snapshot?.instanceId]);

  return status;
}
