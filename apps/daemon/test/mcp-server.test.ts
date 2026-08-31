import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadNanasaConfig } from "../src/config-v2.js";
import { McpCredentialIssuer } from "../src/mcp-auth.js";
import {
  createDaemon as createDaemonBase,
  type DaemonContext,
  type DaemonOptions,
} from "../src/server.js";

const operatorToken = "configured-remote-operator-token-1234567890";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDaemon(options: DaemonOptions = {}) {
  const repository = mkdtempSync(join(tmpdir(), "nanasa-mcp-config-"));
  temporaryDirectories.push(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  mkdirSync(join(repository, ".nanasa"));
  writeFileSync(
    join(repository, ".nanasa", "config.yaml"),
    `version: 2
integrations:
  fixture:
    name: Fixture
    kind: opencode
    command: [node, --version]
roles:
  reviewer:
    name: Reviewer
groups: {}
`,
  );
  return createDaemonBase({ ...options, loadedConfig: loadNanasaConfig(repository) });
}

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
      ...(memberId === "sender" ? { roleId: "reviewer" } : {}),
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
  it("returns repository-path guidance when a tool message exceeds the UTF-8 limit", async () => {
    const { daemon, agentToken } = await createFixture();
    const response = await callTool(daemon, agentToken, "nanasa.send_dm", {
      recipientMemberId: "alpha",
      text: "x".repeat(1_048_577),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({ isError: true });
    expect(response.json().result.content[0].text).toContain("repository-relative path");
    await daemon.app.close();
  });

  it("initializes, lists tools, and rejects invalid Host, Origin, and bearer credentials", async () => {
    const { daemon, agentToken } = await createFixture();
    const initialized = await mcpRequest(daemon, operatorToken, "initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.body).toContain('"name":"nanasa"');
    expect(initialized.body).toContain("nanasa.list_members");

    const listed = await mcpRequest(daemon, operatorToken, "tools/list", {});
    expect(listed.statusCode).toBe(200);
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "nanasa.list_members",
      "nanasa.list_agent_statuses",
      "nanasa.get_agent_status",
      "nanasa.send_dm",
      "nanasa.send_multicast",
      "nanasa.broadcast_group",
      "nanasa.prompt_peer",
      "nanasa.get_action_result",
      "nanasa.wait_action",
      "nanasa.cancel_action",
      "nanasa.get_delivery",
      "nanasa.list_visible_history",
    ]);
    const agentTools = await mcpRequest(daemon, agentToken, "tools/list", {});
    expect(agentTools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(["nanasa.report_progress", "nanasa.list_own_waits"]),
    );

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

  it("limits delivery and history reads to messages visible to the authenticated group member", async () => {
    const { daemon, group, run, agentToken } = await createFixture();
    const sent = await callTool(daemon, agentToken, "nanasa.send_dm", {
      recipientMemberId: "alpha",
      text: "Visible outbound request",
    });
    const messageId = sent.json().result.structuredContent.message.id as string;

    const history = await callTool(daemon, agentToken, "nanasa.list_visible_history", {
      limit: 10,
    });
    expect(history.json().result.structuredContent.result).toMatchObject({
      groupId: group.id,
      messages: [
        {
          id: messageId,
          sender: { kind: "agent", memberId: run.memberId },
        },
      ],
    });

    const delivery = await callTool(daemon, agentToken, "nanasa.get_delivery", {
      messageId,
      recipientMemberId: "alpha",
    });
    expect(delivery.json().result.structuredContent.result).toEqual([
      expect.objectContaining({ messageId, recipientMemberId: "alpha" }),
    ]);

    await daemon.app.close();
  });

  it("derives agent identity, excludes its sender from broadcast, and rejects group override", async () => {
    const { daemon, run, agentToken } = await createFixture();
    const members = await callTool(daemon, agentToken, "nanasa.list_members", {});
    expect(members.json().result.structuredContent).toEqual({
      groupId: run.groupId,
      members: [
        {
          memberId: "alpha",
          alias: "alpha",
          agentType: "fixture",
          runStatus: "offline",
          isCaller: false,
        },
        {
          memberId: "beta",
          alias: "beta",
          agentType: "fixture",
          runStatus: "offline",
          isCaller: false,
        },
        {
          memberId: "sender",
          alias: "sender",
          agentType: "fixture",
          roleId: "reviewer",
          roleName: "Reviewer",
          runStatus: "starting",
          isCaller: true,
        },
      ],
    });
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
    const selfDirect = await callTool(daemon, agentToken, "nanasa.send_dm", {
      recipientMemberId: "sender",
      text: "Do not loop this back",
    });
    expect(selfDirect.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "Agents cannot send direct or multicast messages to themselves" }],
      },
    });
    const selfMulticast = await callTool(daemon, agentToken, "nanasa.send_multicast", {
      recipientMemberIds: ["sender", "alpha"],
      text: "Do not include me",
    });
    expect(selfMulticast.json()).toMatchObject({ result: { isError: true } });
    const impersonated = await callTool(daemon, agentToken, "nanasa.send_dm", {
      recipientMemberId: "alpha",
      text: "No caller-selected sender",
      sender: { kind: "operator", operatorId: "forged" },
    });
    expect(impersonated.json()).toMatchObject({ result: { isError: true } });
    expect(daemon.store.getSnapshot().messages).toHaveLength(1);
    await daemon.app.close();
  });

  it("exposes group statuses and records only agent-authored progress", async () => {
    const { daemon, run, agentToken } = await createFixture();
    const listed = await callTool(daemon, agentToken, "nanasa.list_agent_statuses", {});
    expect(listed.json().result.structuredContent).toMatchObject({
      groupId: run.groupId,
      statuses: [
        { memberId: "alpha", state: "unknown" },
        { memberId: "beta", state: "unknown" },
        {
          memberId: "sender",
          roleId: "reviewer",
          roleName: "Reviewer",
          state: "starting",
        },
      ],
    });
    const detail = await callTool(daemon, agentToken, "nanasa.get_agent_status", {
      memberId: "sender",
    });
    expect(detail.json().result.structuredContent.status).toMatchObject({
      memberId: "sender",
      state: "starting",
      evidence: [{ kind: "spawn.requested" }],
    });

    const progress = await callTool(daemon, agentToken, "nanasa.report_progress", {
      stage: "implementation",
      summary: "Status APIs implemented",
      nextStep: "Add reporters",
    });
    expect(progress.json().result.structuredContent.status).toMatchObject({
      memberId: "sender",
      state: "working",
      progressStage: "implementation",
      lastProgressSummary: "Status APIs implemented",
    });
    const rejected = await callTool(daemon, operatorToken, "nanasa.report_progress", {
      stage: "forged",
      summary: "Operator cannot impersonate an agent",
    });
    expect(rejected.json()).toMatchObject({
      error: { code: -32602, message: "Tool nanasa.report_progress not found" },
    });
    await daemon.app.close();
  });

  it("authenticates and deduplicates reporter events without accepting caller identity", async () => {
    const { daemon, agentToken, run } = await createFixture();
    daemon.store.registerReporterSession({
      id: "reporter-mcp",
      providerId: "fixture",
      adapterId: "opencode",
      reporterId: "opencode-plugin",
      source: "opencode",
      protocolVersion: 2,
      reporterVersion: "2",
      runId: run.id,
      generation: run.generation,
      reporterEpoch: "epoch-mcp",
      readinessCoverage: "full",
      sourceSequence: 0,
      openedAt: "2026-08-29T12:00:00.000Z",
      leaseExpiresAt: "2099-08-29T12:00:00.000Z",
    });
    daemon.store.bindReporterProcess(run.id, run.generation, "a".repeat(64));
    daemon.store.recordProcessStatus(run.id, {
      event: "process.alive",
      eventId: "reporter-mcp-process",
      observedAt: new Date().toISOString(),
      process: {
        foregroundPgid: 10,
        leaderPid: 10,
        pidStartIdentity: "10:100",
        executableFingerprint: "b".repeat(64),
        argvFingerprint: "c".repeat(64),
        processFingerprint: "a".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["opencode"],
      },
    });
    const payload = {
      version: 2,
      eventId: "session-ready-1",
      providerId: "fixture",
      adapterId: "opencode",
      reporterId: "opencode-plugin",
      source: "opencode",
      protocolVersion: 2,
      reporterVersion: "2",
      runId: run.id,
      generation: run.generation,
      reporterEpoch: "epoch-mcp",
      sourceSequence: 1,
      event: "session.ready",
      data: {},
    };
    const submit = (token: string, body: unknown) =>
      daemon.app.inject({
        method: "POST",
        url: "/api/v1/agent-status/events",
        headers: {
          host: "127.0.0.1:3210",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: body,
      });

    expect(await submit(agentToken, payload)).toMatchObject({ statusCode: 202 });
    const duplicate = await submit(agentToken, payload);
    expect(duplicate).toMatchObject({ statusCode: 409 });
    expect(duplicate.json()).toMatchObject({ code: "status_sequence_reordered" });
    expect((await submit(operatorToken, payload)).statusCode).toBe(403);
    expect(
      (
        await submit(agentToken, {
          ...payload,
          eventId: "forged-identity",
          runId: "another-run",
        })
      ).statusCode,
    ).toBe(409);
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
