import { type ChildProcess, spawn } from "node:child_process";
import { connect as connectSocket, createServer } from "node:net";
import { resolve } from "node:path";
import type { BuildIdentity, RemoteDescriptor } from "@nanasa/contracts";
import { assertCompatibleRemote } from "./remote-descriptor.js";

const SSH_USER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const SSH_HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function assertSshTarget(value: string): void {
  if (
    value.startsWith("-") ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error("SSH target must not be an option or contain control characters");
  }
  const parts = value.split("@");
  if (parts.length > 2) throw new Error("SSH target must be a host or user@host without options");
  const host = parts.at(-1) ?? "";
  const user = parts.length === 2 ? parts[0] : undefined;
  if (!SSH_HOST.test(host) || host.includes("..") || (user !== undefined && !SSH_USER.test(user))) {
    throw new Error("SSH target must be a host or user@host without options");
  }
}

function shellQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r"))
    throw new Error("Remote values must be single-line");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface RemoteSshPlan {
  readonly target: string;
  readonly repositoryPath: string;
  readonly discoveryArgs: readonly string[];
  lifecycleArgs(operation: "start" | "restart"): readonly string[];
  tunnelArgs(localPort: number, descriptor: RemoteDescriptor): readonly string[];
  readonly reconnectCommand: string;
}

export function buildRemoteSshPlan(target: string, repositoryPath: string): RemoteSshPlan {
  assertSshTarget(target);
  if (!repositoryPath.startsWith("/")) throw new Error("Remote repository path must be absolute");
  const repository = resolve(repositoryPath);
  const remoteCommand = `nanasa remote describe --repo ${shellQuote(repository)}`;
  return {
    target,
    repositoryPath: repository,
    discoveryArgs: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      target,
      remoteCommand,
    ],
    lifecycleArgs: (operation) => [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      target,
      `nanasa service ${operation} --repo ${shellQuote(repository)}`,
    ],
    tunnelArgs: (localPort, descriptor) => {
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
        throw new Error("SSH local forwarding port is invalid");
      }
      if (
        descriptor.loopbackHost !== "127.0.0.1" ||
        !Number.isInteger(descriptor.port) ||
        descriptor.port < 1 ||
        descriptor.port > 65_535
      ) {
        throw new Error("SSH remote forwarding endpoint must be a valid IPv4 loopback port");
      }
      return [
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
        `127.0.0.1:${localPort}:${descriptor.loopbackHost}:${descriptor.port}`,
        target,
      ];
    },
    reconnectCommand: `nanasa remote connect ${target} ${shellQuote(repository)}`,
  };
}

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error === undefined ? resolvePort(port) : reject(error)));
    });
  });
}

async function waitForTunnel(port: number, child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `SSH tunnel exited before readiness with ${child.exitCode ?? child.signalCode}`,
      );
    }
    const connected = await new Promise<boolean>((resolveConnection) => {
      const socket = connectSocket({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolveConnection(true);
      });
      socket.once("error", () => resolveConnection(false));
    });
    if (connected) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`SSH tunnel did not bind its loopback port within ${timeoutMs}ms`);
}

export class RemoteSshSession {
  readonly #plan: RemoteSshPlan;
  readonly #build: BuildIdentity;
  readonly #spawn: typeof spawn;
  #tunnel: ChildProcess | undefined;

  public constructor(
    plan: RemoteSshPlan,
    build: BuildIdentity,
    spawnProcess: typeof spawn = spawn,
  ) {
    this.#plan = plan;
    this.#build = build;
    this.#spawn = spawnProcess;
  }

  public async discover(): Promise<RemoteDescriptor> {
    const child = this.#spawn("ssh", [...this.#plan.discoveryArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const code = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (value) => resolveExit(value ?? 1));
    });
    if (code !== 0)
      throw new Error(`Remote service discovery failed: ${stderr.trim() || `ssh exited ${code}`}`);
    const { RemoteDescriptorSchema } = await import("@nanasa/contracts");
    const descriptor = RemoteDescriptorSchema.parse(JSON.parse(stdout));
    assertCompatibleRemote(this.#build, descriptor);
    return descriptor;
  }

  public async service(operation: "start" | "restart"): Promise<RemoteDescriptor> {
    const child = this.#spawn("ssh", [...this.#plan.lifecycleArgs(operation)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const code = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (value) => resolveExit(value ?? 1));
    });
    if (code !== 0) {
      throw new Error(
        `Remote service ${operation} failed: ${stderr.trim() || `ssh exited ${code}`}`,
      );
    }
    return this.discover();
  }

  public async connect(
    descriptor: RemoteDescriptor,
  ): Promise<{ localUrl: string; reconnectCommand: string }> {
    if (descriptor.service.state !== "ready") {
      throw new Error(`Remote service is ${descriptor.service.state}; start it before connecting`);
    }
    const localPort = await reserveLoopbackPort();
    const child = this.#spawn("ssh", [...this.#plan.tunnelArgs(localPort, descriptor)], {
      stdio: "inherit",
    });
    await new Promise<void>((resolveStarted, reject) => {
      child.once("error", reject);
      child.once("spawn", resolveStarted);
      child.once("exit", (code) =>
        reject(new Error(`SSH tunnel exited before readiness with ${code ?? 1}`)),
      );
    });
    await waitForTunnel(localPort, child);
    this.#tunnel = child;
    return {
      localUrl: `http://127.0.0.1:${localPort}`,
      reconnectCommand: this.#plan.reconnectCommand,
    };
  }

  public async close(): Promise<void> {
    const tunnel = this.#tunnel;
    this.#tunnel = undefined;
    if (tunnel === undefined || tunnel.exitCode !== null || tunnel.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit) => tunnel.once("exit", () => resolveExit()));
    tunnel.kill("SIGTERM");
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("SSH tunnel did not close after SIGTERM")),
            5_000,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
