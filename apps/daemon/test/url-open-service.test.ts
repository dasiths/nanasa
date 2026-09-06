import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import { browserOpenerEnvironment } from "../src/browser-opener.js";
import { McpCredentialIssuer } from "../src/mcp-auth.js";
import { NanasaStore } from "../src/store.js";
import { registerUrlOpenRoutes } from "../src/url-open-routes.js";
import { UrlOpenService } from "../src/url-open-service.js";

const stores: NanasaStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function fixture() {
  const store = new NanasaStore(":memory:");
  stores.push(store);
  const principal = {
    kind: "agent" as const,
    runId: "run-1",
    groupId: "group-1",
    memberId: "member-1",
    generation: 1,
  };
  const run = { id: principal.runId, ...principal, desiredState: "running", status: "running" };
  vi.spyOn(store, "getRun").mockReturnValue(run as never);
  vi.spyOn(store, "getActiveRun").mockReturnValue(run as never);
  vi.spyOn(store, "listActiveMemberships").mockReturnValue([
    { memberId: principal.memberId },
  ] as never);
  const emit = vi.spyOn(store, "recordRuntimeEvent").mockReturnValue({} as never);
  return { store, principal, service: new UrlOpenService(store), emit };
}

describe("URL open requests", () => {
  it("persists and deduplicates requests without putting URLs in events", () => {
    const { store, principal, service, emit } = fixture();
    const url = "https://example.com/login?token=private";
    const request = service.create(principal, url);
    expect(service.create(principal, url)).toEqual(request);
    expect(new UrlOpenService(store).list()).toEqual([request]);
    expect(emit).toHaveBeenCalledOnce();
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
  });

  it("expires old requests and invalidates stopped runs", () => {
    const { principal, service, store } = fixture();
    service.create(principal, "https://example.com");
    expect(service.list(Date.now() + 11 * 60_000)).toEqual([]);
    const request = service.create(principal, "https://example.com");
    vi.mocked(store.getActiveRun).mockReturnValue(undefined);
    expect(service.list()).toEqual([]);
    expect(() => service.get(request.id)).toThrow("no longer available");
    expect(() => service.create(principal, "https://example.com")).toThrow("no longer active");
  });

  it("bounds outstanding requests per run", () => {
    const { principal, service } = fixture();
    for (let index = 0; index < 10; index += 1)
      service.create(principal, `https://example.com/${index}`);
    expect(() => service.create(principal, "https://example.com/extra")).toThrow("Too many");
    expect(() => service.create(principal, "javascript:alert(1)")).toThrow("Invalid browser URL");
  });

  it("captures the real BROWSER and xdg-open helpers through authenticated HTTP", async () => {
    const { store, service, principal } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "nanasa-browser-test-"));
    const app = Fastify();
    try {
      const credentials = new McpCredentialIssuer(store, { secretPath: join(directory, "secret") });
      registerUrlOpenRoutes(app, { service, credentials, allowedHostnames: ["127.0.0.1"] });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const environment = {
        ...process.env,
        ...browserOpenerEnvironment(
          directory,
          resolve("../.."),
          `${address}/api/v1/agent-url-requests`,
        ),
        NANASA_MCP_TOKEN: credentials.issueAgent(store.getRun(principal.runId)),
      };
      await promisify(execFile)(environment.BROWSER!, ["https://example.com/login?code=private"], {
        env: environment,
      });
      await promisify(execFile)(
        join(environment.NANASA_BROWSER_BIN!, "xdg-open"),
        ["http://localhost:8080"],
        { env: environment },
      );
      await promisify(execFile)(
        process.execPath,
        [resolve("../../bin/nanasa.js"), "open-url", "https://example.org"],
        { env: environment },
      );
      expect(service.list().map((request) => request.url)).toEqual([
        "https://example.com/login?code=private",
        "http://localhost:8080",
        "https://example.org",
      ]);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agent-url-requests",
        headers: { host: "127.0.0.1" },
        payload: { url: "https://example.com" },
      });
      expect(response.statusCode).toBe(401);
      const spoofed = await app.inject({
        method: "POST",
        url: "/api/v1/agent-url-requests",
        headers: { host: "127.0.0.1", authorization: `Bearer ${environment.NANASA_MCP_TOKEN}` },
        payload: { url: "https://example.com", runId: "another-run" },
      });
      expect(spoofed.statusCode).toBe(400);
      const unsafe = await app.inject({
        method: "POST",
        url: "/api/v1/agent-url-requests",
        headers: { host: "127.0.0.1", authorization: `Bearer ${environment.NANASA_MCP_TOKEN}` },
        payload: { url: "javascript:private" },
      });
      expect(unsafe.statusCode).toBe(400);
      expect(unsafe.body).not.toContain("private");
      const crossOrigin = await app.inject({
        method: "POST",
        url: "/api/v1/agent-url-requests",
        headers: {
          host: "127.0.0.1",
          origin: "https://untrusted.example",
          authorization: `Bearer ${environment.NANASA_MCP_TOKEN}`,
        },
        payload: { url: "https://example.com" },
      });
      expect(crossOrigin.statusCode).toBe(403);
      vi.mocked(store.getActiveRun).mockReturnValue(undefined);
      const stale = await app.inject({
        method: "POST",
        url: "/api/v1/agent-url-requests",
        headers: { host: "127.0.0.1", authorization: `Bearer ${environment.NANASA_MCP_TOKEN}` },
        payload: { url: "https://example.com" },
      });
      expect(stale.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
