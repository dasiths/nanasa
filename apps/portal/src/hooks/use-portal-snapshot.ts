import { DomainEventSchema, type NanasaConfig, type PortalSnapshot } from "@nanasa/contracts";
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

  const refresh = useCallback(async () => {
    const [snapshotResult, configResult] = await Promise.allSettled([
      client.loadSnapshot(),
      client.loadConfig(),
    ]);
    if (snapshotResult.status === "rejected") {
      setStatus("error");
      setErrorSource("snapshot");
      setError(
        snapshotResult.reason instanceof Error
          ? snapshotResult.reason.message
          : "Unable to load portal state",
      );
      return;
    }
    setSnapshot(snapshotResult.value);
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
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;
  if (snapshot !== undefined) {
    sequenceRef.current = Math.max(sequenceRef.current, snapshot.sequence);
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
      socket = client.createEventsSocket(sequenceRef.current);
      socket.onopen = () => {
        attempt = 0;
        setStatus("connected");
      };
      socket.onmessage = (event) => {
        try {
          const domainEvent = DomainEventSchema.parse(JSON.parse(String(event.data)));
          sequenceRef.current = Math.max(sequenceRef.current, domainEvent.sequence);
          callbackRef.current();
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
  }, [client, snapshot === undefined]);

  return status;
}
