#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configRelativePath = join(".nanasa", "config.yaml");

function usage() {
  return `Usage: nanasa [start] [options]
       nanasa init

Commands:
  start              Start the daemon and portal (default)
  init               Create .nanasa/config.yaml when absent

Options:
  --host <host>       Listen host (default: NANASA_HOST or 127.0.0.1)
  --port <port>       Listen port (default: NANASA_PORT or 3210)
  --ttyd-path <path>  ttyd executable (default: NANASA_TTYD_PATH or ttyd)
  -h, --help          Show this help
  -v, --version       Show the installed version`;
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
  return configPath;
}

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
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
    } else if (argument === "--ttyd-path") {
      environment.NANASA_TTYD_PATH = optionValue(args, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return environment;
}

function packageVersion() {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  return packageJson.version;
}

function verifyTtyd(ttydPath) {
  const result = spawnSync(ttydPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Could not run ${ttydPath} --version. Install ttyd 1.7.7 through your system or devcontainer, or set NANASA_TTYD_PATH.`,
    );
  }
}

async function start(startPath, args) {
  const repositoryRoot = findConfigRoot(startPath);
  if (repositoryRoot === undefined) {
    throw new Error(
      `No .nanasa/config.yaml found from ${resolve(startPath)}. Run nanasa init first.`,
    );
  }
  const options = parseStartOptions(args);
  const ttydPath = options.NANASA_TTYD_PATH ?? process.env.NANASA_TTYD_PATH ?? "ttyd";
  verifyTtyd(ttydPath);

  const child = spawn(process.execPath, [join(packageRoot, "dist", "daemon", "index.js")], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...options,
      NODE_ENV: "production",
      NANASA_REPO_ROOT: repositoryRoot,
      NANASA_SERVE_PORTAL: "true",
      NANASA_PORTAL_PATH: join(packageRoot, "dist", "portal"),
      NANASA_TTYD_PATH: ttydPath,
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
    if (rest.length > 0) throw new Error("nanasa init does not accept options");
    initialize(startPath);
    return;
  }
  if (command.startsWith("--")) {
    await start(startPath, args);
    return;
  }
  if (command !== "start") throw new Error(`Unknown command: ${command}`);
  await start(startPath, rest);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
