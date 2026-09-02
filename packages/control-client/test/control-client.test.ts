import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NanasaControlClient, NanasaControlResources } from "../src/index.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("NanasaControlClient", () => {
  it("removes and exchanges a one-use bootstrap fragment before authenticated requests", async () => {
    const replaceLocation = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          operatorId: "operator-local",
          csrfToken: "c".repeat(32),
          expiresAt: "2026-08-30T12:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(response({ ok: true }));
    const client = new NanasaControlClient({
      fetch,
      location: {
        href: `http://127.0.0.1:3210/#nanasa-bootstrap=${"b".repeat(32)}`,
        hash: `#nanasa-bootstrap=${"b".repeat(32)}`,
      },
      replaceLocation,
    });

    await expect(
      client.request("/api/v1/example", z.object({ ok: z.literal(true) }), {
        init: { method: "POST", body: "{}" },
      }),
    ).resolves.toEqual({ ok: true });

    expect(replaceLocation).toHaveBeenCalledWith("http://127.0.0.1:3210/");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/auth/bootstrap",
      expect.objectContaining({ body: JSON.stringify({ token: "b".repeat(32) }) }),
    );
    const requestInit = fetch.mock.calls[1]?.[1];
    expect(new Headers(requestInit?.headers).get("x-nanasa-csrf")).toBe("c".repeat(32));
  });

  it("uses bearer authority and typed resource modules for worktree operations", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        operation: {
          id: "git-operation-1",
          repositoryId: "repository-1",
          kind: "create-worktree",
          generation: 1,
          state: "succeeded",
          startedAt: "2026-08-29T12:00:00.000Z",
          completedAt: "2026-08-29T12:00:01.000Z",
        },
      }),
    );
    const resources = new NanasaControlResources(
      new NanasaControlClient({
        fetch,
        baseUrl: "http://127.0.0.1:3210",
        operatorToken: "operator-token",
      }),
    );

    await resources.workspace.createWorktree(
      {
        sourceCheckoutId: "checkout-1",
        branch: "feature/typed-client",
        base: "HEAD",
        assignAgentIds: [],
      },
      "worktree-key",
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3210/api/v1/worktrees");
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer operator-token");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("worktree-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({ branch: "feature/typed-client" });
  });
});
