import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base, expect, type TestInfo } from "@playwright/test";

interface Group {
  id: string;
  name: string;
  checkoutId?: string;
  checkoutRevision: number;
}

interface RuntimeAgent {
  id: string;
  groupId: string;
  memberId: string;
  agentProfileId: string;
  alias: string;
}

interface Run {
  id: string;
  groupId: string;
  memberId: string;
  generation: number;
  status: string;
  desiredState: string;
  checkoutId?: string;
  resolvedWorkingDirectory?: string;
  terminal?: { paneId: string };
}

interface Snapshot {
  groups: Group[];
  memberships: RuntimeAgent[];
  runs: Run[];
  checkouts: Array<{ id: string; path: string; kind: string; branch?: string }>;
  worktrees: Array<{
    id: string;
    checkoutId: string;
    branch: string;
    operationGeneration: number;
    state: string;
  }>;
}

interface McpResponse {
  result?: {
    tools?: { name: string }[];
    structuredContent?: unknown;
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  error?: { message: string };
}

export interface TerminalEndpointStatus {
  runId: string;
  provider: "nanasa-terminal.v1";
  state: "starting" | "ready" | "unavailable" | "stopped";
  streamUrl?: string;
}

export interface SeededGroup {
  group: Group;
  agents: RuntimeAgent[];
}

const root = resolve(import.meta.dirname, "../../..");
const cliPath = join(root, "bin", "nanasa.js");
const echoAgentPath = join(import.meta.dirname, "safe-echo-agent.mjs");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a port");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return port;
}

async function waitFor(description: string, check: () => Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolveExit();
    });
  });
}

export class PackageAcceptanceService {
  readonly root: string;
  readonly repository: string;
  readonly port: number;
  readonly tmuxServer: string;
  readonly baseUrl: string;
  portalUrl: string;
  readonly logPath: string;
  #daemon?: ChildProcess;
  #operatorToken?: string;
  #log = createWriteStream("/dev/null");

  private constructor(root: string, repository: string, port: number, tmuxServer: string) {
    this.root = root;
    this.repository = repository;
    this.port = port;
    this.tmuxServer = tmuxServer;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.portalUrl = this.baseUrl;
    this.logPath = join(repository, "daemon.log");
    this.#log.end();
    this.#log = createWriteStream(this.logPath, { flags: "a" });
  }

  static async create(browserName: string): Promise<PackageAcceptanceService> {
    const root = mkdtempSync(join(tmpdir(), "nanasa-acceptance-"));
    const repository = join(root, "repository");
    mkdirSync(repository);
    const port = await freePort();
    const tmuxServer = `nanasa-e2e-${browserName}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const initialized = spawnSync("git", ["init", "--quiet", repository], { encoding: "utf8" });
    if (initialized.status !== 0) {
      throw new Error(initialized.stderr || "Could not initialize acceptance Git repository");
    }
    mkdirSync(join(repository, ".nanasa"));
    writeFileSync(
      join(repository, ".nanasa", "config.yaml"),
      [
        "version: 2",
        "repository: { path: ., checkout: { kind: current } }",
        "integrations:",
        "  echo:",
        "    name: Safe Echo",
        "    kind: opencode",
        `    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(echoAgentPath)}]`,
        "    cwd: packages/api",
        "    providerState: { scope: integration }",
        "    credentials: { kind: provider-managed }",
        "    model: { resumePolicy: preserve-session }",
        "    nativeRecovery: { mode: resume-or-restart, confirmationTimeoutSeconds: 30 }",
        "",
      ].join("\n"),
    );
    mkdirSync(join(repository, "packages", "api"), { recursive: true });
    writeFileSync(join(repository, "packages", "api", "README.md"), "# API fixture\n");
    const committed = spawnSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Nanasa Test",
        "-c",
        "user.email=nanasa@example.invalid",
        "add",
        ".",
      ],
      { encoding: "utf8" },
    );
    if (committed.status !== 0) throw new Error(committed.stderr);
    const initialCommit = spawnSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Nanasa Test",
        "-c",
        "user.email=nanasa@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "acceptance fixture",
      ],
      { encoding: "utf8" },
    );
    if (initialCommit.status !== 0) throw new Error(initialCommit.stderr);
    const service = new PackageAcceptanceService(root, repository, port, tmuxServer);
    try {
      await service.startDaemon();
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }

  async startDaemon(): Promise<void> {
    if (this.#daemon !== undefined) throw new Error("Acceptance daemon is already running");
    this.portalUrl = this.baseUrl;
    this.#log.write(`\n--- daemon start ${new Date().toISOString()} ---\n`);
    const child = spawn(
      process.execPath,
      [cliPath, "start", "--host", "127.0.0.1", "--port", String(this.port), "--mcp"],
      {
        cwd: this.repository,
        env: { ...process.env, NANASA_TMUX_SERVER: this.tmuxServer },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.#daemon = child;
    let stdoutBuffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      this.#log.write(chunk);
      stdoutBuffer = `${stdoutBuffer}${chunk.toString("utf8")}`.slice(-8_192);
      const match = stdoutBuffer.match(/Open (http:\/\/[^\s]+)/);
      if (match?.[1] !== undefined) this.portalUrl = match[1];
    });
    child.stderr?.pipe(this.#log, { end: false });
    await waitFor("packaged daemon health", async () => {
      if (child.exitCode !== null) throw new Error(`daemon exited with ${child.exitCode}`);
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    });
    this.#operatorToken = readFileSync(
      join(this.repository, ".nanasa", "runtime", "operator-secret"),
    ).toString("base64url");
    await waitFor("portal bootstrap URL", async () =>
      this.portalUrl.includes("#nanasa-bootstrap="),
    );
  }

  async stopDaemon(): Promise<void> {
    const child = this.#daemon;
    if (child === undefined) return;
    this.#daemon = undefined;
    child.kill("SIGTERM");
    await waitForExit(child);
  }

  async restartDaemon(): Promise<void> {
    await this.stopDaemon();
    await this.startDaemon();
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${this.#operatorToken}`,
      },
    });
    const body = (await response.json()) as T | { message?: string };
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${path}: ${"message" in body ? body.message : "request failed"}`,
      );
    }
    return body as T;
  }

  async seedGroup(name: string, agentNames: string[]): Promise<SeededGroup> {
    const group = await this.request<Group>("/api/v1/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const agents: RuntimeAgent[] = [];
    for (const name of agentNames) {
      agents.push(
        await this.request<RuntimeAgent>(`/api/v1/groups/${group.id}/agents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            integrationId: "echo",
          }),
        }),
      );
    }
    return { group, agents };
  }

  async snapshot(): Promise<Snapshot> {
    return this.request<Snapshot>("/api/v1/snapshot");
  }

  async agentMcpRequest(
    paneId: string,
    method: string,
    params: Record<string, unknown>,
    toolName?: string,
  ): Promise<McpResponse> {
    const panePidResult = spawnSync(
      "tmux",
      [
        "-L",
        this.tmuxServer,
        "-f",
        "/dev/null",
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_pid}",
      ],
      { encoding: "utf8" },
    );
    if (panePidResult.status !== 0) throw new Error(panePidResult.stderr);
    const panePid = Number(panePidResult.stdout.trim());
    const token = readFileSync(`/proc/${panePid}/environ`)
      .toString("utf8")
      .split("\0")
      .find((entry) => entry.startsWith("NANASA_MCP_TOKEN="))
      ?.slice("NANASA_MCP_TOKEN=".length);
    if (token === undefined || token.length === 0) {
      throw new Error(`Pane ${paneId} does not have an MCP capability`);
    }
    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "MCP-Method": method,
        ...(toolName === undefined ? {} : { "MCP-Name": toolName }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "nanasa-acceptance-agent",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const payload = (await response.json()) as McpResponse;
    if (!response.ok || payload.error !== undefined) {
      throw new Error(payload.error?.message ?? `MCP ${method} failed with ${response.status}`);
    }
    if (payload.result?.isError === true) {
      throw new Error(
        payload.result.content
          ?.map((item) => item.text)
          .filter(Boolean)
          .join("; ") || `MCP ${method} returned an error`,
      );
    }
    return payload;
  }

  async waitForTerminalReady(
    runId: string,
  ): Promise<TerminalEndpointStatus & { streamUrl: string }> {
    let ready: (TerminalEndpointStatus & { streamUrl: string }) | undefined;
    await waitFor(`terminal endpoint for ${runId} to be ready`, async () => {
      const status = await this.request<TerminalEndpointStatus>(`/api/v1/runs/${runId}/terminal`);
      if (status.state !== "ready" || status.streamUrl === undefined) return false;
      ready = status as TerminalEndpointStatus & { streamUrl: string };
      return true;
    });
    return ready!;
  }

  async startAll(groupId: string): Promise<void> {
    type StartOutcome = {
      memberId: string;
      status: string;
      reason?: string;
      error?: unknown;
      request?: { id: string; subjectDigest: string; configRevision: string };
    };
    const start = () =>
      this.request<{ outcomes: StartOutcome[] }>(`/api/v1/groups/${groupId}/runs/start-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    let result = await start();
    for (const outcome of result.outcomes) {
      if (outcome.status !== "approval-required" || outcome.request === undefined) continue;
      await this.request(`/api/v1/launch-consents/${outcome.request.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedSubjectDigest: outcome.request.subjectDigest,
          configRevision: outcome.request.configRevision,
        }),
      });
    }
    if (result.outcomes.some((outcome) => outcome.status === "approval-required")) {
      result = await start();
    }
    const failures = result.outcomes.filter(
      (outcome) => !["started", "already-running"].includes(outcome.status),
    );
    if (failures.length > 0) {
      throw new Error(`Could not start echo agents: ${JSON.stringify(failures)}`);
    }
    await waitFor("all echo agents to run", async () => {
      const snapshot = await this.snapshot();
      return (
        snapshot.runs.filter((run) => run.groupId === groupId && run.status === "running")
          .length === snapshot.memberships.filter((member) => member.groupId === groupId).length
      );
    });
  }

  capturePane(paneId: string): string {
    const result = spawnSync(
      "tmux",
      [
        "-L",
        this.tmuxServer,
        "-f",
        "/dev/null",
        "capture-pane",
        "-p",
        "-J",
        "-S",
        "-",
        "-t",
        paneId,
      ],
      { encoding: "utf8" },
    );
    return result.status === 0 ? result.stdout : result.stderr;
  }

  paneSize(paneId: string): string {
    const result = spawnSync(
      "tmux",
      [
        "-L",
        this.tmuxServer,
        "-f",
        "/dev/null",
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_width}x#{pane_height}",
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  paneExists(paneId: string): boolean {
    const result = spawnSync(
      "tmux",
      ["-L", this.tmuxServer, "-f", "/dev/null", "list-panes", "-a", "-F", "#{pane_id}"],
      { encoding: "utf8" },
    );
    return result.status === 0 && result.stdout.split("\n").includes(paneId);
  }

  async waitForPaneStopped(paneId: string): Promise<void> {
    await waitFor(`pane ${paneId} to stop`, async () => !this.paneExists(paneId));
  }

  async waitForPaneText(paneId: string, text: string): Promise<void> {
    await waitFor(`pane ${paneId} to contain ${JSON.stringify(text)}`, async () =>
      this.capturePane(paneId).includes(text),
    );
  }

  captureAllPanes(): string {
    const snapshot = spawnSync(
      "tmux",
      ["-L", this.tmuxServer, "-f", "/dev/null", "list-panes", "-a", "-F", "#{pane_id}"],
      { encoding: "utf8" },
    );
    if (snapshot.status !== 0) return snapshot.stderr;
    return snapshot.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((paneId) => `--- ${paneId} ---\n${this.capturePane(paneId)}`)
      .join("\n");
  }

  async close(): Promise<void> {
    await this.stopDaemon();
    spawnSync("tmux", ["-L", this.tmuxServer, "-f", "/dev/null", "kill-server"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolveLog) => this.#log.end(resolveLog));
    rmSync(this.root, { recursive: true, force: true });
  }
}

type Fixtures = { nanasa: PackageAcceptanceService };

export const test = base.extend<Fixtures>({
  nanasa: async ({ browserName }, use, testInfo: TestInfo) => {
    const service = await PackageAcceptanceService.create(browserName);
    try {
      await use(service);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("daemon.log", {
          path: service.logPath,
          contentType: "text/plain",
        });
        await testInfo.attach("tmux-panes.log", {
          body: Buffer.from(service.captureAllPanes()),
          contentType: "text/plain",
        });
      }
    } finally {
      await service.close();
    }
  },
});

export { expect };
