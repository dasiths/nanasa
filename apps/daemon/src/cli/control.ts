import { randomUUID } from "node:crypto";
import { ControlClientError } from "@nanasa/control-client";
import WebSocket from "ws";
import { authenticateAgent, doctorIntegrations } from "../cli-admin.js";
import {
  CLI_COMMAND_REGISTRY,
  commandRegistryHelp,
  findCliCommand,
  type CliCommandDeclaration,
} from "./command-registry.js";
import { loadControlClient } from "./control-client-loader.js";

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
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
