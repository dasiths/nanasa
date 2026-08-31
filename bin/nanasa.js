#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configRelativePath = join(".nanasa", "config.yaml");

function usage() {
  return `Usage: nanasa [start] [options]
       nanasa init
       nanasa setup
  nanasa doctor
  nanasa auth login <integration> [--agent <agent-id>]
  nanasa auth portal
      nanasa reset --from-alpha --confirm <repository-root>
  nanasa <family> <command> [arguments] [--body <json>]

Commands:
  start              Start the daemon and portal (default)
  init               Create .nanasa/config.yaml when absent
  setup              Prepare repository-local integration configuration homes
  doctor             Validate configuration, commands, and integration homes
  auth               Authenticate locally or inspect daemon auth state
  reset              Back up and destructively reset alpha config, state, and owned runtimes

Operational families:
  metadata config auth state trust extension group role run status message agent action
  wait terminal console checkout worktree events api daemon service migration remote completion

Options:
  --host <host>       Listen host; MCP requires loopback (default: 127.0.0.1)
  --port <port>       Listen port (default: NANASA_PORT or 3210)
  --mcp               Enable authenticated MCP (default path: /mcp)
  -h, --help          Show this help
  -v, --version       Show the installed version`;
}

class UsageError extends Error {}

function ensureNanasaIgnore(root) {
  const path = join(root, ".nanasa", ".gitignore");
  const required = ["/integrations/", "/runtime/", "/state/"];
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/).filter(Boolean));
  const missing = required.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  writeFileSync(path, `${prefix}${missing.join("\n")}\n`, { encoding: "utf8", mode: 0o644 });
}

function parentDirectories(startPath) {
  const directories = [];
  let current = resolve(startPath);
  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

function findConfigRoot(startPath) {
  return parentDirectories(startPath).find((directory) =>
    existsSync(join(directory, configRelativePath)),
  );
}

function findInitializationRoot(startPath) {
  return (
    findConfigRoot(startPath) ??
    parentDirectories(startPath).find((directory) => existsSync(join(directory, ".git"))) ??
    resolve(startPath)
  );
}

function initialize(startPath, output = process.stdout) {
  const root = findInitializationRoot(startPath);
  const configPath = join(root, configRelativePath);
  if (existsSync(configPath)) {
    ensureNanasaIgnore(root);
    output.write(`Nanasa configuration already exists at ${configPath}\n`);
    return configPath;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  const template = readFileSync(join(packageRoot, "templates", "config.yaml"), "utf8");
  try {
    writeFileSync(configPath, template, { encoding: "utf8", flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      output.write(`Nanasa configuration already exists at ${configPath}\n`);
      return configPath;
    }
    throw error;
  }
  output.write(`Created ${configPath}\n`);
  ensureNanasaIgnore(root);
  return configPath;
}

async function loadAdmin() {
  return import(join(packageRoot, "dist", "cli", "admin.js"));
}

async function loadControl() {
  return import(join(packageRoot, "dist", "cli", "control.js"));
}

function parseResetOptions(args) {
  if (args[0] !== "--from-alpha") {
    throw new UsageError("nanasa reset requires --from-alpha");
  }
  if (args[1] !== "--confirm" || args[2] === undefined || args.length !== 3) {
    throw new UsageError("nanasa reset --from-alpha requires --confirm <repository-root>");
  }
  return { confirmation: resolve(args[2]) };
}

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${option} requires a value`);
  }
  return value;
}

function parseStartOptions(args) {
  const environment = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--host") {
      environment.NANASA_HOST = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--port") {
      environment.NANASA_PORT = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--mcp") {
      environment.NANASA_MCP_ENABLED = "true";
    } else {
      throw new UsageError(`Unknown option: ${argument}`);
    }
  }
  return environment;
}

function packageVersion() {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  return packageJson.version;
}

function packageBuild() {
  const path = join(packageRoot, "dist", "meta", "build.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

async function start(startPath, args) {
  const repositoryRoot = findConfigRoot(startPath);
  if (repositoryRoot === undefined) {
    throw new Error(
      `No .nanasa/config.yaml found from ${resolve(startPath)}. Run nanasa init first.`,
    );
  }
  const options = parseStartOptions(args);
  const build = packageBuild();

  const child = spawn(process.execPath, [join(packageRoot, "dist", "daemon", "index.js")], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...options,
      NODE_ENV: "production",
      NANASA_REPO_ROOT: repositoryRoot,
      NANASA_PACKAGE_ROOT: packageRoot,
      NANASA_PRODUCT_VERSION: packageVersion(),
      ...(build?.commit === undefined ? {} : { NANASA_BUILD_COMMIT: build.commit }),
      NANASA_SERVE_PORTAL: "true",
      NANASA_PORTAL_PATH: join(packageRoot, "dist", "portal"),
    },
  });

  const forward = (signal) => {
    if (child.exitCode === null) child.kill(signal);
  };
  const forwardInterrupt = () => forward("SIGINT");
  const forwardTermination = () => forward("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === null ? 1 : 0)));
  });
  process.removeListener("SIGINT", forwardInterrupt);
  process.removeListener("SIGTERM", forwardTermination);
  process.exitCode = exitCode;
}

export async function main(args = process.argv.slice(2), startPath = process.cwd()) {
  const [command = "start", ...rest] = args;
  if (command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (command === "init") {
    if (rest.length > 0) throw new UsageError("nanasa init does not accept options");
    initialize(startPath);
    return;
  }
  if (["setup", "reset"].includes(command)) {
    const repositoryRoot = findConfigRoot(startPath);
    if (repositoryRoot === undefined) {
      throw new Error(
        `No .nanasa/config.yaml found from ${resolve(startPath)}. Run nanasa init first.`,
      );
    }
    ensureNanasaIgnore(repositoryRoot);
    const admin = await loadAdmin();
    if (command === "setup") {
      if (rest.length > 0) throw new UsageError("nanasa setup does not accept options");
      admin.setupIntegrations(repositoryRoot);
    } else {
      const options = parseResetOptions(rest);
      const template = readFileSync(join(packageRoot, "templates", "config.yaml"), "utf8");
      await admin.resetAlphaRepository(repositoryRoot, options.confirmation, template);
      ensureNanasaIgnore(repositoryRoot);
    }
    return;
  }
  if (command !== "start" && !command.startsWith("--")) {
    const remoteRepoIndex = command === "remote" ? rest.indexOf("--repo") : -1;
    const requestedRemoteRoot =
      remoteRepoIndex >= 0 && rest[remoteRepoIndex + 1] !== undefined
        ? resolve(rest[remoteRepoIndex + 1])
        : undefined;
    const repositoryRoot =
      command === "completion"
        ? (findConfigRoot(startPath) ?? resolve(startPath))
        : (requestedRemoteRoot ?? findConfigRoot(startPath));
    if (repositoryRoot === undefined) {
      throw new Error(
        `No .nanasa/config.yaml found from ${resolve(startPath)}. Run nanasa init first.`,
      );
    }
    const control = await loadControl();
    process.exitCode = await control.runControlCli(args, repositoryRoot);
    return;
  }
  if (command.startsWith("--")) {
    await start(startPath, args);
    return;
  }
  await start(startPath, rest);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
