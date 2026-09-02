import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DATABASE_SCHEMA_VERSION } from "../src/persistence/schema.js";
import { ReleaseManager, type ReleaseService } from "../src/release/release-manager.js";
import { NanasaStore } from "../src/store.js";

const roots: string[] = [];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function temporary(name: string): string {
  const path = join(tmpdir(), `nanasa-checkpoint-rollback-${name}-${crypto.randomUUID()}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
}

function build(commit: string, version: string) {
  return {
    packageName: "nanasa",
    packageVersion: version,
    channel: "next",
    commit,
    builtAt: "2026-08-30T00:00:00.000Z",
    databaseSchema: { minimum: DATABASE_SCHEMA_VERSION, maximum: DATABASE_SCHEMA_VERSION },
    configVersion: 2,
    apiVersion: 1,
    eventProtocolVersion: 1,
    terminalProtocolVersion: 1,
    node: ">=22 <23 || >=24 <25",
    hosts: ["linux-x64", "linux-arm64"],
    tmux: ">=3.2",
    terminalHelper: { name: "node-pty", version: "1.1.0" },
    xterm: { name: "@xterm/xterm", version: "6.0.0" },
    browsers: ["chromium", "firefox", "webkit"],
    portalAssetDigest: hash("portal"),
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PR-6 real daemon rollback composition", () => {
  it("uses live metadata and event reset while preserving the daemon-created tmux identity", async () => {
    const root = temporary("pr6");
    const repository = join(root, "repository");
    const activePackage = join(root, "active-package");
    const candidatePackage = join(root, "candidate-package");
    const state = join(repository, ".nanasa", "state");
    const generated = join(repository, ".nanasa", "integrations", "generated");
    mkdirSync(state, { recursive: true });
    mkdirSync(generated, { recursive: true });
    mkdirSync(join(activePackage, "dist", "meta"), { recursive: true });
    mkdirSync(join(candidatePackage, "dist", "meta"), { recursive: true });
    execFileSync("git", ["init", "--quiet", repository]);
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Nanasa Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { stdio: "ignore" },
    );
    const provider = join(root, "pi");
    writeFileSync(
      provider,
      "#!/bin/sh\nprintf 'ready\\n'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
      { mode: 0o700 },
    );
    chmodSync(provider, 0o700);
    const config = join(repository, ".nanasa", "config.yaml");
    const lock = join(repository, ".nanasa", "extensions.lock.yaml");
    const overlay = join(generated, "worker.json");
    const newOverlay = join(generated, "candidate.json");
    writeFileSync(
      config,
      `version: 2
repository: { path: ., checkout: { kind: current } }
instructions: []
integrations:
  fixture:
    name: Fixture
    kind: pi
    command: [${JSON.stringify(provider)}]
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
    model: { resumePolicy: preserve-session }
    nativeRecovery: { mode: resume-or-restart, confirmationTimeoutSeconds: 30 }
extensions: {}
roles: {}
groups: {}
messages: { retentionPerGroup: 100 }
`,
    );
    writeFileSync(lock, "version: 1\nrevision: 3\nextensions: {}\n");
    writeFileSync(overlay, '{"revision":3}\n');
    const database = join(state, "nanasa.sqlite");
    new NanasaStore(database).close();
    writeFileSync(
      join(activePackage, "dist", "meta", "build.json"),
      `${JSON.stringify(build("a".repeat(40), "0.1.0-next.11.0"))}\n`,
    );
    writeFileSync(
      join(candidatePackage, "dist", "meta", "build.json"),
      `${JSON.stringify(build("b".repeat(40), "0.1.0-next.13.0"))}\n`,
    );

    const port = await freePort();
    const processes = new Map<string, ChildProcess>();
    const instances: ReleaseService[] = [];
    const calls: string[] = [];
    const serviceFactory = (packageRoot: string): ReleaseService => {
      const service: ReleaseService = {
        install: () => calls.push(`install:${packageRoot}`),
        start: () => {
          calls.push(`start:${packageRoot}`);
          processes.set(
            packageRoot,
            spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                resolve(import.meta.dirname, "fixtures/release-service-process.ts"),
              ],
              {
                stdio: "ignore",
                env: {
                  ...process.env,
                  NANASA_TEST_REPOSITORY: repository,
                  NANASA_TEST_DATABASE: database,
                  NANASA_TEST_PORT: String(port),
                  NANASA_TEST_CANDIDATE: packageRoot === candidatePackage ? "1" : "0",
                  NANASA_TEST_CONFIG: config,
                  NANASA_TEST_LOCK: lock,
                  NANASA_TEST_OVERLAY: overlay,
                  NANASA_TEST_NEW_OVERLAY: newOverlay,
                },
              },
            ),
          );
        },
        stop: () => {
          calls.push(`stop:${packageRoot}`);
          const child = processes.get(packageRoot);
          if (child?.pid !== undefined) {
            child.kill("SIGTERM");
            try {
              execFileSync("tail", ["--pid", String(child.pid), "-f", "/dev/null"], {
                stdio: "ignore",
                timeout: 5_000,
              });
            } catch {
              child.kill("SIGKILL");
            }
          }
          processes.delete(packageRoot);
        },
        waitReady: async (timeoutMs = 5_000) => {
          calls.push(`ready:${packageRoot}`);
          let ready = false;
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/api/v1/meta`);
              ready =
                response.ok &&
                ((await response.json()) as { lifecycle?: string }).lifecycle === "ready";
              if (ready) break;
            } catch {
              /* bounded readiness polling */
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 10));
          }
          if (!ready) throw new Error("actual metadata readiness failed");
          if (packageRoot === candidatePackage)
            throw new Error("injected candidate readiness failure");
        },
      };
      instances.push(service);
      return service;
    };
    const restartFrames: unknown[] = [];
    const manager = new ReleaseManager(repository, activePackage, {
      serviceFactory,
      onPlannedRestart: (frame) => restartFrames.push(frame),
      readinessTimeoutMs: 5_000,
    });
    instances[0]!.install();
    instances[0]!.start();
    await instances[0]!.waitReady(5_000);
    const secret = readFileSync(join(repository, ".nanasa", "runtime", "operator-secret")).toString(
      "base64url",
    );
    const api = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`command failed ${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const group = await api("/api/v1/groups", { name: "Live" });
    const agent = await api(`/api/v1/groups/${String(group.id)}/agents`, {
      name: "Run",
      integrationId: "fixture",
    });
    const run = await api(`/api/v1/groups/${String(group.id)}/agents/${String(agent.id)}/run`, {
      cols: 100,
      rows: 30,
    });
    const terminal = run.terminal as { serverName: string; paneId: string };
    const panePid = Number(
      execFileSync(
        "tmux",
        ["-L", terminal.serverName, "display-message", "-p", "-t", terminal.paneId, "#{pane_pid}"],
        { encoding: "utf8" },
      ).trim(),
    );
    const paneStart = readFileSync(`/proc/${panePid}/stat`, "utf8").split(" ")[21];
    const artifacts = new Map(
      [config, lock, overlay].map((path) => [path, hash(readFileSync(path))]),
    );
    const events: unknown[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?after=0`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));
    await once(socket, "open");

    await expect(manager.upgrade(candidatePackage)).rejects.toThrow(
      "injected candidate readiness failure",
    );
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "subscription.started" })]),
    );
    expect(restartFrames).toEqual([
      expect.objectContaining({ type: "service.restart", resnapshotRequired: true }),
    ]);
    expect(readFileSync(`/proc/${panePid}/stat`, "utf8").split(" ")[21]).toBe(paneStart);
    for (const [path, expected] of artifacts) expect(hash(readFileSync(path))).toBe(expected);
    expect(existsSync(newOverlay)).toBe(false);
    expect(manager.activePointer()).toMatchObject({ packageRoot: activePackage });
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/meta`)).ok).toBe(true);
    const snapshot = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(snapshot.ok).toBe(true);
    expect(
      ((await snapshot.json()) as { groups: Array<{ name: string }> }).groups.map(
        (item) => item.name,
      ),
    ).toEqual(["Live"]);
    const resets: unknown[] = [];
    const reconnect = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?after=0&instance=stale`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    reconnect.on("message", (data) => resets.push(JSON.parse(data.toString())));
    await once(reconnect, "open");
    for (let attempt = 0; attempt < 100 && resets.length === 0; attempt += 1)
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(resets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subscription.reset-required",
          reason: "instance_changed",
        }),
      ]),
    );

    socket.close();
    reconnect.close();
    for (const process of processes.values()) process.kill("SIGTERM");
    execFileSync("tmux", ["-L", terminal.serverName, "kill-server"]);
    expect(calls).toEqual(
      expect.arrayContaining([
        `start:${candidatePackage}`,
        `stop:${candidatePackage}`,
        `start:${activePackage}`,
        `ready:${activePackage}`,
      ]),
    );
  }, 30_000);
});
