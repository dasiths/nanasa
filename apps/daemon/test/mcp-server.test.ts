import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { McpCredentialIssuer } from "../src/mcp-auth.js";
import { createDaemon, type DaemonContext } from "../src/server.js";

const operatorToken = "configured-remote-operator-token-1234567890";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-mcp-server-"));
  temporaryDirectories.push(directory);
  const secretPath = join(directory, "mcp-secret");
  const daemon = await createDaemon({
    dataPath: ":memory:",
    runtimePath: join(directory, "runtime"),
    mcp: {
      enabled: true,
      endpointUrl: "http://127.0.0.1:3210/mcp",
      allowedHostnames: ["127.0.0.1"],
      operatorToken,
      secretPath,
    },
  });
  const group = daemon.store.createGroup({ name: "MCP tools" });
  const profile = daemon.store.createInternalAgentProfile({
    name: "Fixture",
    agentType: "fixture",
    kind: "opencode",
    command: "node",
    args: ["--version"],
    environment: {},
  });
  for (const memberId of ["sender", "alpha", "beta"]) {
    daemon.store.addMembership(group.id, {
      memberId,
      agentProfileId: profile.id,
      alias: memberId,
    });
  }
  const run = daemon.store.createRunForMembership(group.id, "sender").run;
  const agentToken = new McpCredentialIssuer(daemon.store, { secretPath }).issueAgent(run);
  return { daemon, group, run, agentToken };
}

async function mcpRequest(
  daemon: DaemonContext,
  token: string | undefined,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const modern = method !== "initialize";
  return daemon.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1:3210",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(modern ? { "mcp-protocol-version": "2026-07-28" } : {}),
      ...(modern ? { "mcp-method": method } : {}),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern
        ? {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          }
        : params,
    },
  });
}

async function callTool(
  daemon: DaemonContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  return mcpRequest(daemon, token, "tools/call", { name, arguments: args }, { "mcp-name": name });
}

describe("Streamable HTTP MCP", () => {
  it("initializes, lists tools, and rejects invalid Host, Origin, and bearer credentials", async () => {
    const { daemon } = await createFixture();
    const initialized = await mcpRequest(daemon, operatorToken, "initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.body).toContain('"name":"nanasa"');

    const listed = await mcpRequest(daemon, operatorToken, "tools/list", {});
    expect(listed.statusCode).toBe(200);
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "nanasa.send_dm",
      "nanasa.send_multicast",
      "nanasa.broadcast_group",
    ]);

    expect((await mcpRequest(daemon, undefined, "tools/list", {})).statusCode).toBe(401);
    expect((await mcpRequest(daemon, "wrong-token", "tools/list", {})).statusCode).toBe(401);
    expect(
      (await mcpRequest(daemon, operatorToken, "tools/list", {}, { host: "attacker.test" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await mcpRequest(
          daemon,
          operatorToken,
          "tools/list",
          {},
          {
            origin: "https://attacker.test",
          },
        )
      ).statusCode,
    ).toBe(403);
    expect((await daemon.app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(405);
    await daemon.app.close();
  });

  it("maps operator DM and multicast tools to durable terminal submissions", async () => {
    const { daemon, group } = await createFixture();
    const direct = await callTool(daemon, operatorToken, "nanasa.send_dm", {
      groupId: group.id,
      recipientMemberId: "alpha",
      text: "Direct request",
    });
    expect(direct.statusCode).toBe(200);
    expect(direct.json()).toMatchObject({
      result: {
        structuredContent: {
          message: {
            groupId: group.id,
            sender: { kind: "operator", operatorId: "remote-operator" },
            audience: { kind: "dm", memberId: "alpha" },
            delivery: {},
          },
          deliveryOutcomes: [{ recipientMemberId: "alpha", status: "queued" }],
        },
      },
    });

    const multicast = await callTool(daemon, operatorToken, "nanasa.send_multicast", {
      groupId: group.id,
      recipientMemberIds: ["alpha", "beta"],
      text: "Multicast request",
      contentType: "text/plain",
    });
    expect(multicast.json().result.structuredContent).toMatchObject({
      message: { audience: { kind: "multicast", memberIds: ["alpha", "beta"] } },
      deliveryOutcomes: [
        { recipientMemberId: "alpha", status: "queued" },
        { recipientMemberId: "beta", status: "queued" },
      ],
    });
    await daemon.app.close();
  });

  it("derives agent identity, excludes its sender from broadcast, and rejects group override", async () => {
    const { daemon, run, agentToken } = await createFixture();
    const broadcast = await callTool(daemon, agentToken, "nanasa.broadcast_group", {
      text: "Review this together",
    });
    expect(broadcast.statusCode).toBe(200);
    expect(broadcast.json().result.structuredContent).toMatchObject({
      message: {
        sender: { kind: "agent", memberId: "sender", runId: run.id },
        audience: { kind: "group", membershipRevision: 3 },
      },
      deliveryOutcomes: [
        { recipientMemberId: "alpha", status: "queued" },
        { recipientMemberId: "beta", status: "queued" },
      ],
    });
    expect(
      broadcast
        .json()
        .result.structuredContent.deliveryOutcomes.map(
          (outcome: { recipientMemberId: string }) => outcome.recipientMemberId,
        ),
    ).not.toContain("sender");

    const forbidden = await callTool(daemon, agentToken, "nanasa.send_dm", {
      groupId: "another-group",
      recipientMemberId: "alpha",
      text: "No impersonation",
    });
    expect(forbidden.json()).toMatchObject({ result: { isError: true } });
    const impersonated = await callTool(daemon, agentToken, "nanasa.send_dm", {
      recipientMemberId: "alpha",
      text: "No caller-selected sender",
      sender: { kind: "operator", operatorId: "forged" },
    });
    expect(impersonated.json()).toMatchObject({ result: { isError: true } });
    expect(daemon.store.getSnapshot().messages).toHaveLength(1);
    await daemon.app.close();
  });

  it("revokes agent HTTP access for stopped generations", async () => {
    const { daemon, run, agentToken } = await createFixture();
    daemon.store.updateRunStatus(run.id, "stopping");
    const response = await mcpRequest(daemon, agentToken, "tools/list", {});
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "mcp_credential_revoked" });
    await daemon.app.close();
  });

  it("rate limits each authenticated principal", async () => {
    const { daemon } = await createFixture();
    for (let request = 0; request < 30; request += 1) {
      expect((await mcpRequest(daemon, operatorToken, "tools/list", {})).statusCode).toBe(200);
    }
    const limited = await mcpRequest(daemon, operatorToken, "tools/list", {});
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "mcp_rate_limited" });
    await daemon.app.close();
  });

  it("requires a strong operator credential for non-loopback MCP endpoints", async () => {
    await expect(
      createDaemon({
        dataPath: ":memory:",
        mcp: { enabled: true, endpointUrl: "https://nanasa.example/mcp" },
      }),
    ).rejects.toThrow("operator token is required");
    await expect(
      createDaemon({
        dataPath: ":memory:",
        mcp: {
          enabled: true,
          endpointUrl: "https://nanasa.example/mcp",
          operatorToken: "too-short",
        },
      }),
    ).rejects.toThrow("at least 32 characters");
  });

  it("requires HTTPS for external advertised MCP endpoints", async () => {
    await expect(
      createDaemon({
        dataPath: ":memory:",
        mcp: {
          enabled: true,
          endpointUrl: "http://nanasa.example/mcp",
          operatorToken,
        },
      }),
    ).rejects.toThrow("must use HTTPS");

    const directory = mkdtempSync(join(tmpdir(), "nanasa-mcp-external-"));
    temporaryDirectories.push(directory);
    const daemon = await createDaemon({
      dataPath: ":memory:",
      runtimePath: join(directory, "runtime"),
      mcp: {
        enabled: true,
        endpointUrl: "https://nanasa.example/mcp",
        operatorToken,
        secretPath: join(directory, "mcp-secret"),
      },
    });
    await daemon.app.close();
  });
});
