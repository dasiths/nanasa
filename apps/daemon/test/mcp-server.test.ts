import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForemanCleanupRequestSchema,
  ForemanConfigSchema,
  NanasaConfigSchema,
} from "@nanasa/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as browserVerifier from "../src/browser-candidate-verifier.js";
import { loadNanasaConfig } from "../src/config-loader.js";
import {
  NANASA_FOREMAN_INSTRUCTIONS,
  nanasaMcpServerInstructions,
} from "../src/coordination-instructions.js";
import {
  foremanBootstrapContext,
  foremanDiscoveryContext,
  foremanTurnContext,
} from "../src/foreman-context.js";
import { McpCredentialIssuer } from "../src/mcp-auth.js";
import type { McpPrincipal } from "../src/mcp-auth.js";
import { ForemanCleanupService } from "../src/foreman-cleanup-service.js";
import { ForemanGoalService } from "../src/foreman-goal-service.js";
import { type ControlRouterServices, registerControlRouter } from "../src/http/control-router.js";
import { MCP_TOOL_REGISTRY, mcpTool } from "../src/mcp/tool-registry.js";
import { type McpRouteOptions, registerMcpRoutes } from "../src/mcp-server.js";
import { DomainError, NanasaStore } from "../src/store.js";
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
  return { daemon, group, run, agentToken, secretPath };
}

async function mcpRequest(
  daemon: Pick<DaemonContext, "app">,
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
  daemon: Pick<DaemonContext, "app">,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  return mcpRequest(daemon, token, "tools/call", { name, arguments: args }, { "mcp-name": name });
}

describe("scoped browser verification MCP", () => {
  it("advertises only to agents and routes exact scoped observations without submitting a report", async () => {
    const { daemon, agentToken, run, group } = await createFixture();
    try {
      const listed = (await mcpRequest(daemon, agentToken, "tools/list", {})).json().result.tools;
      expect(listed.map((tool: { name: string }) => tool.name).sort()).toEqual(
        MCP_TOOL_REGISTRY.filter((tool) => tool.principals.includes("agent"))
          .map((tool) => tool.name)
          .sort(),
      );
      const declaration = listed.find(
        (tool: { name: string }) => tool.name === "nanasa.verify_browser_candidate",
      );
      expect(declaration.description).toBe(mcpTool("nanasa.verify_browser_candidate").description);
      expect(declaration.inputSchema.additionalProperties).toBe(false);
      expect(declaration.inputSchema.properties.actions.maxItems).toBe(10);
      const report = vi.spyOn(daemon.goals, "report");
      const scope = vi.spyOn(daemon.goals, "browserCandidate").mockReturnValue({
        checkoutId: "checkout",
        root: "/unserved-test-scope",
        candidatePath: "examples/project/src",
        candidateDigest: "digest",
      });
      const evidence = {
        status: "observed",
        unchanged: true,
        beforeDigest: "digest",
        afterDigest: "digest",
        observations: [],
      };
      const verify = vi
        .spyOn(browserVerifier, "verifyBrowserCandidate")
        .mockImplementation(async (_input, authorize) => {
          authorize();
          return evidence as Awaited<ReturnType<typeof browserVerifier.verifyBrowserCandidate>>;
        });
      const input = { delegationId: "owned", candidatePath: "examples/project/src" };
      const response = (
        await callTool(daemon, agentToken, "nanasa.verify_browser_candidate", input)
      ).json().result;
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent.result).toEqual(evidence);
      expect(JSON.parse(response.content[0].text)).toEqual(evidence);
      expect(scope).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "agent",
          groupId: group.id,
          memberId: run.memberId,
          runId: run.id,
          generation: run.generation,
        }),
        "owned",
        input.candidatePath,
      );
      expect(verify.mock.calls[0]![0]).toMatchObject({
        entry: "index.html",
        viewports: [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ],
        actions: [],
      });
      scope.mockImplementation(() => {
        throw new DomainError("delegation_forbidden", "Wrong team", 403);
      });
      const denied = (
        await callTool(daemon, agentToken, "nanasa.verify_browser_candidate", input)
      ).json().result;
      expect(denied).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "delegation_forbidden", effect: "none" } },
      });
      const operator = await callTool(
        daemon,
        operatorToken,
        "nanasa.verify_browser_candidate",
        input,
      );
      expect(operator.json().error ?? operator.json().result?.isError).toBeTruthy();
      expect(verify).toHaveBeenCalledTimes(2);
      expect(report).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await daemon.app.close();
    }
  });
});

describe("Foreman goal proposal MCP contract", () => {
  it("advertises source meanings, corrects rejected linkage and preserves uncertain async effects", async () => {
    const { daemon, secretPath, group } = await createFixture();
    try {
      await daemon.foreman.configure(
        ForemanConfigSchema.parse({
          id: "foreman",
          integrationId: "fixture",
          enabled: true,
          autonomy: { maxActiveGoals: 2 },
        }),
        daemon.foreman.status().configRevision!,
      );
      const sourceCheckout = daemon.store.getEffectiveGroupCheckout(group.id)!;
      const requestDirectory = join(sourceCheckout.path, "examples/multi-coding-agents");
      mkdirSync(requestDirectory, { recursive: true });
      const profile = daemon.store.createInternalAgentProfile({
        name: "Foreman",
        agentType: "fixture",
        kind: "opencode",
        command: "node",
        args: [],
        environment: {},
        workingDirectory: requestDirectory,
      });
      daemon.store.upsertForeman({ id: "foreman", agentProfileId: profile.id, enabled: true });
      const { run } = daemon.store.createRunForForeman("foreman");
      const token = new McpCredentialIssuer(daemon.store, { secretPath }).issueForeman(run);
      const proposal = "nanasa.foreman_propose_goal";
      const listed = (await mcpRequest(daemon, token, "tools/list", {})).json().result.tools;
      const declaration = listed.find((tool: { name: string }) => tool.name === proposal);
      expect(declaration.description).toBe(mcpTool(proposal).description);
      expect(declaration.inputSchema.properties).not.toHaveProperty("requestOrigin");
      expect(declaration.inputSchema.properties).not.toHaveProperty("sourceText");
      expect(declaration.description).toContain("same requestId");
      expect(declaration.inputSchema.properties.sourceMessageId.description).toContain(
        "stored Human",
      );
      expect(declaration.inputSchema.properties.sourceConversationIds.description).toContain(
        "not channel message IDs",
      );
      const source = daemon.store.sendForemanMessage(
        { kind: "operator", operatorId: "human" },
        {
          requestId: "solar-source",
          text: "create browser based solar system simulator in ./src dir",
        },
      );
      const command = {
        requestId: "solar-goal",
        title: "Build browser solar system simulator",
        objective: "Create browser based solar system simulator in ./src dir",
        sourceMessageId: source.id,
        sourceConversationIds: [source.id],
      };
      const rejected = (await callTool(daemon, token, proposal, command)).json().result;
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "foreman_goal_source_conversation_invalid",
            statusCode: 400,
            effect: "none",
            retry: "correct-input",
            details: { field: "sourceConversationIds", index: 0 },
            nextAction: expect.stringContaining("same requestId"),
          },
        },
      });
      expect(rejected.content[0].text).toContain("Effect: none; retry: correct-input");
      expect(rejected.content[0].text).toContain("Keep the verified Human sourceMessageId");
      expect(daemon.goals.list()).toEqual([]);
      const corrected = { ...command, sourceConversationIds: null };
      const created = (await callTool(daemon, token, proposal, corrected)).json().result;
      expect(created.isError).not.toBe(true);
      const goal = created.structuredContent.result;
      expect(goal.sourceMessageId).toBe(source.id);
      expect(goal.sourceText).toBe(source.text);
      expect(goal.requestOrigin).toEqual({
        repositoryId: sourceCheckout.repositoryId,
        checkoutId: sourceCheckout.id,
        workingDirectory: "examples/multi-coding-agents",
        source: "foreman-run",
      });
      const workspace = (
        await callTool(daemon, token, "nanasa.foreman_get_goal", { goalId: goal.id })
      ).json().result.structuredContent.result;
      expect(workspace.requestContext).toContain(requestDirectory);
      expect(workspace.requestContext).toContain(source.text);
      expect(goal).not.toHaveProperty("sourceConversationIds");
      const omitted = {
        requestId: command.requestId,
        title: command.title,
        objective: command.objective,
        sourceMessageId: command.sourceMessageId,
      };
      expect((await callTool(daemon, token, proposal, omitted)).json().result).toEqual(created);
      const conflict = (
        await callTool(daemon, token, proposal, { ...omitted, title: "Different goal" })
      ).json().result;
      expect(conflict.structuredContent.error).toMatchObject({
        code: "foreman_goal_conflict",
        effect: "unconfirmed",
        retry: "inspect-first",
      });
      const reply = (
        await callTool(daemon, token, "nanasa.foreman_reply", {
          requestId: "source-reply",
          replyTo: source.id,
          text: "Acknowledged",
        })
      ).json().result.structuredContent.result;
      for (const sourceMessageId of ["fm_missing", reply.id]) {
        const invalid = (
          await callTool(daemon, token, proposal, {
            ...omitted,
            requestId: "invalid-source",
            sourceMessageId,
          })
        ).json().result;
        expect(invalid.structuredContent.error).toMatchObject({
          code: "foreman_goal_source_message_invalid",
          effect: "none",
          retry: "correct-input",
          nextAction: expect.stringContaining("Do not fabricate a source or omit it"),
        });
      }
      const tui = { requestId: "native-tui", title: "Native request", objective: "Native request" };
      const native = (
        await callTool(daemon, token, proposal, {
          ...tui,
          sourceMessageId: null,
          sourceConversationIds: null,
        })
      ).json().result;
      expect(native.isError).not.toBe(true);
      expect(native.structuredContent.result).not.toHaveProperty("sourceMessageId");
      expect(native.structuredContent.result).not.toHaveProperty("sourceText");
      expect(native.structuredContent.result.requestOrigin).toEqual(goal.requestOrigin);
      expect(native.structuredContent.result).not.toHaveProperty("sourceConversationIds");
      expect((await callTool(daemon, token, proposal, tui)).json().result).toEqual(native);
      expect(daemon.goals.list()).toHaveLength(2);
      const assign = {
        requestId: "async-assignment",
        goalId: goal.id,
        groupId: group.id,
        memberId: "alpha",
        brief: "Implement simulator",
      };
      const orchestration = vi.spyOn(daemon.orchestration, "assignOutcome");
      try {
        orchestration.mockRejectedValueOnce(
          new DomainError("foreman_preparation_conflict", "Inspect persisted preparation", 409),
        );
        const uncertain = (
          await callTool(daemon, token, "nanasa.foreman_assign_outcome", assign)
        ).json().result;
        expect(uncertain).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              code: "foreman_preparation_conflict",
              effect: "unconfirmed",
              retry: "inspect-first",
            },
          },
        });
        orchestration.mockRejectedValueOnce(new Error("private diagnostic"));
        const unexpected = (
          await callTool(daemon, token, "nanasa.foreman_assign_outcome", assign)
        ).json().result;
        expect(unexpected.structuredContent.error).toMatchObject({
          code: "coordination_failed",
          effect: "unconfirmed",
          retry: "inspect-first",
        });
        expect(JSON.stringify(unexpected)).not.toContain("private diagnostic");
      } finally {
        orchestration.mockRestore();
      }
    } finally {
      await daemon.app.close();
    }
  });
});

describe("isolated cleanup MCP consent", () => {
  it("allows only requests from Foreman and exact approval from the operator", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-cleanup-mcp-"));
    temporaryDirectories.push(directory);
    const store = new NanasaStore(join(directory, "state.sqlite"));
    const app = Fastify();
    const config = NanasaConfigSchema.parse({ version: 2, integrations: {}, groups: {} });
    const goals = new ForemanGoalService(store, () => config);
    const cleanup = new ForemanCleanupService(store, goals);
    const principals: Record<string, McpPrincipal> = {
      "Bearer test-foreman": {
        kind: "foreman",
        foremanId: "foreman",
        runId: "run",
        generation: 1,
        authorityRevision: 0,
      },
      "Bearer test-agent": {
        kind: "agent",
        groupId: "team",
        memberId: "member",
        runId: "member-run",
        generation: 1,
      },
      "Bearer test-operator": { kind: "operator", operatorId: "remote-operator" },
    };
    registerMcpRoutes(app, {
      path: "/mcp",
      endpointUrl: "http://127.0.0.1:3210/mcp",
      allowedHostnames: ["127.0.0.1"],
      store,
      goals,
      credentials: {
        authenticate: (header: string) => {
          const principal = principals[header];
          if (!principal)
            throw new DomainError("mcp_unauthorized", "Fixture principal required", 401);
          return principal;
        },
      },
    } as unknown as McpRouteOptions);
    registerControlRouter(app, {
      store,
      goals,
      auth: {
        authenticate: (request: { headers: Record<string, string> }) => {
          if (request.headers.authorization !== "Bearer test-human")
            throw new DomainError("operator_unauthorized", "Operator required", 401);
          return { operatorId: "human" };
        },
      },
    } as unknown as ControlRouterServices);
    try {
      const message = store.sendForemanMessage(
        { kind: "operator", operatorId: "human" },
        { requestId: "source", text: "Original Human input" },
      );
      const command = {
        requestId: "cleanup-one",
        scope: "channel",
        throughSequence: message.sequence,
      };
      for (const token of ["test-agent", "test-operator"]) {
        const listed = (await mcpRequest({ app }, token, "tools/list", {})).json();
        expect(listed.result.tools.map((tool: { name: string }) => tool.name)).not.toContain(
          "nanasa.foreman_request_cleanup",
        );
        const forbidden = (
          await callTool({ app }, token, "nanasa.foreman_request_cleanup", command)
        ).json();
        expect(forbidden.error ?? forbidden.result?.isError).toBeTruthy();
      }
      const listed = (await mcpRequest({ app }, "test-foreman", "tools/list", {})).json();
      const declaration = listed.result.tools.find(
        (tool: { name: string }) => tool.name === "nanasa.foreman_request_cleanup",
      );
      expect(declaration.inputSchema.type).toBe("object");
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain(
        "nanasa.foreman_read_cleanup_requests",
      );
      const invalid = (
        await callTool({ app }, "test-foreman", "nanasa.foreman_request_cleanup", {
          ...command,
          confirmation: true,
        })
      ).json();
      expect(invalid.error ?? invalid.result?.isError).toBeTruthy();
      expect(cleanup.requests()).toEqual([]);
      const submitted = (
        await callTool({ app }, "test-foreman", "nanasa.foreman_request_cleanup", command)
      ).json();
      const pending = ForemanCleanupRequestSchema.parse(submitted.result.structuredContent.result);
      expect(pending.state).toBe("pending");
      expect(
        (await callTool({ app }, "test-foreman", "nanasa.foreman_read_cleanup_requests", {})).json()
          .result.structuredContent.result,
      ).toEqual([pending]);
      const approval = { id: pending.id, digest: pending.digest, confirmation: true };
      const forbiddenTool = (
        await callTool({ app }, "test-foreman", "nanasa.foreman_approve_cleanup", approval)
      ).json();
      expect(forbiddenTool.error ?? forbiddenTool.result?.isError).toBeTruthy();
      for (const [url, payload] of [
        ["/api/v1/foreman/cleanup/approve", approval],
        ["/api/v1/foreman/cleanup", { ...command, confirmation: true }],
      ] as const) {
        const denied = await app.inject({
          method: "POST",
          url,
          headers: { authorization: "Bearer test-foreman" },
          payload,
        });
        expect(denied.statusCode).toBe(401);
      }
      expect(store.readForemanChannel({ after: 0, limit: 100 }).messages).toHaveLength(1);
      expect(goals.list()).toEqual([]);
      const headers = { authorization: "Bearer test-human" };
      expect(
        (
          await app.inject({ method: "GET", url: "/api/v1/foreman/cleanup/requests", headers })
        ).json(),
      ).toEqual([pending]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/foreman/cleanup/approve",
            headers,
            payload: { ...approval, digest: "0".repeat(64) },
          })
        ).statusCode,
      ).toBe(409);
      const approved = await app.inject({
        method: "POST",
        url: "/api/v1/foreman/cleanup/approve",
        headers,
        payload: approval,
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({
        state: "approved",
        operatorId: "human",
        result: { retained: true, messagesCleared: 1 },
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/foreman/cleanup/approve",
            headers,
            payload: approval,
          })
        ).json(),
      ).toEqual(approved.json());
      expect(
        (
          await callTool({ app }, "test-foreman", "nanasa.foreman_read_cleanup_requests", {
            id: pending.id,
          })
        ).json().result.structuredContent.result,
      ).toEqual([approved.json()]);
      expect(
        (await callTool({ app }, "test-foreman", "nanasa.foreman_read_channel", {})).json().result
          .structuredContent.result.messages,
      ).toEqual([]);
      expect(
        (
          await callTool({ app }, "test-foreman", "nanasa.foreman_read_channel", {
            messageId: message.id,
          })
        ).json().result.structuredContent.result.messages[0],
      ).toMatchObject({ id: message.id, cleared: true });
    } finally {
      await app.close();
      store.close();
    }
  });

  it("advertises strict scoped requests with no model-supplied consent or purge", () => {
    const schema = mcpTool("nanasa.foreman_request_cleanup").inputSchema;
    for (const command of [
      { requestId: "channel", scope: "channel", throughSequence: 0 },
      { requestId: "goal", scope: "goal", goal: { id: "one", expectedRevision: 1 }, cancel: true },
      {
        requestId: "finished",
        scope: "finished-goals",
        goals: [{ id: "one", expectedRevision: 1 }],
      },
    ]) {
      expect(schema.safeParse(command).success).toBe(true);
      for (const extra of [
        { confirmation: true },
        { operatorId: "human" },
        { digest: "a".repeat(64) },
        { purge: true },
      ])
        expect(schema.safeParse({ ...command, ...extra }).success).toBe(false);
    }
    expect(schema.safeParse({ requestId: "all", scope: "all" }).success).toBe(false);
    expect(schema.safeParse({ requestId: "missing-cutoff", scope: "channel" }).success).toBe(false);
  });
});

describe("Streamable HTTP MCP", () => {
  it("omits null peer fences before binding the current target", async () => {
    const { daemon, agentToken, group } = await createFixture();
    try {
      const create = vi.spyOn(daemon.actions, "create").mockImplementation(() => {
        throw new Error("Fixture action reached");
      });
      await callTool(daemon, agentToken, "nanasa.prompt_peer", {
        groupId: group.id,
        memberId: "alpha",
        prompt: "Review the candidate",
        idempotencyKey: "null-fences",
        expectedRunId: null,
        expectedGeneration: null,
        expectedStatusRevision: null,
      });
      expect(create).toHaveBeenCalledOnce();
      const command = create.mock.calls[0]![1];
      expect(command).not.toHaveProperty("expectedRunId");
      expect(command).not.toHaveProperty("expectedGeneration");
      expect(command).not.toHaveProperty("expectedStatusRevision");
      expect(command).toMatchObject({
        kind: "prompt",
        groupId: group.id,
        memberId: "alpha",
        allowWorking: false,
      });
    } finally {
      await daemon.app.close();
    }
  });

  it("treats null history cursors as absent but rejects two real cursors", async () => {
    const { daemon, agentToken, group } = await createFixture();
    try {
      const latest = await callTool(daemon, agentToken, "nanasa.list_visible_history", {
        groupId: group.id,
        before: null,
        after: null,
      });
      expect(latest.json().result.isError).not.toBe(true);
      const conflicting = await callTool(daemon, agentToken, "nanasa.list_visible_history", {
        groupId: group.id,
        before: 1,
        after: 2,
      });
      expect(conflicting.json().result.isError).toBe(true);
      expect(conflicting.json().result.content[0].text).toContain("mutually exclusive");
    } finally {
      await daemon.app.close();
    }
  });

  it("records explicit no-blocker progress without requiring input", async () => {
    const { daemon, agentToken } = await createFixture();
    try {
      for (const blocker of [undefined, null, "", "none", " NoNe "]) {
        const blocked = (
          await callTool(daemon, agentToken, "nanasa.report_progress", {
            stage: "validation",
            summary: "Waiting for credentials",
            blocker: "None of the providers are available",
          })
        ).json().result;
        expect(blocked.structuredContent.status).toMatchObject({
          attention: "input_required",
          blocker: "None of the providers are available",
        });
        const cleared = (
          await callTool(daemon, agentToken, "nanasa.report_progress", {
            stage: "validation",
            summary: "Tests running",
            blocker,
          })
        ).json().result;
        expect(cleared.isError).not.toBe(true);
        expect(cleared.structuredContent.status).toMatchObject({
          state: "working",
          attention: "none",
        });
        expect(cleared.structuredContent.status.blocker).toBeUndefined();
      }
    } finally {
      await daemon.app.close();
    }
  });

  it("omits null candidate properties before canonical report serialization", async () => {
    const { daemon, agentToken, group } = await createFixture();
    try {
      vi.spyOn(daemon.goals, "own").mockReturnValue([
        { delegations: [{ id: "owned", groupId: group.id }] },
      ] as ReturnType<typeof daemon.goals.own>);
      const report = vi.spyOn(daemon.goals, "report").mockImplementation(() => {
        throw new Error("Fixture report reached");
      });
      await callTool(daemon, agentToken, "nanasa.report_delegation", {
        requestId: "nullable-owned",
        delegationId: "owned",
        kind: "accepted",
        summary: "Accept ownership",
        evidence: [],
        reviewOutcome: null,
        candidateHead: null,
        candidatePath: null,
      });
      expect(report).toHaveBeenCalledOnce();
      expect(report.mock.calls[0]![1]).toStrictEqual({
        requestId: "nullable-owned",
        delegationId: "owned",
        kind: "accepted",
        summary: "Accept ownership",
        evidence: [],
        nextCheckSeconds: 900,
      });
    } finally {
      await daemon.app.close();
    }
  });

  it("accepts null candidate fields from strict tool callers before enforcing report ownership", async () => {
    const { daemon, agentToken } = await createFixture();
    try {
      const response = await callTool(daemon, agentToken, "nanasa.report_delegation", {
        requestId: "nullable-report",
        delegationId: "not-owned",
        kind: "accepted",
        summary: "Accept ownership",
        evidence: [],
        candidateHead: null,
        candidatePath: null,
      });
      expect(response.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "delegation_forbidden",
            statusCode: 403,
            effect: "none",
            retry: "inspect-first",
            nextAction: expect.stringContaining("No report was submitted by this call"),
          },
        },
      });
      expect(response.json().result.content[0].text).toContain(
        "Delegation is not owned by this team",
      );
    } finally {
      await daemon.app.close();
    }
  });

  it("preserves report rejection metadata but keeps unknown report effects unconfirmed", async () => {
    const { daemon, agentToken, group } = await createFixture();
    try {
      vi.spyOn(daemon.goals, "own").mockReturnValue([
        { delegations: [{ id: "owned", groupId: group.id, checkoutId: "checkout-owned" }] },
      ] as ReturnType<typeof daemon.goals.own>);
      const refresh = vi.spyOn(daemon.checkouts, "refresh").mockResolvedValue(undefined as never);
      const report = vi.spyOn(daemon.goals, "report");
      const input = {
        requestId: "negative-review",
        delegationId: "owned",
        kind: "review",
        reviewOutcome: "changes-required",
        summary: "P1 findings; not ready",
        evidence: ["src/index.html: missing controls"],
        candidateHead: null,
        candidatePath: "src",
      };
      for (const reviewOutcome of [undefined, null]) {
        const missing = (
          await callTool(daemon, agentToken, "nanasa.report_delegation", {
            ...input,
            reviewOutcome,
          })
        ).json().result;
        expect(missing).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              effect: "none",
              retry: "correct-input",
              nextAction: expect.stringContaining("reviewOutcome approved or changes-required"),
            },
          },
        });
        expect(missing.structuredContent.error.nextAction).toContain("same requestId");
      }
      expect(refresh).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      const details = {
        candidatePath: "src",
        fileSystemCode: "ENOENT",
        expectedCandidatePath: "examples/multi-coding-agents/src",
        effect: "none",
        retry: "correct-input",
        nextAction: "Verify the exact candidate and resubmit with the same requestId.",
      };
      report.mockImplementationOnce(() => {
        throw new DomainError(
          "foreman_candidate_unavailable",
          "Candidate files unavailable",
          409,
          details,
        );
      });
      const rejected = (
        await callTool(daemon, agentToken, "nanasa.report_delegation", input)
      ).json().result;
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "foreman_candidate_unavailable",
            statusCode: 409,
            effect: "none",
            retry: "correct-input",
            details,
            nextAction: details.nextAction,
          },
        },
      });
      expect(rejected.content[0].text).toContain("Effect: none; retry: correct-input");
      expect(rejected.content[0].text).toContain(details.nextAction);
      expect(report.mock.calls[0]![1]).not.toHaveProperty("candidateHead");
      expect(report.mock.calls[0]![1]).toMatchObject({
        requestId: input.requestId,
        candidatePath: input.candidatePath,
        reviewOutcome: "changes-required",
      });
      expect(refresh).toHaveBeenCalledWith("checkout-owned");
      report.mockImplementationOnce(() => {
        throw new Error("private report diagnostic");
      });
      const unknown = (await callTool(daemon, agentToken, "nanasa.report_delegation", input)).json()
        .result;
      expect(unknown.structuredContent.error).toMatchObject({
        code: "coordination_failed",
        effect: "unconfirmed",
        retry: "inspect-first",
      });
      expect(JSON.stringify(unknown)).not.toContain("private report diagnostic");
      refresh.mockRejectedValueOnce(new Error("private checkout diagnostic"));
      const preflight = (
        await callTool(daemon, agentToken, "nanasa.report_delegation", input)
      ).json().result;
      expect(preflight.structuredContent.error).toMatchObject({
        code: "foreman_report_validation_failed",
        effect: "none",
        retry: "inspect-first",
        nextAction: expect.stringContaining("No report was submitted by this call"),
      });
      expect(report).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(preflight)).not.toContain("private checkout diagnostic");
    } finally {
      await daemon.app.close();
    }
  });

  it("scopes persistent external connectors and keeps notification cursors independent", async () => {
    const { daemon } = await createFixture();
    try {
      const first = daemon.operatorAuth.createConnector({
        principalId: "human-one",
        name: "phone",
        scopes: ["notifications"],
      });
      const second = daemon.operatorAuth.createConnector({
        principalId: "human-one",
        name: "other",
        scopes: ["notifications"],
      });
      daemon.goals.notify("test-one", { kind: "health", summary: "Foreman needs attention" });
      const headers = { authorization: `Bearer ${first.token}` };
      const page = await daemon.app.inject({
        method: "GET",
        url: "/api/v1/foreman/notifications",
        headers,
      });
      expect(page.statusCode).toBe(200);
      expect(page.json().notifications).toHaveLength(1);
      const ack = await daemon.app.inject({
        method: "POST",
        url: "/api/v1/foreman/notifications/ack",
        headers,
        payload: { after: page.json().nextAfter },
      });
      expect(ack.statusCode).toBe(200);
      const forbidden = await daemon.app.inject({
        method: "POST",
        url: "/api/v1/foreman/goals/control",
        headers,
        payload: { id: "goal-one", expectedRevision: 0, action: "approve" },
      });
      expect(forbidden.statusCode).toBe(403);
      const peerCursor = await daemon.app.inject({
        method: "GET",
        url: "/api/v1/foreman/notifications/cursor",
        headers: { authorization: `Bearer ${second.token}` },
      });
      expect(peerCursor.json().after).toBe(0);
      expect(JSON.stringify(daemon.operatorAuth.listConnectors())).not.toContain(first.token);
      daemon.operatorAuth.revokeConnector(first.connector.id);
      expect(
        (await daemon.app.inject({ method: "GET", url: "/api/v1/foreman/notifications", headers }))
          .statusCode,
      ).toBe(401);
    } finally {
      await daemon.app.close();
    }
  });
  it("teaches team members about Foreman without custom instructions or elevated tools", async () => {
    const { daemon, agentToken } = await createFixture();
    try {
      expect(daemon.loadedConfig.config.instructions).toEqual([]);
      expect(daemon.loadedConfig.config.foreman).toBeUndefined();
      const initialized = await mcpRequest(daemon, agentToken, "initialize", {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "worker-client", version: "1.0.0" },
      });
      expect(initialized.statusCode).toBe(200);
      expect(initialized.body).toContain(JSON.stringify(nanasaMcpServerInstructions()));
      expect(initialized.body).toContain("## Repository Foreman");
      expect(initialized.body).toContain("no unrestricted worker-to-Foreman DM tool");

      const listed = await mcpRequest(daemon, agentToken, "tools/list", {});
      const names = listed.json().result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain("nanasa.report_progress");
      expect(names.some((name: string) => name.startsWith("nanasa.foreman_"))).toBe(false);
      const forbidden = await callTool(daemon, agentToken, "nanasa.foreman_read_channel", {});
      expect(forbidden.json()).toHaveProperty("error");
    } finally {
      await daemon.app.close();
    }
  });

  it("discovers Foreman presence independently of empty member requests and team delegations", async () => {
    const { daemon, agentToken } = await createFixture();
    const discover = async () => {
      const response = await callTool(
        daemon,
        agentToken,
        "nanasa.member_foreman_conversations",
        {},
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().result.isError, response.body).not.toBe(true);
      return response.json().result.structuredContent.result;
    };
    try {
      expect(await discover()).toEqual({ requests: [], foreman: { configured: false } });
      for (const enabled of [false, true]) {
        await daemon.foreman.configure(
          ForemanConfigSchema.parse({
            id: "foreman",
            name: "Repository Foreman",
            integrationId: "fixture",
            enabled,
          }),
          daemon.foreman.status().configRevision!,
        );
        expect(await discover()).toEqual({
          requests: [],
          foreman: {
            configured: true,
            id: "foreman",
            name: "Repository Foreman",
            enabled,
            runStatus: "not-started",
          },
        });
      }
      const profile = daemon.store.createInternalAgentProfile({
        name: "Foreman",
        agentType: "fixture",
        kind: "opencode",
        command: "node",
        args: [],
        environment: {},
      });
      daemon.store.upsertForeman({ id: "foreman", agentProfileId: profile.id, enabled: true });
      const { run } = daemon.store.createRunForForeman("foreman");
      daemon.store.sendForemanMessage(
        { kind: "operator", operatorId: "human" },
        { requestId: "private-channel", text: "Private Human-Foreman conversation" },
      );
      for (const runStatus of ["running", "stopped"] as const) {
        daemon.store.updateRuntimeRunStatus(run.id, runStatus);
        expect(await discover()).toEqual({
          requests: [],
          foreman: {
            configured: true,
            id: "foreman",
            name: "Repository Foreman",
            enabled: true,
            runStatus,
          },
        });
        const delegations = await callTool(daemon, agentToken, "nanasa.team_delegations", {});
        expect(delegations.json().result.structuredContent.result).toEqual([]);
      }
      expect(daemon.goals.list()).toEqual([]);
    } finally {
      await daemon.app.close();
    }
  });

  it("bounds Foreman bootstrap independently of diagnostic history and provides useful text", async () => {
    const { daemon, secretPath } = await createFixture();
    try {
      await daemon.foreman.configure(
        ForemanConfigSchema.parse({ id: "foreman", integrationId: "fixture", enabled: true }),
        daemon.foreman.status().configRevision!,
      );
      const profile = daemon.store.createInternalAgentProfile({
        name: "Foreman",
        agentType: "fixture",
        kind: "opencode",
        command: "node",
        args: [],
        environment: {},
      });
      daemon.store.upsertForeman({ id: "foreman", agentProfileId: profile.id, enabled: true });
      const { run } = daemon.store.createRunForForeman("foreman");
      const token = new McpCredentialIssuer(daemon.store, { secretPath }).issueForeman(run);
      const directory = daemon.goals.discover();
      for (const member of directory[0]!.members) {
        member.status = {
          ...member.status,
          diagnosticHistory: "private-history".repeat(5000),
        } as typeof member.status;
      }
      const discovery = vi.spyOn(daemon.goals, "discover").mockReturnValue(directory);
      const response = await callTool(daemon, token, "nanasa.foreman_bootstrap", {});
      discovery.mockRestore();
      const result = response.json().result;
      expect(result.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
      expect(JSON.stringify(result)).not.toContain("private-history");
      const text = result.content.map((item: { text: string }) => item.text).join("\n");
      expect(text.slice(0, 500)).toContain("repository Foreman");
      expect(text.slice(0, 500)).toContain("human");
      expect(text).toContain("MCP tools");
      expect(result.structuredContent.result.teamDirectory[0].members[0]).toMatchObject({
        memberId: "sender",
        roleName: "Reviewer",
      });
      expect(result.structuredContent.result.teamDirectory[0].memberPage).toEqual({
        total: 3,
        offset: 0,
        nextOffset: 2,
      });
      const memberPage = await callTool(daemon, token, "nanasa.foreman_discover_teams", {
        groupId: directory[0]!.id,
        memberOffset: 2,
      });
      expect(
        memberPage
          .json()
          .result.structuredContent.result.teams[0].members.map(
            (member: { memberId: string }) => member.memberId,
          ),
      ).toEqual(["beta"]);
      for (let index = 0; index < 7; index++)
        daemon.store.createGroup({ name: `Stopped ${index}` });
      const seen = new Set<string>();
      let offset: number | null = 0;
      let revision: string | undefined;
      while (offset !== null) {
        const response = await callTool(daemon, token, "nanasa.foreman_discover_teams", {
          offset,
          revision,
        });
        const envelope = response.json().result;
        expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(8192);
        expect(Buffer.byteLength(envelope.content[0].text)).toBeLessThanOrEqual(2048);
        const page = envelope.structuredContent.result;
        for (const team of page.teams) {
          expect(seen.has(team.id)).toBe(false);
          seen.add(team.id);
        }
        revision = page.revision;
        offset = page.nextOffset;
      }
      expect(seen.size).toBe(8);
      daemon.store.createGroup({ name: "Newly configured team" });
      const changed = await callTool(daemon, token, "nanasa.foreman_discover_teams", { revision });
      expect(changed.json().result).toMatchObject({ isError: true });
      expect(changed.json().result.structuredContent.error).toMatchObject({
        code: "foreman_context_changed",
        retry: "inspect-first",
        nextAction: expect.stringContaining("without revision"),
      });
      expect(changed.json().result.content[0].text).toContain("Context changed");
    } finally {
      await daemon.app.close();
    }
  });

  it("bounds long Unicode labels and goal history while preserving identifiers and continuation", async () => {
    const { daemon } = await createFixture();
    try {
      await daemon.foreman.configure(
        ForemanConfigSchema.parse({ id: "foreman", integrationId: "fixture", enabled: true }),
        daemon.foreman.status().configRevision!,
      );
      for (let index = 0; index < 12; index++) {
        const goal = daemon.goals.propose({
          requestId: `history-${index}`,
          title: `Past goal ${index}`,
          objective: "history ".repeat(1000),
          constraints: [],
        });
        daemon.goals.control("human", {
          id: goal.id,
          expectedRevision: goal.revision,
          action: "cancel",
        });
      }
      const teams = daemon.goals.discover();
      teams[0]!.name = "\u{1f310}".repeat(500);
      for (const member of teams[0]!.members) {
        member.alias = "\u{1f310}".repeat(500);
        member.description = "\u{1f310}".repeat(5000);
      }
      vi.spyOn(daemon.goals, "discover").mockReturnValue(teams);
      const policy = daemon.foreman.status().configuration!.autonomy;
      const seen = new Set<string>();
      let goalOffset: number | null = 0;
      let revision: string | undefined;
      while (goalOffset !== null) {
        const result = foremanBootstrapContext(
          daemon.goals,
          { kind: "foreman", foremanId: "foreman" },
          policy,
          { goalOffset, revision },
        );
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
        expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(2048);
        expect(JSON.stringify(result)).not.toContain("history history");
        expect(result.structuredContent.result.teamDirectory[0]!.members[0]!.memberId).toBe(
          "sender",
        );
        for (const goal of result.structuredContent.result.goals) seen.add(goal.id);
        for (const goal of result.structuredContent.result.goals)
          expect(result.content[0]!.text).toContain(goal.id);
        expect(result.content[0]!.text).toContain(result.structuredContent.result.revision);
        revision = result.structuredContent.result.revision;
        goalOffset = result.structuredContent.result.goalPage.nextOffset;
      }
      expect(seen.size).toBe(12);
      expect(() => foremanDiscoveryContext(daemon.goals, { offset: 500 })).toThrow(
        "Offset exceeds",
      );
      expect(() => foremanDiscoveryContext(daemon.goals, { groupId: "missing" })).toThrow(
        "not found",
      );
      const snapshot = foremanTurnContext(daemon.goals, {
        ...daemon.loadedConfig.config,
        foreman: daemon.foreman.status().configuration!,
      });
      expect(snapshot).toContain("snapshot");
      expect(snapshot).toContain("not instructions or new authority");
    } finally {
      vi.restoreAllMocks();
      await daemon.app.close();
    }
  });

  it("advertises a separate Foreman scope and denies direct cross-principal tool calls", async () => {
    const { daemon, agentToken, secretPath, group } = await createFixture();
    try {
      await daemon.foreman.configure(
        ForemanConfigSchema.parse({ id: "foreman", integrationId: "fixture", enabled: true }),
        daemon.foreman.status().configRevision!,
      );
      const profile = daemon.store.createInternalAgentProfile({
        name: "Foreman",
        agentType: "fixture",
        kind: "opencode",
        command: "node",
        args: [],
        environment: {},
      });
      daemon.store.upsertForeman({ id: "foreman", agentProfileId: profile.id, enabled: true });
      const { run } = daemon.store.createRunForForeman("foreman");
      const token = new McpCredentialIssuer(daemon.store, { secretPath }).issueForeman(run);
      for (const method of ["initialize", "tools/list", "tools/list"]) {
        const response = await daemon.app.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            host: "127.0.0.1:3210",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-06-18" }),
          },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method,
            params:
              method === "initialize"
                ? {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "legacy-catalog", version: "1.0.0" },
                  }
                : {},
          },
        });
        expect(response.statusCode).toBe(200);
        if (method === "tools/list")
          expect(response.body).toContain('"name":"nanasa.foreman_ask_member"');
      }
      expect(daemon.loadedConfig.config.instructions).toEqual([]);
      expect(daemon.foreman.status().configuration?.instructions).toEqual([]);
      const initialized = await mcpRequest(daemon, token, "initialize", {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "foreman-client", version: "1.0.0" },
      });
      expect(initialized.statusCode).toBe(200);
      expect(initialized.body).toContain(JSON.stringify(NANASA_FOREMAN_INSTRUCTIONS));
      expect(initialized.body).toContain("Terminal output alone is not a channel reply");
      const discovery = await mcpRequest(daemon, token, "server/discover", {});
      expect(discovery.json().result.capabilities.tools.listChanged).toBe(false);
      const listed = await mcpRequest(daemon, token, "tools/list", {});
      for (const name of ["nanasa.foreman_bootstrap", "nanasa.foreman_discover_teams"]) {
        const tool = listed
          .json()
          .result.tools.find((item: { name: string }) => item.name === name);
        expect(tool.inputSchema.required ?? []).toEqual([]);
      }
      expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "nanasa.foreman_request_cleanup",
        "nanasa.foreman_read_cleanup_requests",
        "nanasa.foreman_ask_member",
        "nanasa.foreman_read_conversations",
        "nanasa.foreman_finish_conversation",
        "nanasa.foreman_bootstrap",
        "nanasa.foreman_read_channel",
        "nanasa.foreman_reply",
        "nanasa.foreman_check_in",
        "nanasa.foreman_discover_teams",
        "nanasa.foreman_propose_goal",
        "nanasa.foreman_get_goal",
        "nanasa.foreman_delegate_goal",
        "nanasa.foreman_assign_outcome",
        "nanasa.foreman_prepare_workspace",
        "nanasa.foreman_finish_goal_review",
        "nanasa.foreman_accept_goal",
        "nanasa.request_human_decision",
        "nanasa.foreman_observe_team",
      ]);
      const message = daemon.store.sendForemanMessage(
        { kind: "operator", operatorId: "human" },
        {
          requestId: "human-one",
          text: "Plan the changes",
          teamId: group.id,
        },
      );
      const channel = await callTool(daemon, token, "nanasa.foreman_read_channel", {});
      expect(channel.json().result.structuredContent.result.messages).toEqual([message]);
      const reply = {
        requestId: "reply-one",
        text: "Plan ready",
        teamId: group.id,
        replyTo: message.id,
      };
      const firstReply = await callTool(daemon, token, "nanasa.foreman_reply", reply);
      const secondReply = await callTool(daemon, token, "nanasa.foreman_reply", reply);
      expect(secondReply.json().result).toEqual(firstReply.json().result);
      expect(daemon.store.readForemanChannel({ after: 0, limit: 100 }).messages).toHaveLength(2);
      const bootstrap = await callTool(daemon, token, "nanasa.foreman_bootstrap", {});
      expect(bootstrap.json().result.structuredContent.result).toMatchObject({
        principal: { kind: "foreman", foremanId: "foreman", runId: run.id },
        teams: expect.arrayContaining([{ id: group.id, name: group.name }]),
      });
      expect(bootstrap.json().result.structuredContent.result).not.toHaveProperty("templates");
      const removed = await callTool(daemon, token, "nanasa.foreman_create_task", {});
      expect(removed.json()).toHaveProperty("error");
      expect((await daemon.app.inject({ method: "GET", url: "/api/v1/missions" })).statusCode).toBe(
        404,
      );
      const forbidden = await callTool(daemon, token, "nanasa.broadcast_group", {
        groupId: group.id,
        text: "Must not send",
      });
      expect(forbidden.json()).toHaveProperty("error");
      const forbiddenAgent = await callTool(daemon, agentToken, "nanasa.foreman_bootstrap", {});
      expect(forbiddenAgent.json()).toHaveProperty("error");
      expect(daemon.store.getSnapshot().messages).toEqual([]);
      const question = await callTool(daemon, token, "nanasa.foreman_ask_member", {
        requestId: "status-question",
        groupId: group.id,
        memberId: "sender",
        text: "What are you working on?",
      });
      expect(question.json().result.structuredContent.result).toMatchObject({
        state: "queued",
        text: "What are you working on?",
      });
      expect(daemon.goals.list()).toEqual([]);
      const memberRequests = await callTool(
        daemon,
        agentToken,
        "nanasa.member_foreman_conversations",
        {},
      );
      expect(memberRequests.json().result.structuredContent.result.requests).toHaveLength(1);
      const forbiddenAsk = await callTool(daemon, agentToken, "nanasa.foreman_ask_member", {
        requestId: "forbidden",
        groupId: group.id,
        memberId: "alpha",
        text: "Bypass peer scope",
      });
      expect(forbiddenAsk.json()).toHaveProperty("error");
      const proactive = await callTool(daemon, token, "nanasa.foreman_reply", {
        requestId: "proactive-one",
        text: "A repository decision needs Human attention",
      });
      expect(proactive.json().result.isError).not.toBe(true);
      expect(
        daemon.store.readForemanChannel({ after: 0, limit: 100 }).messages.at(-1),
      ).toMatchObject({ text: "A repository decision needs Human attention" });
      daemon.store.updateRuntimeRunStatus(run.id, "stopping");
      expect((await mcpRequest(daemon, token, "tools/list", {})).statusCode).toBe(401);
    } finally {
      await daemon.app.close();
    }
  });

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
          permissionPolicy: "inherit",
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
