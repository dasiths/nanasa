import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadNanasaConfig } from "../src/config-loader.js";
import { OperatorAuth } from "../src/operator-auth.js";
import { createDaemon } from "../src/server.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("operator authority", () => {
  it("bounds abandoned one-use portal grants", () => {
    const repository = mkdtempSync(join(tmpdir(), "nanasa-portal-grants-"));
    temporaryDirectories.push(repository);
    const auth = new OperatorAuth({ secretPath: join(repository, "runtime", "operator-secret") });
    const tokens = Array.from({ length: 33 }, () => auth.createBootstrapToken());
    const reply = { header: () => reply } as never;

    expect(() => auth.bootstrap({ token: tokens[0] }, reply)).toThrow("invalid or already used");
    expect(auth.bootstrap({ token: tokens.at(-1) }, reply)).toMatchObject({
      operatorId: "operator-local-portal",
    });
  });

  it("persists a strictly increasing daemon epoch across replacement", async () => {
    const repository = mkdtempSync(join(tmpdir(), "nanasa-epoch-"));
    temporaryDirectories.push(repository);
    execFileSync("git", ["init", "--quiet", repository]);
    mkdirSync(join(repository, ".nanasa"));
    writeFileSync(join(repository, ".nanasa", "config.yaml"), "version: 2\nintegrations: {}\n");
    const loadedConfig = loadNanasaConfig(repository);
    const dataPath = join(repository, ".nanasa", "state.sqlite");
    const first = await createDaemon({ dataPath, loadedConfig });
    const firstEpoch = first.daemonEpoch;
    const firstInstance = first.guard.instanceId;
    await first.app.close();

    const second = await createDaemon({ dataPath, loadedConfig });
    try {
      expect(second.daemonEpoch).toBe(firstEpoch + 1);
      expect(second.guard.instanceId).not.toBe(firstInstance);
    } finally {
      await second.app.close();
    }
  });

  it("rejects hostile authorities, enforces one-use bootstrap and CSRF, and revokes sessions", async () => {
    const repository = mkdtempSync(join(tmpdir(), "nanasa-authority-"));
    temporaryDirectories.push(repository);
    execFileSync("git", ["init", "--quiet", repository]);
    mkdirSync(join(repository, ".nanasa"));
    writeFileSync(join(repository, ".nanasa", "config.yaml"), "version: 2\nintegrations: {}\n");
    const daemon = await createDaemon({
      dataPath: ":memory:",
      loadedConfig: loadNanasaConfig(repository),
    });
    try {
      const metadata = await daemon.app.inject({ method: "GET", url: "/api/v1/meta" });
      expect(metadata.json()).toMatchObject({
        apiVersion: 1,
        eventProtocolVersion: 1,
        instanceId: daemon.guard.instanceId,
        daemonEpoch: daemon.daemonEpoch,
        remoteAccess: "loopback-only",
      });
      expect(daemon.daemonEpoch).toBeGreaterThan(0);
      const hostileHost = await daemon.app.inject({
        method: "GET",
        url: "/api/v1/meta",
        headers: { host: "attacker.example" },
      });
      expect(hostileHost.statusCode).toBe(403);

      const token = daemon.bootstrapFragment.slice("nanasa-bootstrap=".length);
      const hostileOrigin = await daemon.app.inject({
        method: "POST",
        url: "/api/v1/auth/bootstrap",
        headers: { host: "127.0.0.1:3210", origin: "https://attacker.example" },
        payload: { token },
      });
      expect(hostileOrigin.statusCode).toBe(403);

      for (const url of [
        "/api/v1/groups/group-one/runs/recover",
        "/api/v1/groups/group-one/agents/agent-one/run/recover",
      ]) {
        const recovery = await daemon.app.inject({ method: "POST", url, payload: {} });
        expect(recovery.statusCode).toBe(401);
        expect(recovery.json()).toMatchObject({ code: "operator_unauthorized" });
      }

      expect(
        (await daemon.app.inject({ method: "POST", url: "/api/v1/auth/portal", payload: {} }))
          .statusCode,
      ).toBe(401);
      const credential = readFileSync(join(daemon.runtimePath, "operator-secret")).toString(
        "base64url",
      );
      const portalGrant = await daemon.app.inject({
        method: "POST",
        url: "/api/v1/auth/portal",
        headers: { authorization: `Bearer ${credential}` },
        payload: {},
      });
      expect(portalGrant.statusCode).toBe(200);
      const mintedToken = portalGrant
        .json<{ fragment: string; expiresAt: string }>()
        .fragment.slice("nanasa-bootstrap=".length);
      expect(Date.parse(portalGrant.json<{ expiresAt: string }>().expiresAt)).toBeGreaterThan(
        Date.now(),
      );
      const mintedExchange = await daemon.app.inject({
        method: "POST",
        url: "/api/v1/auth/bootstrap",
        headers: { host: "127.0.0.1:3210", origin: "http://127.0.0.1:3210" },
        payload: { token: mintedToken },
      });
      expect(mintedExchange.statusCode).toBe(200);
      expect(
        (
          await daemon.app.inject({
            method: "POST",
            url: "/api/v1/auth/bootstrap",
            payload: { token: mintedToken },
          })
        ).statusCode,
      ).toBe(401);

      const exchange = await daemon.app.inject({
        method: "POST",
        url: "/api/v1/auth/bootstrap",
        headers: { host: "127.0.0.1:3210", origin: "http://127.0.0.1:3210" },
        payload: { token },
      });
      expect(exchange.statusCode).toBe(200);
      expect(exchange.headers["set-cookie"]).toContain("HttpOnly");
      expect(exchange.headers["set-cookie"]).toContain("SameSite=Strict");
      const cookie = exchange.headers["set-cookie"]!.split(";", 1)[0]!;
      const csrfToken = exchange.json<{ csrfToken: string }>().csrfToken;

      expect(
        (
          await daemon.app.inject({
            method: "POST",
            url: "/api/v1/auth/bootstrap",
            payload: { token },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await daemon.app.inject({
            method: "POST",
            url: "/api/v1/groups",
            headers: { cookie },
            payload: { name: "No CSRF" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await daemon.app.inject({
            method: "POST",
            url: "/api/v1/groups",
            headers: { cookie, "x-nanasa-csrf": csrfToken },
            payload: { name: "Authorized" },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await daemon.app.inject({
            method: "GET",
            url: "/api/snapshot",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(404);
      const snapshotSpy = vi.spyOn(daemon.store, "getSnapshot");
      expect(
        (
          await daemon.app.inject({
            method: "GET",
            url: "/api/v1/snapshot",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(200);
      expect(snapshotSpy).toHaveBeenLastCalledWith(
        { instanceId: daemon.guard.instanceId, daemonEpoch: daemon.daemonEpoch },
        "operator-local-portal",
      );

      expect(
        (
          await daemon.app.inject({
            method: "POST",
            url: "/api/v1/auth/revoke",
            headers: { cookie, "x-nanasa-csrf": csrfToken },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await daemon.app.inject({
            method: "GET",
            url: "/api/v1/snapshot",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await daemon.app.close();
    }
  });
});
