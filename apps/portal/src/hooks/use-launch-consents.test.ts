import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PortalClient } from "../api.js";
import { launchConsentRequest } from "../test/launch-consent-fixture.js";
import { latestLaunchConsentRequests, useLaunchConsents } from "./use-launch-consents.js";

describe("useLaunchConsents", () => {
  it("keeps only the latest request per member", () => {
    expect(
      latestLaunchConsentRequests([
        launchConsentRequest({ id: "older", requestedAt: "2026-09-02T09:00:00.000Z" }),
        launchConsentRequest({ id: "newer" }),
      ]).map(({ id }) => id),
    ).toEqual(["newer"]);
  });

  it("reloads for lifecycle sequences and ignores a late older response", async () => {
    let resolveOld: (value: ReturnType<typeof launchConsentRequest>[]) => void = () => undefined;
    const oldRequest = new Promise<ReturnType<typeof launchConsentRequest>[]>((resolve) => {
      resolveOld = resolve;
    });
    const current = launchConsentRequest({ id: "current", state: "denied" });
    const client = {
      listLaunchConsents: vi.fn().mockReturnValueOnce(oldRequest).mockResolvedValueOnce([current]),
    } as unknown as PortalClient;
    const { result, rerender } = renderHook(
      ({ sequence }) => useLaunchConsents(client, "instance:1", sequence),
      { initialProps: { sequence: 1 } },
    );

    rerender({ sequence: 2 });
    await waitFor(() => expect(result.current.latestRequests).toEqual([current]));
    await act(async () => resolveOld([launchConsentRequest({ id: "obsolete" })]));

    expect(result.current.latestRequests).toEqual([current]);
    expect(client.listLaunchConsents).toHaveBeenCalledTimes(2);
  });

  it("retains requests and exposes an accessible error on reload failure", async () => {
    const request = launchConsentRequest();
    const client = {
      listLaunchConsents: vi
        .fn()
        .mockResolvedValueOnce([request])
        .mockRejectedValueOnce(new Error("offline")),
    } as unknown as PortalClient;
    const { result } = renderHook(() => useLaunchConsents(client, "instance:1", 1));
    await waitFor(() => expect(result.current.latestRequests).toEqual([request]));

    await act(async () => result.current.reload());

    expect(result.current.latestRequests).toEqual([request]);
    expect(result.current.error).toMatchObject({
      code: "portal_operation_failed",
      message: "Unable to load launch consent requests",
    });
  });
});
