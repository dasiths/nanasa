import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "dist");
const daemonOutputDirectory = join(outputDirectory, "daemon");
const portalDirectory = join(root, "apps", "portal");
const portalRequire = createRequire(join(portalDirectory, "package.json"));
const vitePath = join(dirname(portalRequire.resolve("vite/package.json")), "bin", "vite.js");

function runNode(modulePath, args, cwd = root) {
  const result = spawnSync(process.execPath, [modulePath, ...args], {
    cwd,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${modulePath} exited with status ${result.status ?? "unknown"}`);
  }
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(daemonOutputDirectory, { recursive: true });

await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: {
    index: "apps/daemon/src/index.ts",
  },
  external: ["@fastify/*", "@modelcontextprotocol/*", "fastify", "ws", "yaml", "zod"],
  format: "esm",
  outdir: daemonOutputDirectory,
  platform: "node",
  sourcemap: false,
  target: "node22",
});

runNode(
  join(root, "node_modules", "typescript", "bin", "tsc"),
  ["-p", "tsconfig.json", "--noEmit"],
  portalDirectory,
);
runNode(vitePath, ["build"], portalDirectory);
cpSync(join(portalDirectory, "dist"), join(outputDirectory, "portal"), { recursive: true });
