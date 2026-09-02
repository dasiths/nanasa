import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBuildIdentity } from "../apps/daemon/src/release/build-identity.js";
import { buildRemoteSshPlan, RemoteSshSession } from "../apps/daemon/src/remote/remote-ssh.js";
import { SystemdUserService } from "../apps/daemon/src/service/systemd-user-service.js";

const mode = process.argv[2];
const candidate = process.env.NANASA_CERT_CANDIDATE_SHA;
if (!/^[a-f0-9]{40}$/.test(candidate ?? "")) throw new Error("Exact candidate SHA is required");
const packageRoot = resolve(import.meta.dirname, "..");
const build = loadBuildIdentity(packageRoot);
if (build.commit !== candidate) throw new Error("Candidate build identity does not match checkout");

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("No port"));
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
}

function initializeRepository(root: string): void {
  mkdirSync(join(root, ".nanasa"), { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Nanasa Certification",
      "-c",
      "user.email=certification@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "certification fixture",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(
    join(root, ".nanasa", "config.yaml"),
    "version: 2\nrepository: { path: ., checkout: { kind: current } }\ninstructions: []\nintegrations: {}\nextensions: {}\nroles: {}\ngroups: {}\nmessages: { retentionPerGroup: 100 }\n",
    { mode: 0o600 },
  );
}

async function systemd(): Promise<void> {
  if (!process.env.XDG_RUNTIME_DIR || !process.env.DBUS_SESSION_BUS_ADDRESS) {
    throw new Error("A persistent systemd user manager is required");
  }
  const temporary = mkdtempSync(join(tmpdir(), "nanasa-systemd-cert-"));
  const repository = join(temporary, "repository");
  initializeRepository(repository);
  const providerPath = join(temporary, "provider");
  writeFileSync(
    providerPath,
    "#!/bin/sh\nprintf 'ready\\n'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
    {
      mode: 0o700,
    },
  );
  chmodSync(providerPath, 0o700);
  writeFileSync(
    join(repository, ".nanasa", "config.yaml"),
    `version: 2
repository: { path: ., checkout: { kind: current } }
instructions: []
integrations:
  certification:
    name: Systemd certification
    kind: pi
    command: [${JSON.stringify(providerPath)}]
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
    { mode: 0o600 },
  );
  const port = await reservePort();
  const service = new SystemdUserService({ repositoryRoot: repository, packageRoot, port });
  let installed = false;
  let tmuxServer: string | undefined;
  try {
    const installedStatus = service.install();
    installed = true;
    if (installedStatus.state === "unsupported") throw new Error("systemd is unsupported");
    service.start();
    const firstReady = await service.waitReady(30_000);
    if (firstReady.state !== "ready") throw new Error("Candidate service did not become ready");
    const secret = readFileSync(join(repository, ".nanasa", "runtime", "operator-secret")).toString(
      "base64url",
    );
    const request = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Live service operation failed: ${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const group = await request("/api/v1/groups", { name: "Systemd certification" });
    const agent = await request(`/api/v1/groups/${String(group.id)}/agents`, {
      name: "Service-owned run",
      integrationId: "certification",
    });
    const run = await request(`/api/v1/groups/${String(group.id)}/agents/${String(agent.id)}/run`, {
      cols: 100,
      rows: 30,
    });
    const terminal = run.terminal as { serverName: string; paneId: string } | undefined;
    if (terminal === undefined) throw new Error("Live service did not create a tmux binding");
    tmuxServer = terminal.serverName;
    const panePid = Number(
      execFileSync(
        "tmux",
        ["-L", tmuxServer, "display-message", "-p", "-t", terminal.paneId, "#{pane_pid}"],
        { encoding: "utf8" },
      ).trim(),
    );
    const processStart = readFileSync(`/proc/${panePid}/stat`, "utf8").split(" ")[21];
    service.restart();
    const restarted = await service.waitReady(30_000);
    if (restarted.state !== "ready") throw new Error("Candidate service restart was not ready");
    if (readFileSync(`/proc/${panePid}/stat`, "utf8").split(" ")[21] !== processStart) {
      throw new Error("Service-created tmux process identity changed across restart");
    }
    service.stop();
    if (service.status().state !== "inactive") throw new Error("Candidate service did not stop");
    process.kill(panePid, 0);
    service.remove();
    installed = false;
    if (service.status().state !== "not-installed")
      throw new Error("Candidate service remained installed");
    if (readFileSync(`/proc/${panePid}/stat`, "utf8").split(" ")[21] !== processStart) {
      throw new Error("Service-created tmux process identity changed after stop");
    }
  } finally {
    if (installed) service.remove();
    if (tmuxServer !== undefined) {
      try {
        execFileSync("tmux", ["-L", tmuxServer, "kill-server"], { stdio: "ignore" });
      } catch {
        // Cleanup remains best effort after a failed prerequisite.
      }
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function ssh(): Promise<void> {
  const target = process.env.NANASA_CERT_SSH_TARGET;
  const repository = process.env.NANASA_CERT_SSH_REPOSITORY;
  if (!target || !repository) throw new Error("Configured SSH target and repository are required");
  const plan = buildRemoteSshPlan(target, repository);
  const session = new RemoteSshSession(plan, build);
  try {
    const first = await session.discover();
    if (
      first.build.commit !== candidate ||
      first.repositoryId.length === 0 ||
      first.instanceId.length === 0 ||
      first.service.state !== "ready"
    ) {
      throw new Error(
        "Remote repository, instance, build, protocol, or service identity mismatched",
      );
    }
    const firstConnection = await session.connect(first);
    const metadata = (
      await fetch(new URL("/api/v1/meta", firstConnection.localUrl))
    ).json() as Promise<{
      repositoryId?: string;
      instanceId?: string;
      buildCommit?: string;
      apiVersion?: number;
      eventProtocolVersion?: number;
    }>;
    const firstMetadata = await metadata;
    if (
      firstMetadata.repositoryId !== first.repositoryId ||
      firstMetadata.instanceId !== first.instanceId ||
      firstMetadata.buildCommit !== candidate ||
      firstMetadata.apiVersion !== first.apiVersion ||
      firstMetadata.eventProtocolVersion !== first.eventProtocolVersion
    ) {
      throw new Error("Forwarded Nanasa metadata did not match remote discovery");
    }
    await session.close();
    const rediscovered = await session.discover();
    if (
      rediscovered.instanceId !== first.instanceId ||
      rediscovered.repositoryId !== first.repositoryId
    ) {
      throw new Error("Remote continuity identity changed across reconnect");
    }
    const secondConnection = await session.connect(rediscovered);
    const response = await fetch(new URL("/health/ready", secondConnection.localUrl));
    if (!response.ok) throw new Error("Reconnected Nanasa service was not ready");
  } finally {
    await session.close();
  }
}

if (mode === "systemd") await systemd();
else if (mode === "ssh") await ssh();
else throw new Error("Unknown external runtime certification mode");
