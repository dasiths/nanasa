import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_COMMAND_REGISTRY } from "../src/cli/command-registry.js";
import { portalBootstrapUrl, runControlCli } from "../src/cli/control.js";
import {
  CONTROL_ROUTE_REGISTRY,
  generateControlOpenApi,
  matchControlRoute,
} from "../src/http/route-registry.js";
import { MCP_TOOL_REGISTRY } from "../src/mcp/tool-registry.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function capture() {
  let value = "";
  return {
    stream: { write: (chunk: string | Uint8Array) => ((value += chunk.toString()), true) },
    value: () => value,
  };
}

describe("typed control facade registries", () => {
  it("declares complete unique /api/v1 routes with principal, schemas, limits, idempotency, errors, and OpenAPI metadata", () => {
    expect(CONTROL_ROUTE_REGISTRY.length).toBeGreaterThanOrEqual(60);
    expect(new Set(CONTROL_ROUTE_REGISTRY.map((route) => route.id)).size).toBe(
      CONTROL_ROUTE_REGISTRY.length,
    );
    expect(
      new Set(CONTROL_ROUTE_REGISTRY.map((route) => `${route.method} ${route.path}`)).size,
    ).toBe(CONTROL_ROUTE_REGISTRY.length);
    for (const route of CONTROL_ROUTE_REGISTRY) {
      expect(route.path).toMatch(/^\/api\/v1(?:\/|$)/);
      expect(route.principal).toMatch(/^(public|operator)$/);
      expect(route.bodyLimit).toBeGreaterThan(0);
      expect(route.schemas.params.parse).toBeTypeOf("function");
      expect(route.schemas.query.parse).toBeTypeOf("function");
      expect(route.schemas.body.parse).toBeTypeOf("function");
      expect(route.schemas.response.parse).toBeTypeOf("function");
      expect(route.openapi.operationId).toBe(route.id);
      expect(route.openapi.tags).toEqual([route.family]);
      expect(Array.isArray(route.errors)).toBe(true);
    }
    expect(matchControlRoute("GET", "/api/v1/repositories/repo_1/checkouts")?.id).toBe(
      "checkouts.list",
    );
    expect(matchControlRoute("GET", "/api/groups")).toBeUndefined();
  });

  it("classifies every state-changing route without inherited forbidden policy", () => {
    const nonGet = CONTROL_ROUTE_REGISTRY.filter((route) => route.method !== "GET");
    const transactional = [
      "service.planRestart",
      "state.retain",
      "state.delete",
      "statuses.acknowledge",
      "messages.submit",
      "messages.clear",
      "actions.create",
      "actions.cancel",
    ];
    expect(
      nonGet.filter((route) => route.idempotency !== "forbidden").map((route) => route.id),
    ).toEqual(transactional);
    expect(nonGet.every((route) => route.idempotency !== undefined)).toBe(true);
  });

  it("generates OpenAPI 3.1 directly from every route declaration", () => {
    const document = generateControlOpenApi() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(document.openapi).toBe("3.1.0");
    const operations = Object.values(document.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId),
    );
    expect(operations.sort()).toEqual(CONTROL_ROUTE_REGISTRY.map((route) => route.id).sort());
    expect(document.paths["/api/v1/worktrees/{worktreeId}"]?.delete?.operationId).toBe(
      "worktrees.delete",
    );
  });

  it("covers every required CLI family including release lifecycle operations", () => {
    const families = new Set(CLI_COMMAND_REGISTRY.map((command) => command.family));
    expect(families).toEqual(
      new Set([
        "action",
        "agent",
        "api",
        "auth",
        "checkout",
        "completion",
        "config",
        "console",
        "daemon",
        "doctor",
        "events",
        "extension",
        "group",
        "message",
        "metadata",
        "remote",
        "role",
        "run",
        "service",
        "state",
        "status",
        "terminal",
        "trust",
        "wait",
        "worktree",
      ]),
    );
    expect(
      CLI_COMMAND_REGISTRY.filter((command) => command.family === "extension").map(
        (command) => command.command,
      ),
    ).toEqual([
      "list",
      "inspect",
      "plan",
      "health",
      "trust",
      "install",
      "repair",
      "disable",
      "rollback",
      "remove",
    ]);
    expect(
      CLI_COMMAND_REGISTRY.filter((command) => command.family === "service").map(
        (command) => command.command,
      ),
    ).toEqual([
      "install",
      "status",
      "start",
      "stop",
      "restart",
      "remove",
      "logs",
      "wait-ready",
      "upgrade",
      "rollback",
    ]);
    expect(CLI_COMMAND_REGISTRY.every((command) => command.summary.length > 0)).toBe(true);
    expect(CLI_COMMAND_REGISTRY.find((command) => command.id === "auth.portal")).toMatchObject({
      command: "portal",
      method: "POST",
      output: "text",
      mutating: true,
    });
  });

  it("constructs a portal bootstrap URL without encoding the fragment separator", () => {
    expect(
      portalBootstrapUrl(
        "http://127.0.0.1:3210/api/v1",
        "nanasa-bootstrap=abcdefghijklmnopqrstuvwxyz012345",
      ),
    ).toBe("http://127.0.0.1:3210/#nanasa-bootstrap=abcdefghijklmnopqrstuvwxyz012345");
  });

  it("binds every HTTP mutation command to the shared route idempotency policy", () => {
    const commands = CLI_COMMAND_REGISTRY.filter(
      (command) => command.mutating && command.method !== undefined && command.path !== undefined,
    );
    for (const command of commands) {
      const positionals = command.positionals.map((name) => `${name}-fixture`);
      const route = matchControlRoute(command.method!, command.path!(positionals));
      expect(route, command.id).toBeDefined();
      expect(route?.method).not.toBe("GET");
    }
    const replayableCommands = commands
      .filter((command) => {
        const positionals = command.positionals.map((name) => `${name}-fixture`);
        return (
          matchControlRoute(command.method!, command.path!(positionals))?.idempotency !==
          "forbidden"
        );
      })
      .map((command) => command.id);
    expect(replayableCommands).toEqual([
      "state.retain",
      "state.delete",
      "agent.prompt",
      "status.ack",
      "message.send",
      "message.clear",
      "action.create",
      "action.cancel",
    ]);
  });

  it("returns stable CLI exits for completion, usage, and control failures", async () => {
    const repository = mkdtempSync(join(tmpdir(), "nanasa-facade-cli-"));
    temporaryDirectories.push(repository);
    const completionOut = capture();
    const completionErr = capture();
    await expect(
      runControlCli(["completion", "bash"], repository, {
        stdout: completionOut.stream as NodeJS.WritableStream,
        stderr: completionErr.stream as NodeJS.WritableStream,
      }),
    ).resolves.toBe(0);
    expect(completionOut.value()).toContain("complete -W");
    expect(completionErr.value()).toBe("");

    const usageOut = capture();
    const usageErr = capture();
    await expect(
      runControlCli(["unknown", "command"], repository, {
        stdout: usageOut.stream as NodeJS.WritableStream,
        stderr: usageErr.stream as NodeJS.WritableStream,
      }),
    ).resolves.toBe(2);
    expect(usageOut.value()).toBe("");
    expect(JSON.parse(usageErr.value())).toEqual({
      message: expect.stringContaining("Unknown command"),
      details: {},
      code: "cli_usage_error",
    });

    const failureOut = capture();
    const failureErr = capture();
    await expect(
      runControlCli(["api", "meta"], repository, {
        stdout: failureOut.stream as NodeJS.WritableStream,
        stderr: failureErr.stream as NodeJS.WritableStream,
      }),
    ).resolves.toBe(1);
    expect(failureOut.value()).toBe("");
    expect(JSON.parse(failureErr.value())).toEqual({
      message: expect.any(String),
      details: {},
      code: "control_request_failed",
    });
  });

  it("keeps MCP authority semantic and excludes topology, raw terminal, extension, and permission tools", () => {
    const names = MCP_TOOL_REGISTRY.map((tool) => tool.name);
    expect(names).toContain("nanasa.get_delivery");
    expect(names).toContain("nanasa.list_visible_history");
    expect(names).toContain("nanasa.list_own_waits");
    expect(names).not.toEqual(
      expect.arrayContaining([
        "nanasa.create_group",
        "nanasa.delete_agent",
        "nanasa.send_keys",
        "nanasa.install_extension",
        "nanasa.approve_permission",
      ]),
    );
    const ownWaits = MCP_TOOL_REGISTRY.find((tool) => tool.name === "nanasa.list_own_waits");
    expect(ownWaits?.principals).toEqual(["agent"]);
    expect(MCP_TOOL_REGISTRY.every((tool) => tool.scope.length > 0)).toBe(true);
  });
});
