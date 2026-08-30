import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ControlClientError } from "@nanasa/control-client";
import WebSocket from "ws";
import { authenticateAgent, doctorIntegrations } from "../cli-admin.js";
import { DATABASE_SCHEMA_VERSION } from "../persistence/database.js";
import { repositoryIdentity } from "../protocol-metadata.js";
import { loadBuildIdentity } from "../release/build-identity.js";
import { MigrationRunner } from "../release/migration-runner.js";
import { ReleaseManager } from "../release/release-manager.js";
import { createRemoteDescriptor } from "../remote/remote-descriptor.js";
import { buildRemoteSshPlan, RemoteSshSession } from "../remote/remote-ssh.js";
import { SystemdUserService } from "../service/systemd-user-service.js";
import {
  CLI_COMMAND_REGISTRY,
  type CliCommandDeclaration,
  commandRegistryHelp,
  findCliCommand,
} from "./command-registry.js";
import { loadControlClient } from "./control-client-loader.js";

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function publicPackageRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (value.name === "nanasa") return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) throw new Error("Unable to discover the Nanasa package root");
    current = parent;
  }
}

interface ParsedOptions {
  positionals: string[];
  body?: unknown;
  apiUrl?: string;
  operatorTokenFile?: string;
  idempotencyKey?: string;
  requestId?: string;
  output: "json" | "text";
  timeoutMs: number;
  agentId?: string;
  remoteRepo?: string;
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${option} requires a value`);
  }
  return value;
}

function parseOptions(args: readonly string[]): ParsedOptions {
  const options: ParsedOptions = { positionals: [], output: "json", timeoutMs: 30_000 };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (!argument.startsWith("--")) {
      options.positionals.push(argument);
      continue;
    }
    if (argument === "--json") {
      options.output = "json";
      continue;
    }
    const value = optionValue(args, index, argument);
    index += 1;
    if (argument === "--body") {
      try {
        options.body = JSON.parse(value) as unknown;
      } catch {
        throw new CliUsageError("--body must contain valid JSON");
      }
    } else if (argument === "--api-url") options.apiUrl = value;
    else if (argument === "--operator-token-file") options.operatorTokenFile = value;
    else if (argument === "--idempotency-key") options.idempotencyKey = value;
    else if (argument === "--request-id") options.requestId = value;
    else if (argument === "--output") {
      if (value !== "json" && value !== "text") {
        throw new CliUsageError("--output must be json or text");
      }
      options.output = value;
    } else if (argument === "--timeout") {
      options.timeoutMs = Number(value);
      if (
        !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 300_000
      ) {
        throw new CliUsageError("--timeout must be an integer from 1 to 300000 milliseconds");
      }
    } else if (argument === "--agent") options.agentId = value;
    else if (argument === "--repo") options.remoteRepo = value;
    else throw new CliUsageError(`Unknown option: ${argument}`);
  }
  return options;
}

function selectCommand(args: readonly string[]): {
  declaration: CliCommandDeclaration;
  remainder: readonly string[];
} {
  const family = args[0];
  if (family === undefined) throw new CliUsageError("A command family is required");
  if (family === "completion") {
    const declaration = findCliCommand("completion", "generate") as CliCommandDeclaration;
    return { declaration, remainder: args.slice(1) };
  }
  if (family === "doctor") {
    const declaration = findCliCommand("doctor", "run") as CliCommandDeclaration;
    return { declaration, remainder: args.slice(1) };
  }
  const name = args[1];
  if (name === undefined) throw new CliUsageError(`${family} requires a command`);
  const declaration = findCliCommand(family, name);
  if (declaration === undefined) throw new CliUsageError(`Unknown command: ${family} ${name}`);
  return { declaration, remainder: args.slice(2) };
}

function assertArguments(declaration: CliCommandDeclaration, options: ParsedOptions): void {
  if (options.positionals.length !== declaration.positionals.length) {
    const suffix = declaration.positionals.map((name) => `<${name}>`).join(" ");
    throw new CliUsageError(
      `Usage: nanasa ${declaration.family} ${declaration.command}${suffix.length === 0 ? "" : ` ${suffix}`}`,
    );
  }
  if (declaration.body === "required" && options.body === undefined) {
    throw new CliUsageError(`${declaration.family} ${declaration.command} requires --body <json>`);
  }
  if (declaration.body === "none" && options.body !== undefined) {
    throw new CliUsageError(`${declaration.family} ${declaration.command} does not accept --body`);
  }
}

function completion(shell: string): string {
  const words = [...new Set(CLI_COMMAND_REGISTRY.map((entry) => entry.family))].join(" ");
  if (shell === "bash") return `complete -W '${words}' nanasa\n`;
  if (shell === "zsh") return `#compdef nanasa\n_arguments '1:command:(${words})'\n`;
  if (shell === "fish")
    return (
      words
        .split(" ")
        .map((word) => `complete -c nanasa -f -a '${word}'`)
        .join("\n") + "\n"
    );
  if (shell === "powershell")
    return `Register-ArgumentCompleter -CommandName nanasa -ScriptBlock { '${words}' -split ' ' }\n`;
  throw new CliUsageError("completion shell must be bash, zsh, fish, or powershell");
}

function outputSuccess(value: unknown, mode: "json" | "text", output: NodeJS.WritableStream): void {
  if (mode === "text" && typeof value === "object" && value !== null && "text" in value) {
    const text = String((value as { text: unknown }).text);
    output.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  output.write(`${JSON.stringify(value ?? null)}\n`);
}

function failurePayload(error: unknown): unknown {
  if (error instanceof ControlClientError && error.payload !== undefined) return error.payload;
  if (error instanceof Error && "cause" in error && error.cause !== undefined) {
    return {
      version: 1,
      requestId: `cli_${randomUUID()}`,
      error: {
        code: "daemon_not_running",
        message: "The repository daemon is not reachable",
        retryable: true,
      },
    };
  }
  return {
    version: 1,
    requestId: `cli_${randomUUID()}`,
    error: {
      code:
        error instanceof ControlClientError
          ? (error.code ?? "control_request_failed")
          : "control_request_failed",
      message: error instanceof Error ? error.message : "Control request failed",
      retryable: false,
    },
  };
}

async function watchEvents(
  apiUrl: string,
  token: string,
  timeoutMs: number,
  output: NodeJS.WritableStream,
): Promise<void> {
  const url = new URL("/api/v1/events?after=0", apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const timer = setTimeout(() => {
      socket.close(1000, "cli_timeout");
      resolve();
    }, timeoutMs);
    timer.unref();
    const interrupt = () => socket.close(1000, "cli_interrupt");
    process.once("SIGINT", interrupt);
    socket.on("message", (data) => output.write(`${data.toString()}\n`));
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupt);
      resolve();
    });
  });
}

export function controlHelp(): string {
  return commandRegistryHelp();
}

export async function runControlCli(
  args: readonly string[],
  repositoryRoot: string,
  streams: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream } = {},
): Promise<0 | 1 | 2> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  try {
    const { declaration, remainder } = selectCommand(args);
    const options = parseOptions(remainder);
    assertArguments(declaration, options);
    if (declaration.id === "completion.generate") {
      stdout.write(completion(options.positionals[0] as string));
      return 0;
    }
    if (declaration.id === "doctor.run") {
      doctorIntegrations(repositoryRoot);
      return 0;
    }
    if (declaration.id === "auth.login") {
      authenticateAgent(repositoryRoot, options.positionals[0] as string, options.agentId);
      return 0;
    }
    const packageRoot = publicPackageRoot(import.meta.dirname);
    const service = new SystemdUserService({ repositoryRoot, packageRoot });
    if (declaration.family === "service") {
      let value: unknown;
      if (declaration.command === "install") value = service.install();
      else if (declaration.command === "status") value = service.status();
      else if (declaration.command === "start") value = service.start();
      else if (declaration.command === "stop") value = service.stop();
      else if (declaration.command === "restart") value = service.restart();
      else if (declaration.command === "remove") value = service.remove();
      else if (declaration.command === "logs") value = { text: service.logs() };
      else if (declaration.command === "wait-ready")
        value = await service.waitReady(options.timeoutMs);
      else if (declaration.command === "upgrade") {
        value = await new ReleaseManager(repositoryRoot, packageRoot).upgrade(
          options.positionals[0] as string,
        );
      } else if (declaration.command === "rollback") {
        await new ReleaseManager(repositoryRoot, packageRoot).restoreBackup(
          options.positionals[0] as string,
        );
        value = { restored: options.positionals[0] };
      }
      outputSuccess(value, declaration.command === "logs" ? "text" : "json", stdout);
      return 0;
    }
    if (declaration.family === "migration") {
      const runner = new MigrationRunner(
        join(repositoryRoot, ".nanasa", "state", "nanasa.sqlite"),
        DATABASE_SCHEMA_VERSION,
      );
      outputSuccess(
        declaration.command === "probe" ? runner.preflight() : runner.apply(),
        "json",
        stdout,
      );
      return 0;
    }
    if (declaration.id === "remote.describe") {
      const build = loadBuildIdentity(packageRoot);
      const descriptor = createRemoteDescriptor({
        repositoryId: repositoryIdentity(repositoryRoot),
        instanceId: service.name,
        build,
        service: service.status(),
      });
      outputSuccess(descriptor, "json", stdout);
      return 0;
    }
    if (declaration.id.startsWith("remote.") && declaration.id !== "remote.describe") {
      if (options.remoteRepo === undefined) {
        throw new CliUsageError(`remote ${declaration.command} requires --repo <absolute-path>`);
      }
      const build = loadBuildIdentity(packageRoot);
      const session = new RemoteSshSession(
        buildRemoteSshPlan(options.positionals[0] as string, options.remoteRepo),
        build,
      );
      if (declaration.command === "start" || declaration.command === "restart") {
        outputSuccess(await session.service(declaration.command), "json", stdout);
        return 0;
      }
      const descriptor = await session.discover();
      const connection = await session.connect(descriptor);
      outputSuccess(connection, "json", stdout);
      const browser = process.env.BROWSER;
      if (browser !== undefined && browser.length > 0) {
        const { spawn } = await import("node:child_process");
        spawn(browser, [connection.localUrl], { detached: true, stdio: "ignore" }).unref();
      }
      return 0;
    }

    const loaded = loadControlClient(repositoryRoot, {
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.operatorTokenFile === undefined
        ? {}
        : { operatorTokenFile: options.operatorTokenFile }),
    });
    if (declaration.mode === "events") {
      await loaded.resources.metadata.get();
      await watchEvents(loaded.apiUrl, loaded.operatorToken, options.timeoutMs, stdout);
      return 0;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    timer.unref();
    try {
      if (declaration.method === undefined || declaration.path === undefined) {
        throw new Error(`Control command ${declaration.id} has no HTTP binding`);
      }
      const headers: Record<string, string> = {};
      if (declaration.mutating) {
        headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
      }
      if (options.requestId !== undefined) headers["X-Request-Id"] = options.requestId;
      if (declaration.body !== "none") headers["Content-Type"] = "application/json; charset=utf-8";
      const value = await loaded.transport.request(
        (declaration.path as (args: readonly string[]) => string)(options.positionals),
        declaration.response,
        {
          init: {
            method: declaration.method,
            headers,
            signal: controller.signal,
            ...(declaration.body === "none" ? {} : { body: JSON.stringify(options.body ?? {}) }),
          },
        },
      );
      outputSuccess(value, options.output === "text" ? "text" : declaration.output, stdout);
      return 0;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr.write(`${error.message}\n`);
      return 2;
    }
    stderr.write(`${JSON.stringify(failurePayload(error))}\n`);
    return 1;
  }
}
