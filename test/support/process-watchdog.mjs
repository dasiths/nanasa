import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const manifestPath = process.argv[2];
if (manifestPath === undefined) process.exit(2);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startTime(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21];
  } catch {
    return undefined;
  }
}

function exactProcess(record) {
  if (!alive(record.pid) || startTime(record.pid) !== record.startTime) return false;
  try {
    const command = readFileSync(`/proc/${record.pid}/cmdline`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return (
      command[0] === record.executable &&
      JSON.stringify(command.slice(1)) === JSON.stringify(record.argv)
    );
  } catch {
    return false;
  }
}

function cleanup() {
  if (!existsSync(manifestPath)) return process.exit(0);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (alive(manifest.ownerPid) && startTime(manifest.ownerPid) === manifest.ownerStartTime) return;
  for (const record of manifest.processes ?? []) {
    if (exactProcess(record)) process.kill(record.pid, "SIGTERM");
  }
  for (const server of manifest.resources?.tmuxServers ?? []) {
    spawnSync("tmux", ["-L", server, "kill-server"], { stdio: "ignore" });
  }
  for (const directory of manifest.resources?.temporaryDirectories ?? []) {
    if (typeof directory === "string" && directory.includes(`nanasa-harness-`)) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  process.exit(0);
}

setInterval(cleanup, 250);
cleanup();
