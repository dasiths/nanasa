import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

function runCli(directory, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: "utf8" });
}

function runLinkedCli(directory, args) {
  const linkedCli = join(directory, "nanasa");
  const link = spawnSync("ln", ["-s", cli, linkedCli], { encoding: "utf8" });
  assert.equal(link.status, 0, link.stderr);
  return spawnSync(linkedCli, args, { cwd: directory, encoding: "utf8" });
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
  const original = readFileSync(configPath, "utf8");
  assert.match(original, /^version: 1$/m);
  assert.match(original, /adapter: copilot-cli/);
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
