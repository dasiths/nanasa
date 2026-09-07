import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { validateCertificationDispatch } from "../../scripts/certification-dispatch.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = resolve(root, "scripts", "certify-external.mjs");

test("manual compatibility is credential-free and external certification stays explicit", () => {
  const source = readFileSync(script, "utf8");
  const workflow = parseYaml(
    readFileSync(resolve(root, ".github", "workflows", "compatibility.yml"), "utf8"),
  );
  const runtime = readFileSync(
    resolve(root, "scripts", "external-certification-runtime.ts"),
    "utf8",
  );
  const provider = readFileSync(resolve(root, "scripts", "provider-certification.ts"), "utf8");
  const localProvider = readFileSync(resolve(root, "scripts/certify-provider-local.ts"), "utf8");
  const compiler = readFileSync(
    resolve(root, "apps/daemon/src/providers/provider-compiler-supervisor.ts"),
    "utf8",
  );

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.candidate_sha.required, true);
  assert.deepEqual(Object.keys(workflow.jobs), [
    "node",
    "ubuntu",
    "browser",
    "arm64",
    "performance",
    "dependency-audit",
  ]);
  assert.doesNotMatch(JSON.stringify(workflow), /self-hosted|secrets\.|COPILOT|ANTHROPIC|OPENAI/);
  for (const job of Object.values(workflow.jobs)) {
    const checkoutIndex = job.steps.findIndex((item) => item.uses === "actions/checkout@v4");
    assert.ok(checkoutIndex >= 0, "every compatibility job must checkout the requested candidate");
    const checkout = job.steps[checkoutIndex];
    assert.equal(checkout.with.ref, "${{ env.NANASA_CANDIDATE_SHA }}");
    assert.equal(checkout.with["persist-credentials"], false);
    const verify = job.steps[checkoutIndex + 1];
    assert.equal(verify?.name, "Verify exact candidate checkout");
    assert.match(String(verify?.run), /NANASA_CANDIDATE_SHA/);
    assert.match(String(verify?.run), /git rev-parse HEAD/);
  }
  assert.deepEqual(validateCertificationDispatch("provider", "copilot"), {
    mode: "provider",
    providerId: "copilot",
  });
  assert.throws(() => validateCertificationDispatch("provider", ""), /provider_id is required/);
  assert.throws(() => validateCertificationDispatch("webkit", "copilot"), /only in provider/);
  assert.match(source, /provider-certification\.ts/);
  assert.match(source, /environment = \{\}/);
  assert.match(source, /expected === "ignore"/);
  assert.match(source, /NANASA_CERT_LOCAL/);
  assert.match(source, /GITHUB_ACTIONS/);
  assert.match(source, /NPM_CONFIG_REGISTRY/);
  assert.match(source, /COREPACK_NPM_REGISTRY/);
  assert.doesNotMatch(source, /systemd-run|\/usr\/bin\/true/);
  assert.match(provider, /status\.interactiveReady/);
  assert.doesNotMatch(provider, /interactiveReady && status\.effectiveModel/);
  assert.match(provider, /new Set\(adapter\.reporter\.events\)/);
  assert.match(provider, /NANASA_CERT_AUTH_MODE/);
  assert.match(provider, /persistentIntegrationsDirectory/);
  assert.match(provider, /credentials: \$\{usesProviderHome/);
  assert.match(localProvider, /providerState\.scope === "membership"/);
  assert.match(localProvider, /NANASA_CERT_AGENT_ID/);
  assert.match(localProvider, /NANASA_CERT_PROVIDER_COMMAND_JSON/);
  assert.match(localProvider, /NANASA_CERT_MODEL_POLICY_JSON/);
  assert.match(compiler, /NANASA_PROVIDER_COMPILER_MODE/);
  assert.match(compiler, /\?\? "manual"/);
  assert.match(provider, /adapter\.control\.waitReplyChannels\.includes/);
  assert.match(provider, /adapter\.reporter\.coverage\.actionCorrelation/);
  assert.match(provider, /OpenWaitReplySchema\.parse/);
  assert.doesNotMatch(provider, /modelObservation|desired-launch/);
  assert.match(provider, /listOpenWaits/);
  assert.match(provider, /recoveryOutcome === "resumed"/);
  assert.match(runtime, /service\.install\(\)/);
  assert.match(runtime, /service\.restart\(\)/);
  assert.match(runtime, /service\.remove\(\)/);
  assert.match(runtime, /RemoteSshSession/);
  assert.match(runtime, /session\.connect/);
  assert.match(runtime, /Remote continuity identity changed across reconnect/);
});

test("workflows preserve registry authority and release through exact tagged artifacts", () => {
  const registryScript = resolve(root, "scripts", "ci-registry-env.sh");
  const setupScript = resolve(root, "scripts", "setup-pnpm.sh");
  const registry = readFileSync(registryScript, "utf8");
  const setup = readFileSync(setupScript, "utf8");
  const workflowSources = ["ci.yml", "compatibility.yml", "release.yml"].map((name) =>
    readFileSync(resolve(root, ".github", "workflows", name), "utf8"),
  );
  const workflows = workflowSources.map((value) => parseYaml(value));
  const ci = workflows[0];
  const compatibility = workflows[1];
  const release = workflows[2];
  assert.match(registry, /elif \[\[ -n "\$\{NPM_CONFIG_REGISTRY:-\}"/);
  assert.match(registry, /NANASA_ALLOW_PUBLIC_REGISTRY_FALLBACK/);
  assert.match(registry, /GITHUB_ENV/);
  assert.match(setup, /source "\$\{SCRIPT_DIRECTORY\}\/ci-registry-env\.sh"/);
  assert.match(setup, /pnpm@\$\{PNPM_VERSION\}/);
  assert.match(setup, /--ignore-scripts/);
  assert.doesNotMatch(workflowSources.join("\n"), /source \.devcontainer\/\.env\.example/);
  assert.doesNotMatch(workflowSources.join("\n"), /corepack prepare/);
  assert.deepEqual(Object.keys(compatibility.on), ["workflow_dispatch"]);
  assert.equal(ci.jobs.required.needs.length, 5);
  assert.match(workflowSources[0], /pnpm acceptance:ci/);
  assert.doesNotMatch(workflowSources[0], /secrets\.|COPILOT|ANTHROPIC|OPENAI/);
  assert.equal(release.jobs.ci.uses, "./.github/workflows/ci.yml");
  assert.equal(release.jobs["github-release"].environment, "release");
  assert.equal(release.jobs["npm-publish"].environment, "release");
  assert.match(release.jobs["npm-publish"].if, /NANASA_PUBLISH_NPM/);
  assert.equal(release.jobs["npm-publish"].permissions["id-token"], "write");
  const releaseSource = workflowSources[2];
  assert.match(releaseSource, /git merge-base --is-ancestor/);
  assert.match(releaseSource, /GITHUB_REF_NAME.*package_version/);
  assert.match(releaseSource, /actions\/attest-build-provenance@v2/);
  assert.match(releaseSource, /gh release create/);
  assert.match(releaseSource, /npm publish/);
  assert.match(releaseSource, /--provenance/);
  for (const workflow of workflows) {
    for (const job of Object.values(workflow.jobs)) {
      if (
        !Array.isArray(job.steps) ||
        !job.steps.some((step) => String(step.run ?? "").includes("bash scripts/setup-pnpm.sh"))
      ) {
        continue;
      }
      const setupIndex = job.steps.findIndex((step) => step.uses === "actions/setup-node@v4");
      const pnpmIndex = job.steps.findIndex((step) =>
        String(step.run ?? "").includes("bash scripts/setup-pnpm.sh"),
      );
      const cacheIndex = job.steps.findIndex((step) => step.uses === "actions/cache@v4");
      assert.ok(setupIndex >= 0 && pnpmIndex > setupIndex && cacheIndex > pnpmIndex);
      assert.equal(job.steps[setupIndex].with.cache, undefined);
      assert.match(String(job.steps[cacheIndex].with.key), /hashFiles\('pnpm-lock\.yaml'\)/);
    }
  }

  const preserved = spawnSync(
    "bash",
    [
      "-c",
      `source ${JSON.stringify(registryScript)} && [[ "$NPM_CONFIG_REGISTRY" == "private-one" ]] && [[ "$COREPACK_NPM_REGISTRY" == "private-two" ]]`,
    ],
    {
      cwd: tmpdir(),
      env: {
        PATH: process.env.PATH,
        NPM_CONFIG_REGISTRY: "private-one",
        COREPACK_NPM_REGISTRY: "private-two",
        NANASA_ALLOW_PUBLIC_REGISTRY_FALLBACK: "true",
      },
      encoding: "utf8",
    },
  );
  assert.equal(preserved.status, 0, preserved.stderr);
});
