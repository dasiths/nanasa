import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const configDirectory = process.env.CLAUDE_CONFIG_DIR;

if (configDirectory !== undefined && configDirectory !== "") {
  const statePath = join(configDirectory, ".claude.json");
  let state = {};

  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error(`${statePath} must contain a JSON object`);
  }

  if (state.hasCompletedOnboarding !== true) {
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ ...state, hasCompletedOnboarding: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporaryPath, statePath);
    chmodSync(statePath, 0o600);
  }
}
