import { describe, expect, it } from "vitest";
import { findCliCommand } from "../src/cli/command-registry.js";
import { defaultControlApiUrl } from "../src/cli/control-client-loader.js";
import { completion, resolveServiceStartup } from "../src/cli/control.js";
import { SystemdUserService } from "../src/service/systemd-user-service.js";

describe("CLI surface defaults", () => {
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
