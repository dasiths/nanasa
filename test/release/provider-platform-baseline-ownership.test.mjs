import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const ownershipPath = resolve(
  root,
  "test/fixtures/provider-platform/provider-platform-baseline-ownership.json",
);
const planPath = resolve(
  root,
  ".copilot-tracking/plans/2026-09-01/provider-platform-target-architecture-plan.instructions.md",
);

function readOwnership() {
  return JSON.parse(readFileSync(ownershipPath, "utf8"));
}

test("provider platform baseline ownership is complete and executable", () => {
  const ownership = readOwnership();
  assert.equal(ownership.formatVersion, 1);
  assert.deepEqual(ownership.fleetScales, [1, 15, 100]);
  assert.deepEqual(
    ownership.baselines.map((baseline) => baseline.id),
    [
      "built-in-launch",
      "reporter-events",
      "provider-certification",
      "fleet-1-15-100",
      "terminal",
      "osc52",
      "portal-status",
      "attention",
      "notifications",
      "responsive",
      "accessibility",
    ],
  );

  const baselineById = new Map(ownership.baselines.map((baseline) => [baseline.id, baseline]));
  const ownerPaths = new Set();
  for (const baseline of ownership.baselines) {
    assert.ok(baseline.owners.length > 0, `${baseline.id} must have an executable owner`);
    for (const owner of baseline.owners) ownerPaths.add(owner);
  }
  for (const condition of ownership.stopConditions) {
    for (const reference of condition.baselineRefs ?? []) {
      const baseline = baselineById.get(reference);
      assert.ok(baseline, `${condition.id} references unknown baseline ${reference}`);
      for (const owner of baseline.owners) ownerPaths.add(owner);
    }
    for (const owner of condition.owners ?? []) ownerPaths.add(owner);
    assert.ok(
      (condition.baselineRefs?.length ?? 0) + (condition.owners?.length ?? 0) > 0,
      `${condition.id} must have an executable owner`,
    );
  }

  for (const owner of ownerPaths) {
    const absolute = resolve(root, owner);
    assert.ok(existsSync(absolute), `Baseline owner does not exist: ${owner}`);
    assert.match(
      readFileSync(absolute, "utf8"),
      /\b(?:describe|it|test)\s*\(/,
      `Baseline owner is not an executable test: ${owner}`,
    );
  }
});

test("every immutable stop condition is synchronized with the implementation plan", () => {
  const ownership = readOwnership();
  const plan = readFileSync(planPath, "utf8");
  assert.deepEqual(
    ownership.stopConditions.map((condition) => condition.id),
    ["SC-01", "SC-02", "SC-03", "SC-04", "SC-05", "SC-06", "SC-07", "SC-08", "SC-09", "SC-10"],
  );
  for (const condition of ownership.stopConditions) {
    assert.match(plan, new RegExp(condition.condition.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
