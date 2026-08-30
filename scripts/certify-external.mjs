import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { resolve } from "node:path";

const mode = process.argv[2];
const supported = new Set(["provider", "webkit", "arm64", "node24", "ubuntu", "systemd", "ssh"]);
if (!supported.has(mode))
  throw new Error(`Unknown external certification mode: ${mode ?? "missing"}`);
if (
  (mode === "provider" && process.argv.length !== 4) ||
  (mode !== "provider" && process.argv.length !== 3)
) {
  throw new Error("Certification accepts only a mode and one closed provider profile");
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Certification prerequisite is missing: ${name}`);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.silent === true ? "ignore" : "inherit",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${options.label ?? "Certification command"} failed with exit ${result.status ?? "spawn-error"}`,
    );
  }
}

function exactCandidate() {
  const expected = required("NANASA_CERT_CANDIDATE_SHA");
  if (!/^[a-f0-9]{40}$/.test(expected)) throw new Error("Candidate SHA must be exact and full");
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim() !== expected) {
    throw new Error("Certification checkout does not match NANASA_CERT_CANDIDATE_SHA");
  }
}

function provider() {
  const providerId = process.argv[3];
  const profiles = {
    copilot: ["COPILOT_GITHUB_TOKEN"],
    "claude-code": ["ANTHROPIC_API_KEY"],
    opencode: ["OPENAI_API_KEY"],
    pi: ["ANTHROPIC_API_KEY"],
  };
  const credentialNames = profiles[providerId];
  if (credentialNames === undefined)
    throw new Error("Unknown built-in provider certification profile");
  const environment = {};
  for (const name of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.NANASA_CERT_CANDIDATE_SHA = required("NANASA_CERT_CANDIDATE_SHA");
  for (const name of credentialNames) environment[name] = required(name);
  run(
    process.execPath,
    ["--import", "tsx", resolve("scripts/provider-certification.ts"), providerId],
    {
      env: environment,
      silent: true,
      label: "Built-in provider semantic certification",
    },
  );
  console.log(
    `Built-in ${providerId} semantic certification passed; provider output and credentials were redacted`,
  );
}

function fixedRuntime(runtimeMode) {
  run(
    process.execPath,
    ["--import", "tsx", resolve("scripts/external-certification-runtime.ts"), runtimeMode],
    {
      silent: true,
      label: `${runtimeMode} certification runtime`,
    },
  );
}

function webkit() {
  if (process.env.NANASA_BROWSER !== "webkit") throw new Error("NANASA_BROWSER must equal webkit");
  run("pnpm", ["acceptance"], { label: "WebKit acceptance" });
}

function arm64() {
  if (arch() !== "arm64" || platform() !== "linux")
    throw new Error("Native Linux arm64 is required");
  run("pnpm", ["package:test"], { label: "Native arm64 package test" });
  run("pnpm", ["check:architecture"], { label: "Native arm64 architecture gate" });
}

function node24() {
  if (process.versions.node.split(".")[0] !== "24") throw new Error("Node.js 24 is required");
  run("pnpm", ["package:test"], { label: "Node.js 24 package test" });
}

function ubuntu() {
  if (platform() !== "linux" || !readFileSync("/etc/os-release", "utf8").includes("ID=ubuntu")) {
    throw new Error("Ubuntu is required");
  }
  run("pnpm", ["smoke"], { label: "Ubuntu runtime smoke test" });
  console.log(`Ubuntu certification passed on kernel ${release()}`);
}

function systemd() {
  if (platform() !== "linux")
    throw new Error("Linux is required for persistent systemd certification");
  required("XDG_RUNTIME_DIR");
  required("DBUS_SESSION_BUS_ADDRESS");
  run("systemctl", ["--user", "show-environment"], {
    silent: true,
    label: "Persistent systemd user manager probe",
  });
  fixedRuntime("systemd");
}

function ssh() {
  required("NANASA_CERT_SSH_TARGET");
  required("NANASA_CERT_SSH_REPOSITORY");
  fixedRuntime("ssh");
  console.log("Live SSH forwarding, identity, continuity, and reconnect certification passed");
}

exactCandidate();
({ provider, webkit, arm64, node24, ubuntu, systemd, ssh })[mode]();
console.log(
  JSON.stringify({
    mode,
    candidate: process.env.NANASA_CERT_CANDIDATE_SHA,
    node: process.version,
    platform: platform(),
    arch: arch(),
  }),
);
