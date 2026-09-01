import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type AgentStatusEventInput, AgentStatusEventInputSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  HOOK_STATUS_REPORTER_SOURCE,
  OPENCODE_STATUS_REPORTER_SOURCE,
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
      fixturePath(directory, "normalized.json"),
    );
    const manifest = readJson<{ hooks?: string[] }>(fixturePath(directory, "manifest.json"));
    try {
      for (const [index, line] of raw.entries()) {
        await runHook(scriptPath, source, line, capture.url, manifest.hooks?.[index]);
      }
      await waitForCount(capture.events, expected.length);
      expect(capture.events.map(canonical)).toEqual(expected);
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
        context?: { sessionManager: { getSessionId(): unknown } },
      ) => void;
      const extension = (await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`))
        .default as (pi: { on(name: string, handler: PiHandler): void }) => void;
      const handlers = new Map<string, PiHandler>();
      extension({ on: (name, handler) => handlers.set(name, handler) });
      const raw = readJson<Array<Record<string, unknown>>>(fixturePath(directory, "raw.json"));
      for (const item of raw) {
        const handler = handlers.get(String(item.event));
        expect(handler).toBeDefined();
        if (item.event === "session_start") {
          handler?.({}, { sessionManager: { getSessionId: () => item.sessionId } });
        } else {
          handler?.(item);
        }
      }
      const expected = readJson<Array<Record<string, unknown>>>(
        fixturePath(directory, "normalized.json"),
      );
      await waitForCount(capture.events, expected.length);
      expect(capture.events.map(canonical)).toEqual(expected);
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
    try {
      const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
      const plugin = await module.default();
      const raw = readJson<Array<Record<string, unknown>>>(fixturePath(directory, "raw.json"));
      for (const event of raw) await plugin.event({ event });
      const expected = readJson<Array<Record<string, unknown>>>(
        fixturePath(directory, "normalized.json"),
      );
      await waitForCount(capture.events, expected.length);
      expect(capture.events.map(canonical)).toEqual(expected);
    } finally {
      if (previousUrl === undefined) delete process.env.NANASA_STATUS_URL;
      else process.env.NANASA_STATUS_URL = previousUrl;
      if (previousToken === undefined) delete process.env.NANASA_MCP_TOKEN;
      else process.env.NANASA_MCP_TOKEN = previousToken;
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
          context?: { sessionManager: { getSessionId(): unknown } },
        ) => void;
        const handlers = new Map<string, PiHandler>();
        (module.default as (pi: { on(name: string, handler: PiHandler): void }) => void)({
          on: (name, handler) => handlers.set(name, handler),
        });
        handlers.get("session_start")?.(
          {},
          { sessionManager: { getSessionId: () => "session-fenced" } },
        );
        await waitForCount(capture.events, 1);
        handlers.get("agent_start")?.({});
        await new Promise((resolve) => setTimeout(resolve, 225));
        handlers.get("session_start")?.(
          {},
          { sessionManager: { getSessionId: () => "session-after-fence" } },
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
        context?: { sessionManager: { getSessionId(): unknown } },
      ) => void;
      const handlers = new Map<string, PiHandler>();
      const extension = (await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`))
        .default as (pi: { on(name: string, handler: PiHandler): void }) => void;
      extension({ on: (name, handler) => handlers.set(name, handler) });
      handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "session-a" } });
      handlers.get("agent_start")?.({});
      handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "session-b" } });
      await waitForCount(capture.events, 3);
      expect(
        capture.events.map((event) => [event.event, event.nativeSessionId, event.sourceSequence]),
      ).toEqual([
        ["session.ready", "session-a", 1],
        ["turn.started", "session-a", 2],
        ["session.ready", "session-b", 3],
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

  it("records exact tested harness versions in each manifest", () => {
    expect(readJson(fixturePath("claude-code-2.1.220", "manifest.json"))).toMatchObject({
      harness: "claude-code",
      version: "2.1.220",
    });
    expect(readJson(fixturePath("copilot-1.0.79", "manifest.json"))).toMatchObject({
      harness: "copilot",
      version: "1.0.79",
    });
    expect(readJson(fixturePath("pi-0.83.0_adapter-2.18.0", "manifest.json"))).toMatchObject({
      harness: "pi",
      version: "0.83.0",
      adapterVersion: "2.18.0",
    });
    expect(readJson(fixturePath("opencode-1.18.15", "manifest.json"))).toMatchObject({
      harness: "opencode",
      version: "1.18.15",
    });
  });
});
