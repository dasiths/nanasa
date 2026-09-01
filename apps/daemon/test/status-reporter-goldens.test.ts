import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AgentStatusEventInput,
  type AgentStatusEventKind,
  AgentStatusEventInputSchema,
} from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderAdapterRegistry } from "../src/providers/provider-adapter-registry.js";
import {
  HOOK_STATUS_REPORTER_SOURCE,
  OPENCODE_STATUS_REPORTER_SOURCE,
  OPENCODE_TUI_STATUS_REPORTER_SOURCE,
  PI_STATUS_REPORTER_SOURCE,
} from "../src/status-reporter-assets.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/status-reporters/", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixturePath(directory: string, file: string): string {
  return join(fixtureRoot, directory, file);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function canonical(event: AgentStatusEventInput): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    event: event.event,
    ...(event.nativeSessionId === undefined ? {} : { sessionId: event.nativeSessionId }),
    ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
    ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    ...(Object.keys(event.data).length === 0 ? {} : { data: event.data }),
  };
  if (event.source === "copilot" && normalized.operationId !== undefined) {
    normalized.operationId = "<stable-tool>";
  }
  if (
    (event.source === "claude-code" || event.source === "copilot") &&
    normalized.requestId !== undefined
  ) {
    normalized.requestId = "<stable-permission>";
  }
  return normalized;
}

async function captureServer(): Promise<{
  server: Server;
  url: string;
  events: AgentStatusEventInput[];
}>;
async function captureServer(
  responseForEvent: (
    event: AgentStatusEventInput,
  ) => { status: number; body: Record<string, unknown>; delayMs?: number } | undefined,
): Promise<{
  server: Server;
  url: string;
  events: AgentStatusEventInput[];
}>;
async function captureServer(
  responseForEvent?: (
    event: AgentStatusEventInput,
  ) => { status: number; body: Record<string, unknown>; delayMs?: number } | undefined,
): Promise<{
  server: Server;
  url: string;
  events: AgentStatusEventInput[];
}> {
  const events: AgentStatusEventInput[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      expect(request.headers.authorization).toBe("Bearer fixture-token");
      const event = AgentStatusEventInputSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      events.push(event);
      const configured = responseForEvent?.(event);
      const complete = () => {
        response.writeHead(configured?.status ?? 202, { "content-type": "application/json" });
        response.end(JSON.stringify(configured?.body ?? { accepted: true }));
      };
      if ((configured?.delayMs ?? 0) > 0) setTimeout(complete, configured!.delayMs);
      else complete();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Capture server unavailable");
  return { server, url: `http://127.0.0.1:${address.port}/events`, events };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function waitForCount(events: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (events.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(events).toHaveLength(count);
}

async function waitForEvent(
  events: readonly AgentStatusEventInput[],
  event: AgentStatusEventKind,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!events.some((item) => item.event === event) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(events.some((item) => item.event === event)).toBe(true);
}

function expectExactFixtureCoverage(
  source: "claude-code" | "copilot" | "pi" | "opencode",
  events: readonly AgentStatusEventInput[],
  declaredEvents: readonly AgentStatusEventKind[],
): void {
  const descriptor = ProviderAdapterRegistry.builtIn().get(source).reporter;
  expect(declaredEvents).toEqual(descriptor.events);
  expect([...new Set(events.map((event) => event.event))].sort()).toEqual(
    declaredEvents.filter((event) => event !== "heartbeat").sort(),
  );
  expect(events.every((event) => event.actionId === undefined && event.turnId === undefined)).toBe(
    true,
  );
}

async function runHook(
  scriptPath: string,
  source: string,
  input: string,
  url: string,
  configuredEvent?: string,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [scriptPath, source, ...(configuredEvent === undefined ? [] : [configuredEvent])],
      {
        env: {
          ...process.env,
          NANASA_STATUS_URL: url,
          NANASA_MCP_TOKEN: "fixture-token",
          NANASA_REPORTER_PROVIDER_ID: source,
          NANASA_REPORTER_ADAPTER_ID: source,
          NANASA_REPORTER_ID: `${source}-reporter`,
          NANASA_REPORTER_SOURCE: source,
          NANASA_REPORTER_PROTOCOL_VERSION: "2",
          NANASA_REPORTER_VERSION: "2",
          NANASA_REPORTER_RUN_ID: "run-golden",
          NANASA_REPORTER_GENERATION: "1",
          NANASA_REPORTER_EPOCH: "epoch-golden",
          NANASA_REPORTER_SEQUENCE_FILE: `${scriptPath}.sequence.json`,
        },
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.stdin.end(input);
  });
}

function setReporterEnvironment(source: "pi" | "opencode"): void {
  Object.assign(process.env, {
    NANASA_REPORTER_PROVIDER_ID: source,
    NANASA_REPORTER_ADAPTER_ID: source,
    NANASA_REPORTER_ID: `${source}-reporter`,
    NANASA_REPORTER_SOURCE: source,
    NANASA_REPORTER_PROTOCOL_VERSION: "2",
    NANASA_REPORTER_VERSION: "2",
    NANASA_REPORTER_RUN_ID: "run-golden",
    NANASA_REPORTER_GENERATION: "1",
    NANASA_REPORTER_EPOCH: "epoch-golden",
  });
}

function clearReporterEnvironment(): void {
  for (const name of [
    "NANASA_REPORTER_PROVIDER_ID",
    "NANASA_REPORTER_ADAPTER_ID",
    "NANASA_REPORTER_ID",
    "NANASA_REPORTER_SOURCE",
    "NANASA_REPORTER_PROTOCOL_VERSION",
    "NANASA_REPORTER_VERSION",
    "NANASA_REPORTER_RUN_ID",
    "NANASA_REPORTER_GENERATION",
    "NANASA_REPORTER_EPOCH",
    "NANASA_REPORTER_HEARTBEAT_MS",
  ])
    delete process.env[name];
}

async function selectOpenCodeRoot(
  temporaryDirectory: string,
  sessionId: string,
): Promise<() => void> {
  const modulePath = join(temporaryDirectory, "opencode-tui-session.mjs");
  writeFileSync(modulePath, OPENCODE_TUI_STATUS_REPORTER_SOURCE);
  const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
  let dispose = () => {};
  await module.default.tui({
    route: { current: { name: "session", params: { sessionID: sessionId } } },
    state: { session: { get: () => ({ id: sessionId }) } },
    lifecycle: { onDispose: (handler: () => void) => (dispose = handler) },
  });
  return dispose;
}

describe("version-pinned status reporter traces", () => {
  it.each([
    ["claude-code-2.1.220", "claude-code"],
    ["copilot-1.0.79", "copilot"],
  ] as const)("replays %s command hooks", async (directory, source) => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "nanasa-hook-golden-"));
    temporaryDirectories.push(temporaryDirectory);
    const scriptPath = join(temporaryDirectory, "hook.mjs");
    writeFileSync(scriptPath, HOOK_STATUS_REPORTER_SOURCE);
    const capture = await captureServer();
    const raw = readFileSync(fixturePath(directory, "raw.jsonl"), "utf8").trim().split("\n");
    const expected = readJson<Array<Record<string, unknown>>>(
      fixturePath(directory, "expanded-normalized.json"),
    );
    const manifest = readJson<{
      hooks?: string[];
      declaredEvents: AgentStatusEventKind[];
      limitations: string[];
    }>(fixturePath(directory, "manifest.json"));
    try {
      for (const [index, line] of raw.entries()) {
        await runHook(scriptPath, source, line, capture.url, manifest.hooks?.[index]);
      }
      await waitForCount(capture.events, expected.length);
      expect(capture.events.map(canonical)).toEqual(expected);
      expectExactFixtureCoverage(source, capture.events, manifest.declaredEvents);
      expect(manifest.limitations).toContain("no-action-correlation");
    } finally {
      await closeServer(capture.server);
    }
  });

  it("replays Pi 0.83.0 extension lifecycle", async () => {
    const directory = "pi-0.83.0_adapter-2.18.0";
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "nanasa-pi-golden-"));
    temporaryDirectories.push(temporaryDirectory);
    const modulePath = join(temporaryDirectory, "pi-extension.mjs");
    writeFileSync(modulePath, PI_STATUS_REPORTER_SOURCE);
    const capture = await captureServer();
    const previousUrl = process.env.NANASA_STATUS_URL;
    const previousToken = process.env.NANASA_MCP_TOKEN;
    process.env.NANASA_STATUS_URL = capture.url;
    process.env.NANASA_MCP_TOKEN = "fixture-token";
    setReporterEnvironment("pi");
    try {
      type PiHandler = (
        event: Record<string, unknown>,
        context?: {
          mode: "tui";
          isIdle(): boolean;
          sessionManager: { getSessionId(): unknown };
        },
      ) => void | Promise<void>;
      const extension = (await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`))
        .default as (pi: { on(name: string, handler: PiHandler): void }) => void;
      const handlers = new Map<string, PiHandler>();
      extension({ on: (name, handler) => handlers.set(name, handler) });
      const raw = readJson<Array<Record<string, unknown>>>(
        fixturePath(directory, "expanded-raw.json"),
      );
      for (const item of raw) {
        const handler = handlers.get(String(item.event));
        expect(handler).toBeDefined();
        if (item.event === "session_start") {
          await handler?.(
            {},
            {
              mode: "tui",
              isIdle: () => true,
              sessionManager: { getSessionId: () => item.sessionId },
            },
          );
        } else {
          await handler?.(item, {
            mode: "tui",
            isIdle: () => true,
            sessionManager: { getSessionId: () => "pi-session" },
          });
        }
      }
      const expected = readJson<Array<Record<string, unknown>>>(
        fixturePath(directory, "expanded-normalized.json"),
      );
      await waitForCount(capture.events, expected.length);
      expect(capture.events.map(canonical)).toEqual(expected);
      const manifest = readJson<{
        declaredEvents: AgentStatusEventKind[];
        limitations: string[];
      }>(fixturePath(directory, "manifest.json"));
      expectExactFixtureCoverage("pi", capture.events, manifest.declaredEvents);
      expect(manifest.limitations).not.toContain("no-reload-republish");
    } finally {
      if (previousUrl === undefined) delete process.env.NANASA_STATUS_URL;
      else process.env.NANASA_STATUS_URL = previousUrl;
      if (previousToken === undefined) delete process.env.NANASA_MCP_TOKEN;
      else process.env.NANASA_MCP_TOKEN = previousToken;
      clearReporterEnvironment();
      await closeServer(capture.server);
    }
  });

  it("replays OpenCode 1.18.15 plugin lifecycle", async () => {
    const directory = "opencode-1.18.15";
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "nanasa-opencode-golden-"));
    temporaryDirectories.push(temporaryDirectory);
    const modulePath = join(temporaryDirectory, "opencode-plugin.mjs");
    writeFileSync(modulePath, OPENCODE_STATUS_REPORTER_SOURCE);
    const capture = await captureServer();
    const previousUrl = process.env.NANASA_STATUS_URL;
    const previousToken = process.env.NANASA_MCP_TOKEN;
    process.env.NANASA_STATUS_URL = capture.url;
    process.env.NANASA_MCP_TOKEN = "fixture-token";
    setReporterEnvironment("opencode");
    let disposeTui = () => {};
    try {
      const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
      const plugin = await module.default();
      disposeTui = await selectOpenCodeRoot(temporaryDirectory, "opencode-root");
      const raw = readJson<Array<Record<string, unknown>>>(
        fixturePath(directory, "expanded-raw.json"),
      );
      for (const event of raw) await plugin.event({ event });
      const expected = readJson<Array<Record<string, unknown>>>(
        fixturePath(directory, "expanded-normalized.json"),
      );
      await waitForCount(capture.events, expected.length);
      expect(capture.events.map(canonical)).toEqual(expected);
      const manifest = readJson<{
        declaredEvents: AgentStatusEventKind[];
        limitations: string[];
      }>(fixturePath(directory, "manifest.json"));
      expectExactFixtureCoverage("opencode", capture.events, manifest.declaredEvents);
      expect(manifest.limitations).not.toContain("no-root-child-qualification");
      expect(
        capture.events.some(
          (event) => event.nativeSessionId === "opencode-child" && event.event === "turn.started",
        ),
      ).toBe(false);
    } finally {
      disposeTui();
      if (previousUrl === undefined) delete process.env.NANASA_STATUS_URL;
      else process.env.NANASA_STATUS_URL = previousUrl;
      if (previousToken === undefined) delete process.env.NANASA_MCP_TOKEN;
      else process.env.NANASA_MCP_TOKEN = previousToken;
      clearReporterEnvironment();
      await closeServer(capture.server);
    }
  });

  it.each([
    ["pi", PI_STATUS_REPORTER_SOURCE],
    ["opencode", OPENCODE_STATUS_REPORTER_SOURCE],
  ] as const)("emits the declared %s heartbeat without provider work", async (source, code) => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), `nanasa-${source}-heartbeat-`));
    temporaryDirectories.push(temporaryDirectory);
    const modulePath = join(temporaryDirectory, `${source}-reporter.mjs`);
    writeFileSync(modulePath, code);
    const capture = await captureServer();
    const previousUrl = process.env.NANASA_STATUS_URL;
    const previousToken = process.env.NANASA_MCP_TOKEN;
    const previousHeartbeat = process.env.NANASA_REPORTER_HEARTBEAT_MS;
    process.env.NANASA_STATUS_URL = capture.url;
    process.env.NANASA_MCP_TOKEN = "fixture-token";
    process.env.NANASA_REPORTER_HEARTBEAT_MS = "50";
    setReporterEnvironment(source);
    try {
      const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
      if (source === "pi") {
        type PiHandler = (
          event: Record<string, unknown>,
          context?: {
            mode: "tui";
            isIdle(): boolean;
            sessionManager: { getSessionId(): unknown };
          },
        ) => void | Promise<void>;
        const handlers = new Map<string, PiHandler>();
        (module.default as (pi: { on(name: string, handler: PiHandler): void }) => void)({
          on: (name, handler) => handlers.set(name, handler),
        });
        await handlers.get("session_start")?.(
          {},
          {
            mode: "tui",
            isIdle: () => true,
            sessionManager: { getSessionId: () => "heartbeat-session" },
          },
        );
        await waitForEvent(capture.events, "heartbeat");
        handlers.get("session_shutdown")?.({});
      } else {
        const plugin = await module.default();
        await plugin.event({
          event: { type: "session.created", properties: { info: { id: "heartbeat-session" } } },
        });
        await waitForEvent(capture.events, "heartbeat");
        await plugin.event({
          event: { type: "session.deleted", properties: { sessionID: "heartbeat-session" } },
        });
      }
      expect(ProviderAdapterRegistry.builtIn().get(source).reporter.events).toContain("heartbeat");
    } finally {
      if (previousUrl === undefined) delete process.env.NANASA_STATUS_URL;
      else process.env.NANASA_STATUS_URL = previousUrl;
      if (previousToken === undefined) delete process.env.NANASA_MCP_TOKEN;
      else process.env.NANASA_MCP_TOKEN = previousToken;
      if (previousHeartbeat === undefined) delete process.env.NANASA_REPORTER_HEARTBEAT_MS;
      else process.env.NANASA_REPORTER_HEARTBEAT_MS = previousHeartbeat;
      clearReporterEnvironment();
      await closeServer(capture.server);
    }
  });

  it.each([
    ["pi", "status_reporter_identity_fenced", PI_STATUS_REPORTER_SOURCE],
    ["pi", "status_native_session_fenced", PI_STATUS_REPORTER_SOURCE],
    ["opencode", "status_reporter_identity_fenced", OPENCODE_STATUS_REPORTER_SOURCE],
    ["opencode", "status_native_session_fenced", OPENCODE_STATUS_REPORTER_SOURCE],
  ] as const)("stops %s reporting after %s", async (source, rejectionCode, code) => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), `nanasa-${source}-fenced-`));
    temporaryDirectories.push(temporaryDirectory);
    const modulePath = join(temporaryDirectory, `${source}-reporter.mjs`);
    writeFileSync(modulePath, code);
    const capture = await captureServer(() => ({
      status: 409,
      delayMs: 125,
      body: {
        code: rejectionCode,
        message: "Reporter identity is not authoritative",
      },
    }));
    const previousUrl = process.env.NANASA_STATUS_URL;
    const previousToken = process.env.NANASA_MCP_TOKEN;
    const previousHeartbeat = process.env.NANASA_REPORTER_HEARTBEAT_MS;
    process.env.NANASA_STATUS_URL = capture.url;
    process.env.NANASA_MCP_TOKEN = "fixture-token";
    process.env.NANASA_REPORTER_HEARTBEAT_MS = "50";
    setReporterEnvironment(source);
    try {
      const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
      if (source === "pi") {
        type PiHandler = (
          event: Record<string, unknown>,
          context?: {
            mode: "tui";
            isIdle(): boolean;
            sessionManager: { getSessionId(): unknown };
          },
        ) => void | Promise<void>;
        const handlers = new Map<string, PiHandler>();
        (module.default as (pi: { on(name: string, handler: PiHandler): void }) => void)({
          on: (name, handler) => handlers.set(name, handler),
        });
        await handlers.get("session_start")?.(
          {},
          {
            mode: "tui",
            isIdle: () => true,
            sessionManager: { getSessionId: () => "session-fenced" },
          },
        );
        await waitForCount(capture.events, 1);
        handlers.get("agent_start")?.({});
        await new Promise((resolve) => setTimeout(resolve, 225));
        await handlers.get("session_start")?.(
          {},
          {
            mode: "tui",
            isIdle: () => true,
            sessionManager: { getSessionId: () => "session-after-fence" },
          },
        );
        handlers.get("agent_start")?.({});
      } else {
        const plugin = await module.default();
        await plugin.event({
          event: { type: "session.created", properties: { info: { id: "session-fenced" } } },
        });
        await waitForCount(capture.events, 1);
        await plugin.event({
          event: {
            type: "session.status",
            properties: { sessionID: "session-fenced", status: { type: "busy" } },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 225));
        await plugin.event({
          event: { type: "session.created", properties: { info: { id: "session-after-fence" } } },
        });
        await plugin.event({
          event: {
            type: "session.status",
            properties: { sessionID: "session-fenced", status: { type: "busy" } },
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 125));
      expect(capture.events).toHaveLength(1);
    } finally {
      if (previousUrl === undefined) delete process.env.NANASA_STATUS_URL;
      else process.env.NANASA_STATUS_URL = previousUrl;
      if (previousToken === undefined) delete process.env.NANASA_MCP_TOKEN;
      else process.env.NANASA_MCP_TOKEN = previousToken;
      if (previousHeartbeat === undefined) delete process.env.NANASA_REPORTER_HEARTBEAT_MS;
      else process.env.NANASA_REPORTER_HEARTBEAT_MS = previousHeartbeat;
      clearReporterEnvironment();
      await closeServer(capture.server);
    }
  });

  it("binds queued Pi events to their event-time session", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "nanasa-pi-session-boundary-"));
    temporaryDirectories.push(temporaryDirectory);
    const modulePath = join(temporaryDirectory, "pi-reporter.mjs");
    writeFileSync(modulePath, PI_STATUS_REPORTER_SOURCE);
    const capture = await captureServer((event) => ({
      status: 202,
      delayMs: event.sourceSequence === 1 ? 100 : 0,
      body: { accepted: true },
    }));
    const previousUrl = process.env.NANASA_STATUS_URL;
    const previousToken = process.env.NANASA_MCP_TOKEN;
    process.env.NANASA_STATUS_URL = capture.url;
    process.env.NANASA_MCP_TOKEN = "fixture-token";
    setReporterEnvironment("pi");
    try {
      type PiHandler = (
        event: Record<string, unknown>,
        context?: {
          mode: "tui";
          isIdle(): boolean;
          sessionManager: { getSessionId(): unknown };
        },
      ) => void | Promise<void>;
      const handlers = new Map<string, PiHandler>();
      const extension = (await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`))
        .default as (pi: { on(name: string, handler: PiHandler): void }) => void;
      extension({ on: (name, handler) => handlers.set(name, handler) });
      const sessionA = handlers.get("session_start")?.(
        {},
        {
          mode: "tui",
          isIdle: () => true,
          sessionManager: { getSessionId: () => "session-a" },
        },
      );
      handlers.get("agent_start")?.({});
      const sessionB = handlers.get("session_start")?.(
        {},
        {
          mode: "tui",
          isIdle: () => true,
          sessionManager: { getSessionId: () => "session-b" },
        },
      );
      await Promise.all([sessionA, sessionB]);
      await waitForCount(capture.events, 5);
      expect(
        capture.events.map((event) => [event.event, event.nativeSessionId, event.sourceSequence]),
      ).toEqual([
        ["session.ready", "session-a", 1],
        ["turn.started", "session-a", 2],
        ["session.ready", "session-b", 3],
        ["turn.settled", "session-a", 4],
        ["turn.settled", "session-b", 5],
      ]);
      handlers.get("session_shutdown")?.({});
    } finally {
      if (previousUrl === undefined) delete process.env.NANASA_STATUS_URL;
      else process.env.NANASA_STATUS_URL = previousUrl;
      if (previousToken === undefined) delete process.env.NANASA_MCP_TOKEN;
      else process.env.NANASA_MCP_TOKEN = previousToken;
      clearReporterEnvironment();
      await closeServer(capture.server);
    }
  });

  it("records exact tested harness and reporter versions in each manifest", () => {
    expect(readJson(fixturePath("claude-code-2.1.220", "manifest.json"))).toMatchObject({
      harness: "claude-code",
      version: "2.1.220",
      reporterVersion: "2",
    });
    expect(readJson(fixturePath("copilot-1.0.79", "manifest.json"))).toMatchObject({
      harness: "copilot",
      version: "1.0.79",
      reporterVersion: "2",
    });
    expect(readJson(fixturePath("pi-0.83.0_adapter-2.18.0", "manifest.json"))).toMatchObject({
      harness: "pi",
      version: "0.83.0",
      adapterVersion: "2.18.0",
      reporterVersion: "2",
    });
    expect(readJson(fixturePath("opencode-1.18.15", "manifest.json"))).toMatchObject({
      harness: "opencode",
      version: "1.18.15",
      reporterVersion: "2",
    });
  });
});
