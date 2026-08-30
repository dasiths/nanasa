import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const setupScript = resolve(root, "scripts", "setup-pnpm.sh");

function executable(path, source) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`);
  chmodSync(path, 0o700);
}

function runSetup({ corepackInstallDirectorySupported = true, corepackPresent }) {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-pnpm-bootstrap-"));
  const commandLog = join(directory, "commands.log");
  const githubEnv = join(directory, "github-env");
  const githubPath = join(directory, "github-path");
  const corepack = join(directory, corepackPresent ? "corepack" : "missing-corepack");
  const npm = join(directory, "npm");
  const installRoot = join(directory, "install-root");
  writeFileSync(commandLog, "");
  writeFileSync(githubEnv, "");
  writeFileSync(githubPath, "");
  if (corepackPresent) {
    executable(
      corepack,
      `[[ "\${NPM_CONFIG_REGISTRY}" == "private-one" ]]\n[[ "\${COREPACK_NPM_REGISTRY}" == "private-two" ]]\n[[ "\${COREPACK_ENABLE_DOWNLOAD_PROMPT}" == "0" ]]\nprintf 'corepack:%s\\n' "$*" >> "\${NANASA_TEST_COMMAND_LOG}"\nprintf 'private-one private-two\\n'\nif [[ "$1" == "enable" ]]; then\n  [[ "$2" == "--install-directory" ]]\n  install_directory="$3"\n  [[ "$4" == "pnpm" ]]\n  ! command -v pnpm >/dev/null 2>&1\n  if [[ "\${NANASA_TEST_COREPACK_INSTALL_DIRECTORY_SUPPORTED}" != "true" ]]; then\n    exit 64\n  fi\n  mkdir -p -- "\${install_directory}"\n  cat > "\${install_directory}/pnpm" <<'SHIM'\n#!/usr/bin/env bash\nset -euo pipefail\n[[ "\${PATH%%:*}" == "$(dirname "$0")" ]]\nprintf 'pnpm:%s:%s\\n' "$0" "$*" >> "\${NANASA_TEST_COMMAND_LOG}"\nprintf '10.34.5\\n'\nSHIM\n  chmod 700 "\${install_directory}/pnpm"\nfi`,
    );
  }
  executable(
    npm,
    `[[ "\${NPM_CONFIG_REGISTRY}" == "private-one" ]]\n[[ "\${COREPACK_NPM_REGISTRY}" == "private-two" ]]\n! command -v pnpm >/dev/null 2>&1\nprintf 'npm:%s\\n' "$*" >> "\${NANASA_TEST_COMMAND_LOG}"\nprintf 'private-one private-two\\n'\n[[ "$1" == "install" ]]\n[[ "$2" == "--global" ]]\n[[ "$3" == "--prefix" ]]\ninstall_prefix="$4"\nmkdir -p -- "\${install_prefix}/bin"\ncat > "\${install_prefix}/bin/pnpm" <<'SHIM'\n#!/usr/bin/env bash\nset -euo pipefail\n[[ "\${PATH%%:*}" == "$(dirname "$0")" ]]\nprintf 'pnpm:%s:%s\\n' "$0" "$*" >> "\${NANASA_TEST_COMMAND_LOG}"\nprintf '10.34.5\\n'\nSHIM\nchmod 700 "\${install_prefix}/bin/pnpm"`,
  );

  const result = spawnSync("bash", [setupScript], {
    cwd: directory,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: directory,
      TMPDIR: directory,
      GITHUB_ENV: githubEnv,
      GITHUB_PATH: githubPath,
      NPM_CONFIG_REGISTRY: "private-one",
      COREPACK_NPM_REGISTRY: "private-two",
      NANASA_ALLOW_PUBLIC_REGISTRY_FALLBACK: "true",
      NANASA_PNPM_SETUP_TEST_MODE: "true",
      NANASA_PNPM_TEST_COREPACK_COMMAND: corepack,
      NANASA_PNPM_TEST_NPM_COMMAND: npm,
      NANASA_PNPM_TEST_INSTALL_ROOT: installRoot,
      NANASA_TEST_COREPACK_INSTALL_DIRECTORY_SUPPORTED: String(corepackInstallDirectorySupported),
      NANASA_TEST_COMMAND_LOG: commandLog,
    },
  });

  return {
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    commandLog: readFileSync(commandLog, "utf8"),
    githubEnv: readFileSync(githubEnv, "utf8"),
    githubPath: readFileSync(githubPath, "utf8"),
    installRoot,
    result,
  };
}

test("pinned pnpm bootstrap uses Corepack without invoking npm", () => {
  const run = runSetup({ corepackPresent: true });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const pnpmDirectory = join(run.installRoot, "corepack-bin");
    const pnpm = join(pnpmDirectory, "pnpm");
    assert.equal(
      run.commandLog,
      `corepack:enable --install-directory ${pnpmDirectory} pnpm\n` +
        "corepack:prepare pnpm@10.34.5 --activate\n" +
        `pnpm:${pnpm}:--version\n`,
    );
    assert.equal(
      run.githubEnv,
      "NPM_CONFIG_REGISTRY=private-one\nCOREPACK_NPM_REGISTRY=private-two\n",
    );
    assert.equal(run.githubPath, `${pnpmDirectory}\n`);
    assert.doesNotMatch(`${run.result.stdout}${run.result.stderr}`, /private-one|private-two/);
  } finally {
    run.cleanup();
  }
});

test("pinned pnpm bootstrap safely falls back when Corepack cannot install a shim", () => {
  const run = runSetup({ corepackInstallDirectorySupported: false, corepackPresent: true });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const corepackDirectory = join(run.installRoot, "corepack-bin");
    const pnpmDirectory = join(run.installRoot, "npm", "bin");
    const pnpm = join(pnpmDirectory, "pnpm");
    assert.equal(
      run.commandLog,
      `corepack:enable --install-directory ${corepackDirectory} pnpm\n` +
        `npm:install --global --prefix ${join(run.installRoot, "npm")} ` +
        "--ignore-scripts --no-audit --no-fund --no-update-notifier --progress=false " +
        "--loglevel=error --package-lock=false pnpm@10.34.5\n" +
        `pnpm:${pnpm}:--version\n`,
    );
    assert.equal(run.githubPath, `${pnpmDirectory}\n`);
    assert.doesNotMatch(`${run.result.stdout}${run.result.stderr}`, /private-one|private-two/);
  } finally {
    run.cleanup();
  }
});

test("pinned pnpm bootstrap uses a controlled npm install when Corepack is absent", () => {
  const run = runSetup({ corepackPresent: false });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const pnpmDirectory = join(run.installRoot, "npm", "bin");
    const pnpm = join(pnpmDirectory, "pnpm");
    assert.match(run.commandLog, /^npm:install --global --prefix /);
    assert.match(run.commandLog, /--ignore-scripts/);
    assert.match(run.commandLog, /--no-audit --no-fund --no-update-notifier/);
    assert.match(run.commandLog, /--package-lock=false pnpm@10\.34\.5\n/);
    assert.doesNotMatch(run.commandLog, /--registry/);
    assert.match(run.commandLog, new RegExp(`pnpm:${pnpm}:--version\\n$`));
    assert.equal(run.githubPath, `${pnpmDirectory}\n`);
    assert.doesNotMatch(`${run.result.stdout}${run.result.stderr}`, /private-one|private-two/);
  } finally {
    run.cleanup();
  }
});
