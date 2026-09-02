import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { parse as parseYaml } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "dist");
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function directoryDigest(directory) {
  const hash = createHash("sha256");
  const visit = (current, prefix = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) visit(join(current, entry.name), relative);
      else {
        hash.update(relative.replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(readFileSync(join(current, entry.name)));
      }
    }
  };
  visit(directory);
  return hash.digest("hex");
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || !/^[a-f0-9]{40}\n?$/.test(result.stdout)) {
    throw new Error("A full Git commit is required to build a release artifact");
  }
  return result.stdout.trim();
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: {
    "daemon/index": "apps/daemon/src/index.ts",
    "cli/admin": "apps/daemon/src/cli-admin.ts",
    "cli/control": "apps/daemon/src/cli/control.ts",
  },
  external: ["@fastify/*", "@modelcontextprotocol/*", "fastify", "node-pty", "ws", "yaml", "zod"],
  format: "esm",
  outdir: outputDirectory,
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

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const schemaSource = readFileSync(
  join(root, "apps", "daemon", "src", "persistence", "schema.ts"),
  "utf8",
);
const schemaVersion = Number(schemaSource.match(/DATABASE_SCHEMA_VERSION = (\d+)/)?.[1]);
if (!Number.isInteger(schemaVersion)) throw new Error("Unable to resolve database schema version");
const commit = gitCommit();
const builtAt = new Date(
  process.env.SOURCE_DATE_EPOCH === undefined
    ? Date.now()
    : Number(process.env.SOURCE_DATE_EPOCH) * 1_000,
).toISOString();
const metadata = {
  packageName: "nanasa",
  packageVersion: packageJson.version,
  channel: packageJson.version.includes("-") ? "next" : "latest",
  commit,
  builtAt,
  databaseSchema: { minimum: schemaVersion, maximum: schemaVersion },
  configVersion: 2,
  apiVersion: 1,
  eventProtocolVersion: 1,
  terminalProtocolVersion: 1,
  node: packageJson.engines.node,
  hosts: ["linux-x64", "linux-arm64"],
  tmux: ">=3.2",
  terminalHelper: { name: "node-pty", version: packageJson.dependencies["node-pty"] },
  xterm: { name: "@xterm/xterm", version: "6.0.0" },
  browsers: ["chromium", "firefox", "webkit"],
  portalAssetDigest: directoryDigest(join(outputDirectory, "portal")),
};
mkdirSync(join(outputDirectory, "meta"), { recursive: true });
writeFileSync(
  join(outputDirectory, "meta", "build.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);

const lockfile = parseYaml(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
const lockPackages = Object.keys(lockfile.packages ?? {})
  .map((key) => key.replace(/\(.+$/, ""))
  .map((key) => {
    const separator = key.lastIndexOf("@");
    return { name: key.slice(0, separator), version: key.slice(separator + 1) };
  })
  .filter((item) => item.name.length > 0 && item.version.length > 0);
const dependencies = [
  ...new Map(lockPackages.map((item) => [`${item.name}@${item.version}`, item])).values(),
].sort((left, right) =>
  left.name === right.name
    ? left.version.localeCompare(right.version)
    : left.name.localeCompare(right.name),
);
const dependencyPackages = dependencies.map(({ name, version }) => {
  const id = `SPDXRef-Dependency-${sha256(`${name}@${version}`).slice(0, 20)}`;
  return {
    name,
    SPDXID: id,
    versionInfo: version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    primaryPackagePurpose: "LIBRARY",
  };
});
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `nanasa-${packageJson.version}`,
  documentNamespace: `https://github.com/dasiths/nanasa/sbom/${commit}`,
  creationInfo: { created: builtAt, creators: ["Tool: nanasa-build-package"] },
  documentDescribes: ["SPDXRef-Package-nanasa"],
  packages: [
    {
      name: "nanasa",
      SPDXID: "SPDXRef-Package-nanasa",
      versionInfo: packageJson.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "MIT",
      licenseDeclared: "MIT",
      primaryPackagePurpose: "APPLICATION",
      checksums: [{ algorithm: "SHA256", checksumValue: sha256(JSON.stringify(metadata)) }],
    },
    ...dependencyPackages,
  ],
  relationships: dependencyPackages.map((dependency) => ({
    spdxElementId: "SPDXRef-Package-nanasa",
    relationshipType: "DEPENDS_ON",
    relatedSpdxElement: dependency.SPDXID,
  })),
};
writeFileSync(
  join(outputDirectory, "meta", "sbom.spdx.json"),
  `${JSON.stringify(sbom, null, 2)}\n`,
);
cpSync(join(root, "docs", "next"), join(outputDirectory, "help"), { recursive: true });
