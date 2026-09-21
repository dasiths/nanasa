import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { findCliCommand } from "../src/cli/command-registry.js";
import { completion, resolveServiceStartup, runControlCli } from "../src/cli/control.js";
import { defaultControlApiUrl } from "../src/cli/control-client-loader.js";
import { authenticateAgent, setupIntegrations } from "../src/cli-admin.js";
import { SystemdUserService } from "../src/service/systemd-user-service.js";

describe("CLI surface defaults", () => {
  it.each([["stop"], ["daemon", "stop"]])(
    "stops idempotently without HTTP access: %j",
    async (...args) => {
      const root = mkdtempSync(join(tmpdir(), "nanasa-cli-stop-"));
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      try {
        mkdirSync(join(root, ".nanasa"));
        writeFileSync(join(root, ".nanasa", "config.yaml"), "version: 2\nintegrations: {}\n");
        expect(await runControlCli(args, root, { stdout, stderr })).toBe(0);
        expect(stdout.read().toString()).toBe("Repository daemon is not running\n");
        expect(await runControlCli([...args, "--output", "json"], root, { stdout, stderr })).toBe(
          0,
        );
        expect(JSON.parse(stdout.read().toString())).toMatchObject({ state: "not-running" });
        expect(
          await runControlCli([...args, "--api-url", "http://127.0.0.1:9999"], root, {
            stdout,
            stderr,
          }),
        ).toBe(2);
        expect(stderr.read().toString()).toContain("repository-local");
        expect(existsSync(join(root, ".nanasa", "runtime"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("declares and completes both graceful stop command forms", () => {
    expect(findCliCommand("daemon", "stop")).toMatchObject({
      mode: "local",
      mutating: true,
      body: "none",
    });
    expect(completion("bash")).toContain("daemon) COMPREPLY=( $(compgen -W 'open status stop'");
    expect(completion("powershell")).toContain("'stop' = @()");
  });

  it("declares Foreman and goal control without exposing legacy mission commands", () => {
    expect(findCliCommand("foreman", "start")).toMatchObject({ body: "required", mutating: true });
    expect(findCliCommand("foreman", "status")?.path?.([])).toBe("/api/v1/foreman");
    expect(findCliCommand("missions", "get")).toBeUndefined();
    expect(findCliCommand("missions", "decide")).toBeUndefined();
    expect(findCliCommand("goal", "get")?.path?.(["goal one"])).toBe(
      "/api/v1/foreman/goals/goal%20one",
    );
    expect(findCliCommand("goal", "decide")?.path?.([])).toBe("/api/v1/foreman/decisions/resolve");
    expect(completion("bash")).toContain("foreman)");
    expect(completion("bash")).not.toContain("missions)");
  });

  it("authenticates Foreman in a private home rather than the integration-shared home", async () => {
    const root = mkdtempSync(join(tmpdir(), "nanasa-foreman-auth-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, ".nanasa"));
      const output = join(root, "auth-home.txt");
      const script = `require('node:fs').writeFileSync(${JSON.stringify(output)}, process.env.COPILOT_HOME)`;
      writeFileSync(
        join(root, ".nanasa", "config.yaml"),
        `version: 2\nintegrations:\n  copilot:\n    name: Fixture\n    kind: copilot\n    command: ${JSON.stringify([process.execPath, "-e", script])}\n    providerState: { scope: integration }\nforeman:\n  integrationId: copilot\n`,
      );
      setupIntegrations(root);
      await authenticateAgent(root, "copilot", undefined, true);
      const foremanHome = readFileSync(output, "utf8");
      expect(foremanHome).toContain("/state/foremen/");
      expect(statSync(foremanHome).mode & 0o777).toBe(0o700);
      await expect(authenticateAgent(root, "copilot", "agent-one", true)).rejects.toThrow(
        "cannot be combined",
      );
      await authenticateAgent(root, "copilot");
      expect(readFileSync(output, "utf8")).toContain("/state/integrations/copilot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the control API URL from the daemon host and port environment", () => {
    expect(defaultControlApiUrl({})).toBe("http://127.0.0.1:3210");
    expect(defaultControlApiUrl({ NANASA_PORT: "4210" })).toBe("http://127.0.0.1:4210");
    expect(defaultControlApiUrl({ NANASA_HOST: "::1", NANASA_PORT: "4210" })).toBe(
      "http://[::1]:4210",
    );
    expect(() => defaultControlApiUrl({ NANASA_PORT: "zero" })).toThrow(/NANASA_PORT/);
  });

  it("resolves service startup flags before environment and product defaults", () => {
    expect(resolveServiceStartup({}, {})).toEqual({
      host: "127.0.0.1",
      port: 3210,
      mcpEnabled: true,
    });
    expect(
      resolveServiceStartup(
        { host: "::1", port: 5210, mcpEnabled: false },
        { NANASA_HOST: "localhost", NANASA_PORT: "4210", NANASA_MCP_ENABLED: "true" },
      ),
    ).toEqual({ host: "::1", port: 5210, mcpEnabled: false });
    expect(() => resolveServiceStartup({}, { NANASA_MCP_ENABLED: "sometimes" })).toThrow(
      /NANASA_MCP_ENABLED/,
    );
    expect(
      () =>
        new SystemdUserService({
          repositoryRoot: "/tmp/nanasa-repository",
          packageRoot: "/tmp/nanasa-package",
          home: "/tmp/nanasa-home",
          host: "0.0.0.0",
        }),
    ).toThrow(/must remain loopback/);
  });

  it("declares the optional status and wait filters used by their route builders", () => {
    const statuses = findCliCommand("status", "list");
    const waits = findCliCommand("wait", "list");

    expect(statuses?.positionals).toEqual(["group-id?"]);
    expect(statuses?.path?.(["group one"])).toBe("/api/v1/statuses?groupId=group%20one");
    expect(waits?.positionals).toEqual(["group-id", "member-id?"]);
    expect(waits?.path?.(["group one", "member two"])).toBe(
      "/api/v1/open-waits?groupId=group%20one&memberId=member%20two",
    );
  });

  it("completes registry-backed families and subcommands in every supported shell", () => {
    expect(completion("bash")).toContain("group) COMPREPLY=( $(compgen -W '");
    expect(completion("bash")).toContain("create");
    expect(completion("zsh")).toContain("group) _values 'command'");
    expect(completion("zsh")).toContain("create");
    expect(completion("fish")).toContain("__fish_seen_subcommand_from group");
    expect(completion("fish")).toContain("create");
    expect(completion("powershell")).toContain("'group' = @(");
    expect(completion("powershell")).toContain("'create'");
  });
});
