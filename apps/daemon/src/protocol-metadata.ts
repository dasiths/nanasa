import { createHash } from "node:crypto";
import type { ControlMetadata } from "@nanasa/contracts";
import { DATABASE_SCHEMA_VERSION } from "./persistence/database.js";
import type { DaemonInstanceGuard } from "./daemon-instance-guard.js";
import type { DaemonLifecycle } from "./daemon-lifecycle.js";

export const CONTROL_API_VERSION = 1 as const;
export const EVENT_STREAM_VERSION = 1 as const;
export const PRODUCT_VERSION = "0.0.0";
export const EVENT_REPLAY_PAGE_SIZE = 256;
export const EVENT_PENDING_BYTE_LIMIT = 1_048_576;

export function repositoryIdentity(repositoryRoot: string): string {
  return `repo_${createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 32)}`;
}

export function repositoryTmuxNamespace(repositoryRoot: string): string {
  return `nanasa-${createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 20)}`;
}

export function controlMetadata(options: {
  repositoryRoot: string;
  repositoryId?: string;
  guard: DaemonInstanceGuard;
  daemonEpoch: number;
  lifecycle: DaemonLifecycle;
}): ControlMetadata {
  const lifecycle = options.lifecycle.state;
  if (lifecycle === "stopped") throw new Error("Stopped daemons do not expose metadata");
  return {
    apiVersion: CONTROL_API_VERSION,
    eventProtocolVersion: EVENT_STREAM_VERSION,
    productVersion: PRODUCT_VERSION,
    configVersion: 2,
    databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
    repositoryId: options.repositoryId ?? repositoryIdentity(options.repositoryRoot),
    instanceId: options.guard.instanceId,
    daemonEpoch: options.daemonEpoch,
    lifecycle,
    remoteAccess: "loopback-only",
    limits: {
      eventReplayPageSize: EVENT_REPLAY_PAGE_SIZE,
      eventPendingBytes: EVENT_PENDING_BYTE_LIMIT,
    },
  };
}
