import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const baselinePath = join(root, "test", "release", "coverage-baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const testFiles = readdirSync(join(root, "test", "release"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", "release", name));
const result = spawnSync(
  process.execPath,
  ["--experimental-test-coverage", "--test", ...testFiles],
  { cwd: root, encoding: "utf8" },
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) throw new Error(`Coverage test run failed with status ${result.status}`);
const total = result.stdout.match(/all files\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)/i);
if (total === null) throw new Error("Unable to parse Node coverage summary");
const measured = {
  statements: Number(total[1]),
  branches: Number(total[2]),
  functions: Number(total[3]),
  lines: Number(total[1]),
};
const failures = Object.entries(baseline.thresholds)
  .filter(([key, threshold]) => measured[key] < threshold)
  .map(([key, threshold]) => `${key} ${measured[key]}% < ${threshold}%`);
if (failures.length > 0) throw new Error(`Coverage ratchet failed: ${failures.join(", ")}`);
console.log(
  JSON.stringify({ baselineVersion: baseline.version, measured, thresholds: baseline.thresholds }),
);
