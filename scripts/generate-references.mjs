import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "docs", "next", "reference");
const mode = process.argv[2] ?? "--check";
if (!["--check", "--write"].includes(mode)) throw new Error("Use --check or --write");

const contracts = await import(join(root, "packages", "contracts", "dist", "index.js"));
const { CONTROL_ROUTE_REGISTRY } = await import(
  join(root, "apps", "daemon", "dist", "http", "route-registry.js")
);
const { CLI_COMMAND_REGISTRY } = await import(
  join(root, "apps", "daemon", "dist", "cli", "command-registry.js")
);
const { AuthoredNanasaConfigSchema } = await import(
  join(root, "apps", "daemon", "dist", "config-loader.js")
);
const { MCP_TOOL_REGISTRY } = await import(
  join(root, "apps", "daemon", "dist", "mcp", "tool-registry.js")
);
const terminalLimits = await import(
  join(root, "apps", "daemon", "dist", "terminal", "terminal-transport-limits.js")
);
const { generatedOfflineHelp } = await import(
  join(root, "apps", "portal", "src", "help", "generated-offline-help.ts")
);
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const header = { generatorVersion: 1, packageVersion: packageJson.version };
const schema = (value, io = "output") => z.toJSONSchema(value, { io, unrepresentable: "any" });
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const openApiPaths = {};
for (const route of CONTROL_ROUTE_REGISTRY) {
  openApiPaths[route.path] ??= {};
  openApiPaths[route.path][route.method.toLowerCase()] = {
    operationId: route.id,
    summary: route.openapi.summary,
    tags: route.openapi.tags,
    security: route.principal === "public" ? [] : [{ operatorSession: [] }],
    responses: { [route.openapi.successStatus]: { description: "Validated response" } },
    "x-body-limit": route.bodyLimit,
    "x-idempotency": route.idempotency,
    "x-errors": route.errors,
    ...(route.transport === undefined ? {} : { "x-transport": route.transport }),
  };
}

const references = {
  "config.schema.json": {
    ...header,
    schemaVersion: contracts.CONFIG_VERSION,
    schema: schema(AuthoredNanasaConfigSchema, "input"),
  },
  "openapi.json": {
    openapi: "3.1.0",
    info: { title: "Nanasa control API", version: packageJson.version },
    "x-generator-version": 1,
    paths: openApiPaths,
    components: {
      securitySchemes: {
        operatorSession: { type: "apiKey", in: "cookie", name: "nanasa-session" },
      },
    },
  },
  "cli.json": {
    ...header,
    commands: CLI_COMMAND_REGISTRY.map((command) => ({
      id: command.id,
      family: command.family,
      command: command.command,
      mode: command.mode,
      positionals: command.positionals,
      summary: command.summary,
    })),
  },
  "events.json": {
    ...header,
    protocolVersion: 1,
    cursor: schema(contracts.EventCursorSchema),
    filter: schema(contracts.EventFilterSchema),
    frame: schema(contracts.EventServerFrameSchema),
  },
  "terminal.json": {
    ...header,
    protocol: contracts.TERMINAL_PROTOCOL,
    protocolVersion: contracts.TERMINAL_PROTOCOL_VERSION,
    limits: terminalLimits.TERMINAL_LIMITS,
    clientFrame: schema(contracts.TerminalClientFrameSchema),
    serverFrame: schema(contracts.TerminalServerFrameSchema),
    read: schema(contracts.TerminalReadRequestSchema),
  },
  "mcp-tools.json": {
    ...header,
    tools: MCP_TOOL_REGISTRY.map((tool) => ({
      name: tool.name,
      description: tool.description,
      principals: tool.principals,
      scope: tool.scope,
      authority: tool.authority,
      inputSchema: schema(tool.inputSchema),
    })),
  },
  "errors-limits.json": {
    ...header,
    routeErrors: Object.fromEntries(
      CONTROL_ROUTE_REGISTRY.map((route) => [route.id, route.errors]),
    ),
    requestBodyLimits: Object.fromEntries(
      CONTROL_ROUTE_REGISTRY.map((route) => [route.id, route.bodyLimit]),
    ),
    terminal: terminalLimits.TERMINAL_LIMITS,
  },
  "package.json": {
    ...header,
    engines: packageJson.engines,
    os: packageJson.os,
    cpu: packageJson.cpu,
    files: packageJson.files,
    support: {
      host: "Linux glibc",
      distributions: ["Ubuntu 22.04", "Ubuntu 24.04", "Debian 12"],
      node: ["22 LTS", "24 LTS"],
      tmux: ">=3.2",
      architectures: ["x64", "arm64"],
      browsers: ["Chromium", "Firefox", "WebKit"],
      wsl2: "preview",
      nativeMacOS: "unsupported",
      nativeWindows: "unsupported",
    },
  },
  "capabilities.json": {
    ...header,
    controlApiVersion: 1,
    eventProtocolVersion: 1,
    terminalProtocolVersion: 1,
    configVersion: contracts.CONFIG_VERSION,
    service: "systemd-user",
    remote: "openssh-loopback-forward",
    updateContinuity: "tmux-process-retained-browser-resnapshot",
  },
  "portal-help.json": {
    ...header,
    sections: generatedOfflineHelp([]),
  },
};

mkdirSync(output, { recursive: true });
const drift = [];
for (const [name, value] of Object.entries(references)) {
  const path = join(output, name);
  const expected = json(value);
  if (mode === "--write") {
    writeFileSync(path, expected);
  } else if (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
    drift.push(name);
  }
}
if (drift.length > 0) throw new Error(`Generated documentation drift: ${drift.join(", ")}`);
console.log(
  `${mode === "--write" ? "Generated" : "Verified"} ${Object.keys(references).length} references`,
);
