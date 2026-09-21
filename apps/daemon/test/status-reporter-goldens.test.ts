import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AgentStatusEventInput,
  AgentStatusEventInputSchema,
  type AgentStatusEventKind,
} from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  expect(declaredEvents.length).toBeGreaterThan(0);
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
  return await new Promise<string>((resolve, reject) => {
    let output = "";
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
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`exit ${code}`)),
    );
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
  plugin: { event(input: { event: Record<string, unknown> }): Promise<void> },
): Promise<() => void> {
  const modulePath = join(temporaryDirectory, "opencode-tui-session.mjs");
  writeFileSync(modulePath, OPENCODE_TUI_STATUS_REPORTER_SOURCE);
  const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
  let dispose = () => {};
  await module.default.tui({
    client: {
      session: {
        update: async (input: { metadata: unknown }) => {
          const info = { id: sessionId, metadata: input.metadata };
          await plugin.event({ event: { type: "session.updated", properties: { info } } });
          return { data: info };
        },
      },
    },
    route: { current: { name: "session", params: { sessionID: sessionId } } },
    state: { session: { get: () => ({ id: sessionId }) } },
    lifecycle: { onDispose: (handler: () => void) => (dispose = handler) },
  });
  return dispose;
}

describe("version-pinned status reporter traces", () => {
  it.each([
    ["status_process_unverified", 2],
    ["status_reporter_identity_fenced", 1],
    ["status_native_session_fenced", 1],
  ])("handles startup rejection %s without changing event identity", async (code, attempts) => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "nanasa-hook-startup-retry-"));
    temporaryDirectories.push(temporaryDirectory);
    const scriptPath = join(temporaryDirectory, "hook.mjs");
    writeFileSync(scriptPath, HOOK_STATUS_REPORTER_SOURCE);
    let received = 0;
    const capture = await captureServer(() => {
      received += 1;
      return received === 1 ? { status: 409, body: { code } } : undefined;
    });
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n");
    try {
      await runHook(scriptPath, "copilot", input, capture.url, "mcp-startup");
      expect(capture.events).toHaveLength(attempts);
      expect(
        capture.events.every(
          (event) => event.eventId === capture.events[0]!.eventId && event.sourceSequence === 1,
        ),
      ).toBe(true);
    } finally {
      await closeServer(capture.server);
    }
  });

  it("reports Copilot startup once after native MCP initialization without a user prompt", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "nanasa-hook-startup-"));
    temporaryDirectories.push(temporaryDirectory);
    const scriptPath = join(temporaryDirectory, "hook.mjs");
    writeFileSync(scriptPath, HOOK_STATUS_REPORTER_SOURCE);
    const capture = await captureServer();
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    };
    const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
    const input = [
      initialize,
      initialized,
      initialized,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n");
    try {
      await runHook(scriptPath, "copilot", JSON.stringify(initialize), capture.url, "mcp-startup");
      expect(capture.events).toHaveLength(0);
      const output = await runHook(scriptPath, "copilot", input, capture.url, "mcp-startup");
      expect(
        output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "nanasa-status-reporter", version: "2" },
          },
        },
        { jsonrpc: "2.0", id: 2, result: { tools: [] } },
      ]);
      expect(capture.events).toHaveLength(1);
      expect(capture.events[0]).toMatchObject({ event: "session.ready", sourceSequence: 1 });
      expect(capture.events[0]!.nativeSessionId).toBeUndefined();
      await runHook(scriptPath, "copilot", input, capture.url, "mcp-startup");
      expect(capture.events).toHaveLength(1);
      await runHook(
        scriptPath,
        "copilot",
        JSON.stringify({ sessionId: "native-session" }),
        capture.url,
        "sessionStart",
      );
      expect(capture.events[1]).toMatchObject({
        event: "session.ready",
        nativeSessionId: "native-session",
        sourceSequence: 2,
      });
    } finally {
      await closeServer(capture.server);
    }
  });

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

  it("creates and selects a native OpenCode root on cold startup without a prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-opencode-cold-start-"));
    temporaryDirectories.push(directory);
    const modulePath = join(directory, "tui.mjs");
    writeFileSync(modulePath, OPENCODE_TUI_STATUS_REPORTER_SOURCE);
    const serverPath = join(directory, "server.mjs");
    writeFileSync(serverPath, OPENCODE_STATUS_REPORTER_SOURCE);
    const capture = await captureServer();
    const previousUrl = process.env.NANASA_STATUS_URL;
    const previousToken = process.env.NANASA_MCP_TOKEN;
    process.env.NANASA_STATUS_URL = capture.url;
    process.env.NANASA_MCP_TOKEN = "fixture-token";
    setReporterEnvironment("opencode");
    const root = { id: "native-created-root", metadata: { existing: "preserved" } };
    let route: { name: string; params?: { sessionID: string } } = { name: "home" };
    const create = vi.fn(async () => ({ data: root }));
    const navigate = vi.fn((name: string, params: { sessionID: string }) => {
      route = { name, params };
    });
    const prompt = vi.fn();
    let dispose = () => {};
    const previousCreateRoot = process.env.NANASA_OPENCODE_CREATE_ROOT;
    const previousOptions = process.env.NANASA_OPENCODE_SESSION_OPTIONS;
    process.env.NANASA_OPENCODE_CREATE_ROOT = "1";
    const options = {
      agent: "nanasa-reviewer",
      model: { providerID: "github-copilot", id: "gpt-5.6-terra" },
      permission: [{ permission: "edit", pattern: "*", action: "deny" }],
    };
    process.env.NANASA_OPENCODE_SESSION_OPTIONS = JSON.stringify(options);
    const plugin = await (await import(pathToFileURL(serverPath).href)).default();
    const update = vi.fn(async (input: { sessionID: string; metadata: unknown }) => {
      expect(route).toEqual({ name: "session", params: { sessionID: root.id } });
      const info = { id: input.sessionID, metadata: input.metadata };
      await plugin.event({ event: { type: "session.updated", properties: { info } } });
      return { data: info };
    });
    try {
      await plugin.event({ event: { type: "session.created", properties: { info: root } } });
      for (const selection of [
        {},
        { runId: "other-run", generation: 1, reporterEpoch: "epoch-golden" },
        { runId: "run-golden", generation: 2, reporterEpoch: "epoch-golden" },
        { runId: "run-golden", generation: 1, reporterEpoch: "old-epoch" },
      ]) {
        await plugin.event({
          event: {
            type: "session.updated",
            properties: { info: { ...root, metadata: { nanasaReporter: selection } } },
          },
        });
      }
      await plugin.event({
        event: {
          type: "session.updated",
          properties: {
            info: {
              id: "child",
              parentID: root.id,
              metadata: {
                nanasaReporter: {
                  runId: "run-golden",
                  generation: 1,
                  reporterEpoch: "epoch-golden",
                },
              },
            },
          },
        },
      });
      const module = await import(pathToFileURL(modulePath).href);
      await module.default.tui({
        client: { session: { create, prompt, update } },
        route: {
          get current() {
            return route;
          },
          navigate,
        },
        state: { ready: true, session: { get: () => root } },
        lifecycle: { onDispose: (handler: () => void) => (dispose = handler) },
      });
      await expect.poll(() => create.mock.calls.length).toBe(1);
      expect(create).toHaveBeenCalledWith(options);
      expect(navigate).toHaveBeenCalledWith("session", { sessionID: root.id });
      expect(update).toHaveBeenCalledWith({
        sessionID: root.id,
        metadata: {
          existing: "preserved",
          nanasaReporter: { runId: "run-golden", generation: 1, reporterEpoch: "epoch-golden" },
        },
      });
      await waitForCount(capture.events, 1);
      expect(capture.events[0]).toMatchObject({
        event: "session.ready",
        nativeSessionId: root.id,
        runId: "run-golden",
        generation: 1,
        reporterEpoch: "epoch-golden",
      });
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      dispose();
      plugin.dispose();
      if (previousCreateRoot === undefined) delete process.env.NANASA_OPENCODE_CREATE_ROOT;
      else process.env.NANASA_OPENCODE_CREATE_ROOT = previousCreateRoot;
      if (previousOptions === undefined) delete process.env.NANASA_OPENCODE_SESSION_OPTIONS;
      else process.env.NANASA_OPENCODE_SESSION_OPTIONS = previousOptions;
      if (previousUrl === undefined) delete process.env.NANASA_STATUS_URL;
      else process.env.NANASA_STATUS_URL = previousUrl;
      if (previousToken === undefined) delete process.env.NANASA_MCP_TOKEN;
      else process.env.NANASA_MCP_TOKEN = previousToken;
      clearReporterEnvironment();
      await closeServer(capture.server);
    }
  });

  it.each(["failure", "missing-id", "child", "navigation", "disposal"])(
    "does not select or report an OpenCode root after %s during creation",
    async (scenario) => {
      const directory = mkdtempSync(join(tmpdir(), "nanasa-opencode-cold-guard-"));
      temporaryDirectories.push(directory);
      const modulePath = join(directory, "tui.mjs");
      writeFileSync(modulePath, OPENCODE_TUI_STATUS_REPORTER_SOURCE);
      let route = { name: "home" };
      let resolveCreation!: (value: unknown) => void;
      const create = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveCreation = resolve;
          }),
      );
      const navigate = vi.fn();
      const update = vi.fn();
      let dispose = () => {};
      const previousCreateRoot = process.env.NANASA_OPENCODE_CREATE_ROOT;
      process.env.NANASA_OPENCODE_CREATE_ROOT = "1";
      try {
        const module = await import(pathToFileURL(modulePath).href);
        vi.useFakeTimers();
        await module.default.tui({
          client: { session: { create, update } },
          route: {
            get current() {
              return route;
            },
            navigate,
          },
          state: { ready: true, session: { get: () => undefined } },
          lifecycle: { onDispose: (handler: () => void) => (dispose = handler) },
        });
        if (scenario === "navigation") route = { name: "other" };
        if (scenario === "disposal") dispose();
        resolveCreation(
          scenario === "failure"
            ? { error: { message: "unavailable" } }
            : {
                data: {
                  id: scenario === "missing-id" ? "" : "native-root",
                  ...(scenario === "child" ? { parentID: "parent" } : {}),
                },
              },
        );
        await vi.advanceTimersByTimeAsync(400);
        expect(create).toHaveBeenCalledTimes(1);
        expect(navigate).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      } finally {
        dispose();
        vi.useRealTimers();
        if (previousCreateRoot === undefined) delete process.env.NANASA_OPENCODE_CREATE_ROOT;
        else process.env.NANASA_OPENCODE_CREATE_ROOT = previousCreateRoot;
      }
    },
  );

  it.each(["resume", "selected", "child", "hydrating"])(
    "preserves OpenCode %s startup without duplicate roots",
    async (scenario) => {
      const directory = mkdtempSync(join(tmpdir(), "nanasa-opencode-startup-guard-"));
      temporaryDirectories.push(directory);
      const modulePath = join(directory, "tui.mjs");
      writeFileSync(modulePath, OPENCODE_TUI_STATUS_REPORTER_SOURCE);
      const root = { id: "native-root", ...(scenario === "child" ? { parentID: "parent" } : {}) };
      const create = vi.fn(async () => ({ data: root }));
      const update = vi.fn(async () => ({ data: root }));
      const navigate = vi.fn();
      let ready = scenario !== "hydrating";
      let dispose = () => {};
      const previousCreateRoot = process.env.NANASA_OPENCODE_CREATE_ROOT;
      process.env.NANASA_OPENCODE_CREATE_ROOT = scenario === "resume" ? "0" : "1";
      setReporterEnvironment("opencode");
      try {
        const module = await import(pathToFileURL(modulePath).href);
        vi.useFakeTimers();
        await module.default.tui({
          client: { session: { create, update } },
          route: {
            current: ["selected", "child"].includes(scenario)
              ? { name: "session", params: { sessionID: root.id } }
              : { name: "home" },
            navigate,
          },
          state: {
            get ready() {
              return ready;
            },
            session: { get: () => root },
          },
          lifecycle: { onDispose: (handler: () => void) => (dispose = handler) },
        });
        await vi.advanceTimersByTimeAsync(300);
        expect(create).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledTimes(scenario === "selected" ? 1 : 0);
        if (scenario === "hydrating") {
          ready = true;
          await vi.advanceTimersByTimeAsync(400);
          expect(create).toHaveBeenCalledTimes(1);
        }
      } finally {
        dispose();
        vi.useRealTimers();
        clearReporterEnvironment();
        if (previousCreateRoot === undefined) delete process.env.NANASA_OPENCODE_CREATE_ROOT;
        else process.env.NANASA_OPENCODE_CREATE_ROOT = previousCreateRoot;
      }
    },
  );

  it("correlates OpenCode native prompts and settles only the exact marked action", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-opencode-actions-"));
    temporaryDirectories.push(directory);
    const modulePath = join(directory, "plugin.mjs");
    writeFileSync(modulePath, OPENCODE_STATUS_REPORTER_SOURCE);
    const events: AgentStatusEventInput[] = [];
    const acknowledgements: Array<{
      kind: string;
      sourceSequence: number;
      providerTurnId: string;
      completionRevision: number;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.writeHead(202, { "content-type": "application/json" });
        if (request.url?.includes("/action-acks/")) {
          acknowledgements.push(body);
          response.end(JSON.stringify({ state: body.kind }));
        } else {
          events.push(AgentStatusEventInputSchema.parse(body));
          response.end(
            JSON.stringify({
              accepted: true,
              status: {
                state: "idle",
                phase: "settled",
                completionRevision: body.event === "turn.settled" ? 1 : 0,
              },
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const previousUrl = process.env.NANASA_STATUS_URL;
    const previousToken = process.env.NANASA_MCP_TOKEN;
    process.env.NANASA_STATUS_URL = `http://127.0.0.1:${address.port}/events`;
    process.env.NANASA_MCP_TOKEN = "fixture-token";
    setReporterEnvironment("opencode");
    let disposeTui = () => {};
    try {
      const plugin = await (await import(pathToFileURL(modulePath).href)).default();
      disposeTui = await selectOpenCodeRoot(directory, "action-root", plugin);
      const prompt = async (text: string, id = "native-turn") =>
        plugin["chat.message"](
          { sessionID: "action-root" },
          { message: { id }, parts: [{ type: "text", text }] },
        );
      const turn = async (type: string) =>
        plugin.event({
          event: {
            type: "session.status",
            properties: { sessionID: "action-root", status: { type } },
          },
        });
      await prompt("[Nanasa Action: action-review | Exact Run: wrong-run | Generation: 1]\nReview");
      await turn("busy");
      await turn("idle");
      await prompt(
        "[Nanasa Action: action-review | Exact Run: run-golden | Generation: 1]\nReview",
      );
      await prompt(
        "[Nanasa Action: action-review | Exact Run: run-golden | Generation: 1]\nReview",
      );
      await plugin["chat.message"](
        { sessionID: "child-session" },
        { message: { id: "child-turn" }, parts: [{ type: "text", text: "Child prompt" }] },
      );
      await turn("busy");
      await turn("idle");
      await turn("idle");
      await prompt("Ordinary human prompt", "ordinary-turn");
      await turn("busy");
      await turn("idle");
      await expect.poll(() => events.length).toBe(9);
      expect(acknowledgements).toHaveLength(2);
      expect(acknowledgements.map((item) => item.kind)).toEqual(["accepted", "completed"]);
      expect(acknowledgements[1]).toMatchObject({
        providerTurnId: "native-turn",
        completionRevision: 1,
      });
      const sequences = [
        ...events.map((item) => item.sourceSequence),
        ...acknowledgements.map((item) => item.sourceSequence),
      ].sort((left, right) => left - right);
      expect(sequences).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
      await plugin.event({
        event: { type: "session.deleted", properties: { sessionID: "action-root" } },
      });
    } finally {
      disposeTui();
      if (previousUrl === undefined) delete process.env.NANASA_STATUS_URL;
      else process.env.NANASA_STATUS_URL = previousUrl;
      if (previousToken === undefined) delete process.env.NANASA_MCP_TOKEN;
      else process.env.NANASA_MCP_TOKEN = previousToken;
      clearReporterEnvironment();
      await closeServer(server);
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
      disposeTui = await selectOpenCodeRoot(temporaryDirectory, "opencode-root", plugin);
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
        const disposeTui = await selectOpenCodeRoot(
          temporaryDirectory,
          "heartbeat-session",
          plugin,
        );
        disposeTui();
        await waitForEvent(capture.events, "heartbeat");
        await plugin.event({
          event: { type: "session.deleted", properties: { sessionID: "heartbeat-session" } },
        });
        plugin.dispose();
      }
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
        const disposeTui = await selectOpenCodeRoot(temporaryDirectory, "session-fenced", plugin);
        disposeTui();
        await waitForCount(capture.events, 1);
        await plugin.event({
          event: {
            type: "session.status",
            properties: { sessionID: "session-fenced", status: { type: "busy" } },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 225));
        const disposeAfterFence = await selectOpenCodeRoot(
          temporaryDirectory,
          "session-after-fence",
          plugin,
        );
        disposeAfterFence();
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
