import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ErrorPayloadSchema, type ErrorPayload } from "@nanasa/contracts";
import { ControlClientError } from "@nanasa/control-client";
import WebSocket from "ws";
import { authenticateAgent, CliAdminError, doctorIntegrations } from "../cli-admin.js";
import { matchControlRoute } from "../http/route-registry.js";
import { repositoryIdentity } from "../protocol-metadata.js";
import { loadBuildIdentity } from "../release/build-identity.js";
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
  outputExplicit: boolean;
  forceJson: boolean;
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
  const options: ParsedOptions = {
    positionals: [],
    output: "json",
    outputExplicit: false,
    forceJson: false,
    timeoutMs: 30_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (!argument.startsWith("--")) {
      options.positionals.push(argument);
      continue;
    }
    if (argument === "--json") {
      options.forceJson = true;
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
      options.outputExplicit = true;
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
  const required = declaration.positionals.filter((name) => !name.endsWith("?")).length;
  if (
    options.positionals.length < required ||
    options.positionals.length > declaration.positionals.length
  ) {
    const suffix = declaration.positionals
      .map((name) => (name.endsWith("?") ? `[<${name.slice(0, -1)}>]` : `<${name}>`))
      .join(" ");
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

type RecoveryOutput = {
  readonly memberId: string;
  readonly status:
    | "retained"
    | "restarted"
    | "approval-required"
    | "ownership-uncertain"
    | "failed";
  readonly safeError?: { readonly message: string };
};

function recoveryOutcomes(value: unknown): readonly RecoveryOutput[] {
  if (typeof value !== "object" || value === null) return [];
  const result = value as { readonly outcomes?: unknown };
  return Array.isArray(result.outcomes)
    ? (result.outcomes as RecoveryOutput[])
    : [value as RecoveryOutput];
}

export function providerRecoveryOutput(value: unknown, dryRun: boolean): string {
  const outcomes = recoveryOutcomes(value);
  if (outcomes.length === 0) return "No active runs need recovery";
  const width = Math.max(...outcomes.map((outcome) => outcome.memberId.length)) + 2;
  return outcomes
    .map((outcome) => {
      let summary: string;
      if (outcome.status === "retained") summary = dryRun ? "would keep running" : "kept running";
      else if (outcome.status === "restarted") {
        summary = dryRun
          ? "would restart (agent tools changed)"
          : "restarted (agent tools changed)";
      } else if (outcome.status === "approval-required") summary = "approval required";
      else if (outcome.status === "ownership-uncertain") {
        summary = "failed (Nanasa could not safely identify the old process)";
      } else summary = `failed (${outcome.safeError?.message ?? "recovery did not complete"})`;
      return `${outcome.memberId.padEnd(width)}${summary}`;
    })
    .join("\n");
}

export function providerRecoveryExitCode(value: unknown): 0 | 1 | 3 {
  const statuses = recoveryOutcomes(value).map((outcome) => outcome.status);
  if (statuses.some((status) => status === "failed" || status === "ownership-uncertain")) return 1;
  return statuses.includes("approval-required") ? 3 : 0;
}

export function portalBootstrapUrl(apiUrl: string, fragment: string): string {
  const url = new URL("/", apiUrl);
  url.hash = fragment;
  return url.toString();
}

function failurePayload(error: unknown): ErrorPayload {
  if (error instanceof ControlClientError) return error.toPayload();
  if (error instanceof CliUsageError) {
    return ErrorPayloadSchema.parse({
      message: error.message,
      code: "cli_usage_error",
    });
  }
  if (error instanceof CliAdminError) {
    return ErrorPayloadSchema.parse({
      message: error.message,
      details: error.details,
      code: error.code,
    });
  }
  if (error instanceof Error && "cause" in error && error.cause !== undefined) {
    return ErrorPayloadSchema.parse({
      message: "The repository daemon is not reachable",
      code: "daemon_not_running",
    });
  }
  return ErrorPayloadSchema.parse({
    message: error instanceof Error ? error.message : "Control request failed",
    code: "control_request_failed",
  });
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
): Promise<0 | 1 | 2 | 3> {
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
      await authenticateAgent(repositoryRoot, options.positionals[0] as string, options.agentId);
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
      const path = (declaration.path as (args: readonly string[]) => string)(options.positionals);
      const route = matchControlRoute(declaration.method, path);
      if (declaration.mutating && route === undefined) {
        throw new Error(`Control command ${declaration.id} has no shared route declaration`);
      }
      if (route?.idempotency === "forbidden" && options.idempotencyKey !== undefined) {
        throw new CliUsageError(`Control command ${declaration.id} forbids --idempotency-key`);
      }
      const headers: Record<string, string> = {};
      if (declaration.mutating && route?.idempotency !== "forbidden") {
        headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
      }
      if (options.requestId !== undefined) headers["X-Request-Id"] = options.requestId;
      if (declaration.body !== "none") headers["Content-Type"] = "application/json; charset=utf-8";
      const value = await loaded.transport.request(path, declaration.response, {
        init: {
          method: declaration.method,
          headers,
          signal: controller.signal,
          ...(declaration.body === "none" ? {} : { body: JSON.stringify(options.body ?? {}) }),
        },
      });
      const outputValue =
        declaration.id === "auth.portal"
          ? {
              text: portalBootstrapUrl(loaded.apiUrl, (value as { fragment: string }).fragment),
            }
          : declaration.id === "run.recover" &&
              !options.forceJson &&
              (!options.outputExplicit || options.output === "text")
            ? {
                text: providerRecoveryOutput(
                  value,
                  (options.body as { dryRun?: unknown } | undefined)?.dryRun === true,
                ),
              }
            : value;
      const outputMode = options.forceJson
        ? "json"
        : options.outputExplicit
          ? options.output
          : declaration.output;
      outputSuccess(outputValue, outputMode, stdout);
      return declaration.id === "run.recover" ? providerRecoveryExitCode(value) : 0;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    stderr.write(`${JSON.stringify(failurePayload(error))}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}
