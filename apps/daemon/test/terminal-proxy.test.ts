import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { createDaemon, type DaemonContext } from "../src/server.js";
import { loadNanasaConfig } from "../src/config-v2.js";

const daemons = new Set<DaemonContext>();
const servers = new Set<Server>();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const daemon of daemons) {
    await daemon.app.close();
  }
  daemons.clear();
  for (const server of servers) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
  servers.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function loadedConfig() {
  const repository = mkdtempSync(join(tmpdir(), "nanasa-terminal-proxy-"));
  temporaryDirectories.push(repository);
  mkdirSync(join(repository, ".git"));
  mkdirSync(join(repository, ".nanasa"));
  writeFileSync(join(repository, ".nanasa", "config.yaml"), "version: 2\nintegrations: {}\n");
  return loadNanasaConfig(repository);
}

function runningRun(daemon: DaemonContext): AgentRun {
  const group = daemon.store.createGroup({ name: "Proxy tests" });
  const profile = daemon.store.createInternalAgentProfile({
    name: "Fixture",
    agentType: "copilot",
    kind: "copilot",
    command: "node",
    args: [],
    environment: {},
  });
  daemon.store.addMembership(group.id, {
    memberId: "alpha",
    agentProfileId: profile.id,
    alias: "Alpha",
  });
  const { run } = daemon.store.createRunForMembership(group.id, "alpha");
  return daemon.store.updateRunStatus(run.id, "running", {
    terminal: {
      serverName: "nanasa-proxy-test",
      sessionId: "$1",
      windowId: "@2",
      paneId: "%3",
    },
  });
}

async function listen(server: Server): Promise<number> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function readyEndpoint(daemon: DaemonContext, run: AgentRun, port: number) {
  const record = daemon.terminalEndpoints.begin(run, 1);
  daemon.terminalEndpoints.publishReady(run.id, 1, port);
  return record;
}

describe("terminal endpoint proxy", () => {
  it("publishes same-origin status and proxies only bounded HTTP routes", async () => {
    let upstreamRequest: IncomingMessage | undefined;
    const upstream = createServer((request, response) => {
      upstreamRequest = request;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: request.url }));
    });
    const upstreamPort = await listen(upstream);
    const daemon = await createDaemon({ dataPath: ":memory:", loadedConfig: loadedConfig() });
    daemons.add(daemon);
    const run = runningRun(daemon);
    const record = daemon.terminalEndpoints.begin(run, 1);

    const starting = await daemon.app.inject({
      method: "GET",
      url: `${record.basePath}/token`,
      headers: { host: "portal.test" },
    });
    expect(starting.statusCode).toBe(503);
    expect(starting.json()).toMatchObject({ code: "terminal_endpoint_unavailable" });

    daemon.terminalEndpoints.publishReady(run.id, 1, upstreamPort);
    const status = await daemon.app.inject({
      method: "GET",
      url: `/api/runs/${encodeURIComponent(run.id)}/terminal`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      runId: run.id,
      provider: "ttyd",
      state: "ready",
      url: `${record.basePath}/`,
    });
    expect(status.body).not.toContain("127.0.0.1");
    expect(status.body).not.toContain(String(upstreamPort));

    const token = await daemon.app.inject({
      method: "GET",
      url: `${record.basePath}/token?asset=terminal`,
      headers: {
        host: "portal.test",
        origin: "http://portal.test",
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-forwarded-host": "attacker.test",
      },
    });
    expect(token.statusCode, token.body).toBe(200);
    expect(token.json()).toEqual({ path: `${record.basePath}/token?asset=terminal` });
    expect(upstreamRequest?.headers.host).toBe("portal.test");
    expect(upstreamRequest?.headers.origin).toBe("http://portal.test");
    expect(upstreamRequest?.headers.authorization).toBeUndefined();
    expect(upstreamRequest?.headers.cookie).toBeUndefined();
    expect(upstreamRequest?.headers["x-forwarded-host"]).toBeUndefined();

    expect(
      (
        await daemon.app.inject({
          method: "GET",
          url: `${record.basePath}/token/extra`,
          headers: { host: "portal.test" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await daemon.app.inject({
          method: "POST",
          url: `${record.basePath}/token`,
          headers: { host: "portal.test" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await daemon.app.inject({
          method: "GET",
          url: `${record.basePath}%2Ftoken`,
          headers: { host: "portal.test" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await daemon.app.inject({
          method: "GET",
          url: "/terminals/00000000000000000000000000000000/token",
          headers: { host: "portal.test" },
        })
      ).statusCode,
    ).toBe(404);

    daemon.store.updateRunStatus(run.id, "stopped");
    expect(
      (
        await daemon.app.inject({
          method: "GET",
          url: `${record.basePath}/token`,
          headers: { host: "portal.test" },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("proxies tty WebSocket frames with public origin headers and no credentials", async () => {
    let upgradeRequest: IncomingMessage | undefined;
    const upstreamHttp = createServer();
    const upstreamWs = new WebSocketServer({ noServer: true, handleProtocols: () => "tty" });
    upstreamHttp.on("upgrade", (request, socket, head) => {
      upgradeRequest = request;
      upstreamWs.handleUpgrade(request, socket, head, (connection) => {
        upstreamWs.emit("connection", connection, request);
      });
    });
    upstreamWs.on("connection", (connection) => {
      connection.send("upstream-ready");
      connection.on("message", (data, binary) => connection.send(data, { binary }));
    });
    const upstreamPort = await listen(upstreamHttp);
    const daemon = await createDaemon({ dataPath: ":memory:", loadedConfig: loadedConfig() });
    daemons.add(daemon);
    const run = runningRun(daemon);
    const record = await readyEndpoint(daemon, run, upstreamPort);
    const daemonAddress = await daemon.app.listen({ host: "127.0.0.1", port: 0 });
    const publicOrigin = daemonAddress.replace(/^ws:/, "http:");
    const rejected = new WebSocket(
      `${daemonAddress.replace(/^http:/, "ws:")}${record.basePath}/ws`,
      "tty",
      { origin: "http://attacker.test" },
    );
    const rejectedStatus = await new Promise<number>((resolve, reject) => {
      rejected.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      rejected.once("error", reject);
    });
    expect(rejectedStatus).toBe(403);

    const client = new WebSocket(
      `${daemonAddress.replace(/^http:/, "ws:")}${record.basePath}/ws?client=one`,
      "tty",
      {
        origin: publicOrigin,
        headers: { authorization: "Bearer secret", cookie: "session=secret" },
      },
    );

    const first = await new Promise<string>((resolve, reject) => {
      client.once("message", (data) => resolve(data.toString()));
      client.once("error", reject);
    });
    expect(first).toBe("upstream-ready");
    const echoed = new Promise<string>((resolve) =>
      client.once("message", (data) => resolve(data.toString())),
    );
    client.send("operator-input");
    expect(await echoed).toBe("operator-input");
    expect(upgradeRequest?.url).toBe(`${record.basePath}/ws?client=one`);
    expect(upgradeRequest?.headers.host).toBe(new URL(daemonAddress).host);
    expect(upgradeRequest?.headers.origin).toBe(publicOrigin);
    expect(upgradeRequest?.headers.authorization).toBeUndefined();
    expect(upgradeRequest?.headers.cookie).toBeUndefined();

    await new Promise<void>((resolve) => {
      client.once("close", () => resolve());
      client.close();
    });
    upstreamWs.close();
  });
});
