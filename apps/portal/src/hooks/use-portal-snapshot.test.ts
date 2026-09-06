import { type ControlMetadata, NanasaConfigSchema, PortalSnapshotSchema } from "@nanasa/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { usePortalSnapshot } from "./use-portal-snapshot.js";

const snapshot = PortalSnapshotSchema.parse({
  instanceId: "daemon-one",
  daemonEpoch: 1,
  sequence: 7,
  generatedAt: "2026-09-06T00:00:00.000Z",
  groups: [],
  agentProfiles: [],
  memberships: [],
  runs: [],
  messages: [],
  deliveryOutcomes: [],
});
const config = NanasaConfigSchema.parse({
  version: 2,
  repository: { path: ".", checkout: { kind: "current" } },
  groups: {},
  integrations: {},
  roles: {},
});
afterEach(() => vi.restoreAllMocks());

describe("snapshot receipt time", () => {
  it("updates freshness only for accepted snapshots and retains it on refresh failure", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const loadSnapshot = vi.fn().mockResolvedValue(snapshot);
    const client = {
      loadMetadata: vi.fn().mockResolvedValue({
        instanceId: snapshot.instanceId,
        daemonEpoch: snapshot.daemonEpoch,
      } as ControlMetadata),
      loadSnapshot,
      loadConfig: vi.fn().mockResolvedValue(config),
    } as unknown as PortalClient;
    const { result, unmount } = renderHook(() => usePortalSnapshot(client));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.receivedAt).toBe(1000);
    clock.mockReturnValue(2000);
    loadSnapshot.mockResolvedValue({ ...snapshot, sequence: 6 });
    await act(() => result.current.refresh());
    expect(result.current.snapshot?.sequence).toBe(7);
    expect(result.current.receivedAt).toBe(1000);
    clock.mockReturnValue(3000);
    loadSnapshot.mockRejectedValue(new Error("Connection interrupted"));
    await act(() => result.current.refresh());
    expect(result.current.receivedAt).toBe(1000);
    expect(result.current.errorSource).toBe("snapshot");
    loadSnapshot.mockResolvedValue({ ...snapshot, sequence: 8 });
    await act(() => result.current.refresh());
    expect(result.current.receivedAt).toBe(3000);
    expect(result.current.status).toBe("ready");
    unmount();
  });
});
