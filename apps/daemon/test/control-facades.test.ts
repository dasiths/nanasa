import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_COMMAND_REGISTRY } from "../src/cli/command-registry.js";
import { runControlCli } from "../src/cli/control.js";
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
        "migration",
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
    expect(usageErr.value()).toContain("Unknown command");

    const failureOut = capture();
    const failureErr = capture();
    await expect(
      runControlCli(["api", "meta"], repository, {
        stdout: failureOut.stream as NodeJS.WritableStream,
        stderr: failureErr.stream as NodeJS.WritableStream,
      }),
    ).resolves.toBe(1);
    expect(failureOut.value()).toBe("");
    expect(JSON.parse(failureErr.value())).toMatchObject({
      version: 1,
      error: { code: "control_request_failed" },
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
