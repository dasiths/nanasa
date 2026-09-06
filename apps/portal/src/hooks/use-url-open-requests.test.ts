import type { UrlOpenRequest } from "@nanasa/contracts";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { useUrlOpenRequests } from "./use-url-open-requests.js";

const request: UrlOpenRequest = {
  id: "url-one",
  groupId: "group-one",
  memberId: "member-one",
  runId: "run-one",
  generation: 1,
  url: "https://example.com",
  requestedAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-09-06T00:10:00.000Z",
};
afterEach(() => vi.useRealTimers());

describe("pending browser requests", () => {
  it("expires an item locally without another daemon event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(request.requestedAt));
    const client = {
      listUrlOpenRequests: vi.fn().mockResolvedValue([request]),
    } as unknown as PortalClient;
    const { result } = renderHook(() => useUrlOpenRequests(client, "daemon:1", 1));
    await act(async () => {});
    expect(result.current.requests).toEqual([request]);
    expect(result.current.ready).toBe(true);
    await act(async () => vi.advanceTimersByTime(10 * 60_000));
    expect(result.current.requests).toEqual([]);
    expect(client.listUrlOpenRequests).toHaveBeenCalledOnce();
  });

  it("ignores requests returned by a superseded daemon load", async () => {
    let resolveOld!: (requests: UrlOpenRequest[]) => void;
    const load = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<UrlOpenRequest[]>((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValue([]);
    const client = { listUrlOpenRequests: load } as unknown as PortalClient;
    const { result, rerender } = renderHook(({ key }) => useUrlOpenRequests(client, key, 1), {
      initialProps: { key: "daemon:1" },
    });
    rerender({ key: "daemon:2" });
    await act(async () => {});
    await act(async () => resolveOld([request]));
    expect(result.current.requests).toEqual([]);
    expect(result.current.ready).toBe(true);
  });
});
