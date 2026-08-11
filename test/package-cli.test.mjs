import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "bin", "nanasa.js");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRepository() {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-cli-"));
  temporaryDirectories.push(directory);
  mkdirGit(directory);
  return directory;
}

function mkdirGit(directory) {
  const result = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function runCli(directory, args, environment = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function runLinkedCli(directory, args) {
  const linkedCli = join(directory, "nanasa");
  const link = spawnSync("ln", ["-s", cli, linkedCli], { encoding: "utf8" });
  assert.equal(link.status, 0, link.stderr);
  return spawnSync(linkedCli, args, { cwd: directory, encoding: "utf8" });
}

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(prefix, entry.name);
    return entry.isDirectory()
      ? listFiles(join(directory, entry.name), relativePath)
      : [relativePath];
  });
}

test("init creates one repository-local config without runtime state", () => {
  const repository = temporaryRepository();
  const nested = join(repository, "nested", "directory");
  writeFileSync(join(repository, "marker"), "safe\n");
  const mkdir = spawnSync("mkdir", ["-p", nested]);
  assert.equal(mkdir.status, 0);

  const first = runCli(nested, ["init"]);
  assert.equal(first.status, 0, first.stderr);
  const configPath = join(repository, ".nanasa", "config.yaml");
  assert.equal(existsSync(configPath), true);
  assert.equal(existsSync(join(repository, ".nanasa", "state")), false);
  assert.match(
    readFileSync(join(repository, ".nanasa", ".gitignore"), "utf8"),
    /^\/integrations\/$/m,
  );
  const original = readFileSync(configPath, "utf8");
  assert.match(original, /^version: 1$/m);
  assert.match(original, /command: \[copilot\]/);
  assert.match(original, /command: \[pi\]/);
  assert.doesNotMatch(original, /^\s+(adapter|capabilities|recovery):/m);
  assert.doesNotMatch(original, /packagefeedproxy|pkgs\.visualstudio|\/workspaces\/nanasa/);

  writeFileSync(configPath, `${original}# operator-owned\n`);
  const second = runCli(nested, ["init"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already exists/);
  assert.match(readFileSync(configPath, "utf8"), /# operator-owned/);
});

test("start fails clearly before launch when configuration is absent", () => {
  const repository = temporaryRepository();
  const result = runLinkedCli(repository, ["start"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run nanasa init first/);
});

test("start explains the ttyd system prerequisite before daemon launch", () => {
  const repository = temporaryRepository();
  assert.equal(runCli(repository, ["init"]).status, 0);
  const nested = join(repository, "packages", "example");
  const mkdir = spawnSync("mkdir", ["-p", nested]);
  assert.equal(mkdir.status, 0);

  const missingTtyd = join(repository, "missing-ttyd");
  const result = runCli(nested, ["start", "--ttyd-path", missingTtyd]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install ttyd 1\.7\.7 through your system or devcontainer/);
  assert.match(result.stderr, /NANASA_TTYD_PATH/);
  assert.equal(existsSync(join(repository, ".nanasa", "state")), false);
  assert.equal(existsSync(join(nested, ".nanasa")), false);
});

test("help documents authenticated MCP enablement", () => {
  const result = runCli(temporaryRepository(), ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--host <host>\s+Listen host; MCP requires loopback/);
  assert.match(result.stdout, /--mcp\s+Enable authenticated MCP \(default path: \/mcp\)/);
  assert.match(result.stdout, /setup\s+Prepare repository-local integration homes/);
  assert.match(result.stdout, /auth\s+Launch an agent CLI in its isolated home/);
  assert.match(result.stdout, /doctor\s+Validate configuration, commands, and integration paths/);
});

test("setup and doctor prepare private repository-local integrations", () => {
  const repository = temporaryRepository();
  assert.equal(runCli(repository, ["init"]).status, 0);
  writeFileSync(
    join(repository, ".nanasa", "config.yaml"),
    `version: 1
agentTypes:
  fixture:
    name: Fixture
    kind: copilot
    command: [node]
    cwd: .
    agentConfigHome: { scope: agent-type }
`,
  );

  const beforeSetup = runCli(repository, ["doctor"]);
  assert.equal(beforeSetup.status, 1);
  assert.match(beforeSetup.stderr, /run nanasa setup/);

  const setup = runCli(repository, ["setup"]);
  assert.equal(setup.status, 0, setup.stderr);
  const integrations = join(repository, ".nanasa", "integrations");
  assert.equal(statSync(integrations).mode & 0o777, 0o700);
  assert.equal(existsSync(join(integrations, "agent-types", "fixture")), true);

  const doctor = runCli(repository, ["doctor"]);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /doctor passed for 1 agent types/);
});

test("auth launches the configured CLI in an isolated home without changing HOME", () => {
  const repository = temporaryRepository();
  assert.equal(runCli(repository, ["init"]).status, 0);
  const scriptPath = join(repository, "capture-auth.mjs");
  const capturePath = join(repository, "auth-environment.json");
  const externalHome = join(repository, "external-home");
  mkdirSync(externalHome);
  writeFileSync(join(externalHome, "sentinel"), "unchanged\n");
  writeFileSync(
    scriptPath,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.AUTH_CAPTURE, JSON.stringify({
  home: process.env.HOME,
  copilotHome: process.env.COPILOT_HOME,
  copilotCacheHome: process.env.COPILOT_CACHE_HOME
}));
`,
  );
  writeFileSync(
    join(repository, ".nanasa", "config.yaml"),
    `version: 1
agentTypes:
  fixture:
    name: Fixture Copilot
    kind: copilot
    command: [node, ${JSON.stringify(scriptPath)}]
    cwd: .
    agentConfigHome: { scope: custom, path: "auth/{agentType}" }
`,
  );

  const authenticated = runCli(repository, ["auth", "fixture"], {
    AUTH_CAPTURE: capturePath,
    HOME: externalHome,
  });
  assert.equal(authenticated.status, 0, authenticated.stderr);
  const environment = JSON.parse(readFileSync(capturePath, "utf8"));
  assert.equal(environment.home, externalHome);
  assert.equal(
    environment.copilotHome,
    join(repository, ".nanasa", "integrations", "auth", "fixture"),
  );
  assert.equal(environment.copilotCacheHome, join(environment.copilotHome, "cache"));
  assert.equal(readFileSync(join(externalHome, "sentinel"), "utf8"), "unchanged\n");
});

test("member-scoped auth requires a stable membership identifier", () => {
  const repository = temporaryRepository();
  assert.equal(runCli(repository, ["init"]).status, 0);
  writeFileSync(
    join(repository, ".nanasa", "config.yaml"),
    `version: 1
agentTypes:
  fixture:
    name: Fixture
    kind: copilot
    command: [node]
    cwd: .
    agentConfigHome: { scope: member }
`,
  );

  const result = runCli(repository, ["auth", "fixture"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --member <membership-id>/);
});

test("package build contains one terminal-only daemon entry", () => {
  const daemonDirectory = join(root, "dist", "daemon");
  assert.deepEqual(listFiles(daemonDirectory), ["index.js"]);
  const daemonBundle = readFileSync(join(daemonDirectory, "index.js"), "utf8");
  assert.doesNotMatch(
    daemonBundle,
    /copilot-cli-worker|copilot-acp-process|pi-rpc-worker|pi-rpc-process/,
  );
  assert.equal(existsSync(join(root, "dist", "cli", "admin.js")), true);
});

test("packed package installs cleanly and initializes terminal-only config", () => {
  const archiveDirectory = mkdtempSync(join(tmpdir(), "nanasa-pack-"));
  const installDirectory = mkdtempSync(join(tmpdir(), "nanasa-install-"));
  temporaryDirectories.push(archiveDirectory, installDirectory);

  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", archiveDirectory],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const [manifest] = JSON.parse(packed.stdout);
  const publishedFiles = manifest.files.map((file) => file.path);
  assert.ok(publishedFiles.includes("dist/daemon/index.js"));
  assert.ok(publishedFiles.includes("dist/cli/admin.js"));
  assert.ok(publishedFiles.includes("templates/config.yaml"));
  assert.equal(
    publishedFiles.some((path) => /worker|\.map$|^test\//.test(path)),
    false,
  );

  writeFileSync(join(installDirectory, "package.json"), '{"private":true}\n');
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(archiveDirectory, manifest.filename),
    ],
    { cwd: installDirectory, encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);

  const repository = join(installDirectory, "repository");
  mkdirGit(repository);
  const installedCli = join(installDirectory, "node_modules", ".bin", "nanasa");
  assert.equal(
    existsSync(join(installDirectory, "node_modules", "pi-mcp-adapter", "index.ts")),
    true,
  );
  const initialized = spawnSync(installedCli, ["init"], { cwd: repository, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const configPath = join(repository, ".nanasa", "config.yaml");
  const config = readFileSync(configPath, "utf8");
  assert.match(config, /command: \[copilot\]/);
  assert.doesNotMatch(config, /^\s+(adapter|capabilities|recovery):/m);
  assert.equal(existsSync(join(repository, ".nanasa", "state")), false);
});
