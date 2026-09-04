import type { AgentActionWorkspace } from "@nanasa/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { useAttentionWorkspaces } from "./use-attention-workspaces.js";

function workspace(groupId: string, marker = groupId): AgentActionWorkspace {
  return {
    groupId,
    actions: [],
    attempts: [],
    acknowledgements: [],
    openWaits: [],
    ...(marker === groupId ? {} : { marker }),
  } as AgentActionWorkspace;
}

describe("useAttentionWorkspaces", () => {
  it("keeps successful groups when repository fan-out partially fails", async () => {
    const client = {
      loadActionWorkspace: vi.fn((groupId: string) =>
        groupId === "group-b"
          ? Promise.reject(new Error("group-b unavailable"))
          : Promise.resolve(workspace(groupId)),
      ),
    } as unknown as PortalClient;

    const { result } = renderHook(() =>
      useAttentionWorkspaces(client, ["group-b", "group-a"], "instance-one", 1, 7),
    );

    expect(result.current.ready).toBe(false);
    expect(result.current.loadingGroupIds).toEqual(new Set(["group-a", "group-b"]));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.loadingGroupIds.size).toBe(0);
    expect([...result.current.workspaces.keys()]).toEqual(["group-a"]);
    expect(result.current.errors.get("group-b")).toEqual({
      message: "Unable to load Attention details",
      details: { cause: "group-b unavailable" },
      code: "portal_operation_failed",
    });
  });

  it("ignores late workspace results from a previous daemon identity", async () => {
    let resolveOld: (value: AgentActionWorkspace) => void = () => undefined;
    const oldRequest = new Promise<AgentActionWorkspace>((resolve) => {
      resolveOld = resolve;
    });
    const client = {
      loadActionWorkspace: vi
        .fn()
        .mockReturnValueOnce(oldRequest)
        .mockResolvedValueOnce(workspace("group-a", "new")),
    } as unknown as PortalClient;

    const { result, rerender } = renderHook(
      ({ instanceId }) => useAttentionWorkspaces(client, ["group-a"], instanceId, 1, 7),
      { initialProps: { instanceId: "old-instance" } },
    );
    rerender({ instanceId: "new-instance" });
    await waitFor(() => expect(result.current.loadingGroupIds.size).toBe(0));
    const accepted = result.current.workspaces.get("group-a");

    await act(async () => resolveOld(workspace("group-a", "old")));
    expect(result.current.workspaces.get("group-a")).toBe(accepted);
  });

  it("preserves the last successful workspace when a targeted reload fails", async () => {
    const client = {
      loadActionWorkspace: vi
        .fn()
        .mockResolvedValueOnce(workspace("group-a"))
        .mockRejectedValueOnce(new Error("refresh failed")),
    } as unknown as PortalClient;
    const { result } = renderHook(() =>
      useAttentionWorkspaces(client, ["group-a"], "instance-one", 1, 7),
    );
    await waitFor(() => expect(result.current.workspaces.has("group-a")).toBe(true));
    const original = result.current.workspaces.get("group-a");

    await act(async () => result.current.reloadGroup("group-a"));

    expect(result.current.workspaces.get("group-a")).toBe(original);
    expect(result.current.errors.get("group-a")).toEqual({
      message: "Unable to load Attention details",
      details: { cause: "refresh failed" },
      code: "portal_operation_failed",
    });
  });
});
