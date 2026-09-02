import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const script = resolve(root, "scripts", "certify-external.mjs");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

test("external certification fails closed without declared prerequisites", () => {
  const result = spawnSync(process.execPath, [script, "provider", "copilot"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NANASA_CERT_CANDIDATE_SHA/);
});

test("provider certification rejects unknown profiles and arbitrary executable arguments", () => {
  const unknown = spawnSync(process.execPath, [script, "provider", "unknown-provider"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NANASA_CERT_CANDIDATE_SHA: head },
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown built-in provider certification profile/);

  const arbitrary = spawnSync(
    process.execPath,
    [script, "provider", "copilot", process.execPath, "-e", "process.exit(0)"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        NANASA_CERT_CANDIDATE_SHA: head,
        COPILOT_GITHUB_TOKEN: "not-used",
      },
    },
  );
  assert.notEqual(arbitrary.status, 0);
  assert.match(arbitrary.stderr, /only a mode and one closed provider profile/);
});

test("candidate SHA ignore is local-only and rejected in CI", () => {
  const missingLocalMarker = spawnSync(process.execPath, [script, "provider", "unknown-provider"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NANASA_CERT_CANDIDATE_SHA: "ignore" },
  });
  assert.notEqual(missingLocalMarker.status, 0);
  assert.match(missingLocalMarker.stderr, /allowed only with NANASA_CERT_LOCAL=true outside CI/);

  const ci = spawnSync(process.execPath, [script, "provider", "unknown-provider"], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      NANASA_CERT_CANDIDATE_SHA: "ignore",
      NANASA_CERT_LOCAL: "true",
      CI: "true",
    },
  });
  assert.notEqual(ci.status, 0);
  assert.match(ci.stderr, /allowed only with NANASA_CERT_LOCAL=true outside CI/);

  const local = spawnSync(process.execPath, [script, "provider", "unknown-provider"], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      NANASA_CERT_CANDIDATE_SHA: "ignore",
      NANASA_CERT_LOCAL: "true",
    },
  });
  assert.notEqual(local.status, 0);
  assert.match(local.stderr, /Unknown built-in provider certification profile/);
  assert.doesNotMatch(local.stderr, /Candidate SHA/);
});

test("local provider-home certification does not require an environment token", () => {
  const result = spawnSync(process.execPath, [script, "provider", "copilot"], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      NANASA_CERT_CANDIDATE_SHA: "ignore",
      NANASA_CERT_LOCAL: "true",
      NANASA_CERT_AUTH_MODE: "provider-home",
      NANASA_CERT_INTEGRATION_ID: "copilot",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NANASA_CERT_INTEGRATIONS_DIRECTORY/);
  assert.doesNotMatch(result.stderr, /COPILOT_GITHUB_TOKEN/);
});

test("provider certification fails without the allowlisted credential and redacts ambient secrets", () => {
  const ambientSecret = "certification-secret-that-must-not-appear";
  const result = spawnSync(process.execPath, [script, "provider", "copilot"], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      NANASA_CERT_CANDIDATE_SHA: head,
      AMBIENT_PROVIDER_SECRET: ambientSecret,
    },
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, new RegExp(ambientSecret));
  assert.doesNotMatch(result.stderr, new RegExp(ambientSecret));
});
