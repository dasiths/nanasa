import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const gate = process.argv[2];
const allowed = new Set([
  "architecture",
  "security",
  "performance",
  "provenance",
  "sbom",
  "release",
]);
if (!allowed.has(gate)) throw new Error(`Unknown release gate: ${gate ?? "missing"}`);

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
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
      const path = join(current, entry.name);
      const name = join(prefix, entry.name);
      if (entry.isDirectory()) visit(path, name);
      else {
        hash.update(name.replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(readFileSync(path));
      }
    }
  };
  visit(directory);
  return hash.digest("hex");
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((path) => join(root, path));
}

function architecture() {
  const productionRoots = [
    "apps/daemon/src",
    "apps/portal/src",
    "packages",
    "bin",
    "scripts",
    "templates",
  ];
  const production = productionRoots
    .flatMap((path) => files(join(root, path)))
    .filter((path) => {
      const extension = extname(path);
      return (
        path !== join(root, "scripts", "release-gate.mjs") &&
        [".ts", ".tsx", ".js", ".mjs", ".json", ".service"].includes(extension)
      );
    });
  const retired = /(?:\bttyd\b|terminal-proxy|@fastify\/http-proxy)/i;
  const violations = production
    .filter((path) => retired.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path));
  if (violations.length > 0)
    throw new Error(`Retired terminal architecture found in ${violations.join(", ")}`);
  const routeSource = readFileSync(
    join(root, "apps", "daemon", "src", "http", "route-registry.ts"),
    "utf8",
  );
  if (/path:\s*["']\/api\/(?!v1(?:\/|["']))/.test(routeSource)) {
    throw new Error("Unversioned control route found");
  }
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packageJson.os?.join(",") !== "linux" || packageJson.cpu?.join(",") !== "x64,arm64") {
    throw new Error("Package support boundaries must remain Linux x64 and arm64");
  }
  for (const path of [
    "apps/daemon/package.json",
    "apps/portal/package.json",
    "packages/contracts/package.json",
    "packages/control-client/package.json",
  ]) {
    const workspace = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (workspace.version !== packageJson.version) {
      throw new Error(`${path} version does not match the public package`);
    }
  }
  console.log(`Architecture gate passed across ${production.length} production files`);
}

function security() {
  const candidates = trackedFiles().filter((path) => {
    const name = relative(root, path);
    return (
      existsSync(path) &&
      name !== "scripts/release-gate.mjs" &&
      !name.startsWith(".copilot-tracking/") &&
      name !== "pnpm-lock.yaml" &&
      !name.endsWith(".md") &&
      (name === "package.json" ||
        name.startsWith("apps/") ||
        name.startsWith("packages/") ||
        name.startsWith("bin/") ||
        name.startsWith("scripts/") ||
        name.startsWith("templates/") ||
        name.startsWith(".github/workflows/")) &&
      statSync(path).size < 2_000_000
    );
  });
  const privateRegistry =
    /packagefeedproxy|pkgs\.visualstudio|NPM_CONFIG_REGISTRY\s*=|COREPACK_NPM_REGISTRY\s*=/i;
  const credential =
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|https?:\/\/[^\s/:]+:[^\s/@]+@/;
  const violations = candidates.filter((path) => {
    const value = readFileSync(path, "utf8");
    return privateRegistry.test(value) || credential.test(value);
  });
  if (violations.length > 0) {
    throw new Error(
      `Sensitive release content found in ${violations.map((path) => relative(root, path)).join(", ")}`,
    );
  }
  const packaged = files(join(root, "dist"));
  const forbidden = packaged.filter((path) =>
    /(?:\.map$|\/(?:test|coverage|provider-state|terminal-checkpoints)\/|\.sqlite(?:-wal|-shm)?$|mcp-secret$)/.test(
      path.replaceAll("\\", "/"),
    ),
  );
  if (forbidden.length > 0)
    throw new Error(`Forbidden package artifact: ${relative(root, forbidden[0])}`);
  console.log(
    `Security gate passed across ${candidates.length} tracked files and ${packaged.length} package files`,
  );
}

function performance() {
  const portal = files(join(root, "dist", "portal"));
  if (portal.length === 0) throw new Error("Build the package before the performance gate");
  const scripts = portal.filter((path) => extname(path) === ".js");
  const largestScript = Math.max(0, ...scripts.map((path) => statSync(path).size));
  const portalBytes = portal.reduce((total, path) => total + statSync(path).size, 0);
  const daemonBytes = statSync(join(root, "dist", "daemon", "index.js")).size;
  if (largestScript > 512 * 1024)
    throw new Error(`Largest portal script exceeds 512 KiB: ${largestScript}`);
  if (portalBytes > 4 * 1024 * 1024) throw new Error(`Portal exceeds 4 MiB: ${portalBytes}`);
  if (daemonBytes > 4 * 1024 * 1024) throw new Error(`Daemon bundle exceeds 4 MiB: ${daemonBytes}`);
  console.log(
    JSON.stringify({ largestPortalScriptBytes: largestScript, portalBytes, daemonBytes }),
  );
}

function provenance() {
  const metadataPath = join(root, "dist", "meta", "build.json");
  if (!existsSync(metadataPath)) throw new Error("Build metadata is missing");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  if (metadata.commit !== commit)
    throw new Error(`Build commit ${metadata.commit} does not match HEAD ${commit}`);
  if (metadata.packageVersion !== packageJson.version)
    throw new Error("Build and package versions differ");
  if (metadata.channel !== (packageJson.version.includes("-") ? "next" : "latest"))
    throw new Error("Release channel does not match version");
  const portalDigest = directoryDigest(join(root, "dist", "portal"));
  if (metadata.portalAssetDigest !== portalDigest) throw new Error("Portal asset digest mismatch");
  console.log(`Provenance gate passed for ${metadata.packageVersion} at ${commit}`);
}

function sbom() {
  const path = join(root, "dist", "meta", "sbom.spdx.json");
  if (!existsSync(path)) throw new Error("SPDX SBOM is missing");
  const document = JSON.parse(readFileSync(path, "utf8"));
  if (document.spdxVersion !== "SPDX-2.3" || document.dataLicense !== "CC0-1.0") {
    throw new Error("SBOM identity is invalid");
  }
  const packages = document.packages ?? [];
  const names = new Set(packages.map((item) => item.name));
  for (const required of ["nanasa", "fastify", "node-pty", "@xterm/xterm", "react", "zod"]) {
    if (!names.has(required)) throw new Error(`SBOM is missing ${required}`);
  }
  const ids = packages.map((item) => item.SPDXID);
  if (new Set(ids).size !== ids.length) throw new Error("SBOM SPDX identifiers must be unique");
  if (
    !Array.isArray(document.relationships) ||
    document.relationships.length < packages.length - 1
  ) {
    throw new Error("SBOM dependency relationships are incomplete");
  }
  console.log(`SBOM gate passed with ${packages.length} package records`);
}

function release() {
  architecture();
  security();
  performance();
  provenance();
  sbom();
  const expected = [
    "dist/daemon/index.js",
    "dist/cli/admin.js",
    "dist/cli/control.js",
    "dist/meta/build.json",
    "dist/meta/sbom.spdx.json",
    "dist/portal/index.html",
    "dist/help/index.md",
    "templates/config.yaml",
    "templates/systemd/nanasa.service",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "README.md",
  ];
  for (const path of expected)
    if (!existsSync(join(root, path))) throw new Error(`Release input is missing ${path}`);
  const metadata = readFileSync(join(root, "dist", "meta", "build.json"), "utf8");
  console.log(`Release dry run passed (${sha256(metadata).slice(0, 16)})`);
}

({ architecture, security, performance, provenance, sbom, release })[gate]();
