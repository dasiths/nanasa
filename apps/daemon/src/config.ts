import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  AdapterKindSchema,
  AgentCapabilitySchema,
  AgentKindSchema,
  type AgentTypeConfig,
  AgentTypeConfigSchema,
  type ConfigDiagnostic,
  type ConfigStatus,
  ConfigStatusSchema,
  type NanasaConfig,
  NanasaConfigSchema,
  RecoveryPolicySchema,
} from "@nanasa/contracts";
import { isScalar, LineCounter, parseDocument, visit } from "yaml";
import { z } from "zod";

const CONFIG_RELATIVE_PATH = join(".nanasa", "config.yaml");
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_DEPTH = 20;
const MAX_CONFIG_NODES = 10_000;
const CORE_TAG_PREFIX = "tag:yaml.org,2002:";

const RawAgentTypeConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: AgentKindSchema,
    adapter: AdapterKindSchema,
    command: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    cwd: z.string().min(1).max(4_096).optional(),
    environment: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16_384))
      .default({}),
    recovery: RecoveryPolicySchema,
    capabilities: z.array(AgentCapabilitySchema).min(1).max(2),
  })
  .strict();

const RawNanasaConfigSchema = z
  .object({
    version: z.literal(1),
    agentTypes: z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), RawAgentTypeConfigSchema),
  })
  .strict();

export interface NanasaPaths {
  repoRoot: string;
  configPath: string;
  stateDirectory: string;
  dataPath: string;
  runtimeDirectory: string;
}

export interface LoadedNanasaConfig extends NanasaPaths {
  config: NanasaConfig;
  status: ConfigStatus;
}

export class ConfigLoadError extends Error {
  public constructor(public readonly status: ConfigStatus) {
    super(status.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "ConfigLoadError";
  }
}

function startingDirectory(startPath: string): string {
  const resolved = resolve(startPath);
  return existsSync(resolved) && statSync(resolved).isFile() ? dirname(resolved) : resolved;
}

export function discoverRepositoryRoot(startPath = process.cwd()): string {
  let current = startingDirectory(startPath);
  let gitRoot: string | undefined;

  while (true) {
    if (existsSync(join(current, CONFIG_RELATIVE_PATH))) {
      return realpathSync(current);
    }
    if (gitRoot === undefined && existsSync(join(current, ".git"))) {
      gitRoot = current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (gitRoot !== undefined) {
    return realpathSync(gitRoot);
  }
  throw new Error(`Could not discover a repository root from ${startPath}`);
}

export function nanasaPaths(repoRoot: string): NanasaPaths {
  const root = realpathSync(resolve(repoRoot));
  const stateDirectory = join(root, ".nanasa", "state");
  return {
    repoRoot: root,
    configPath: join(root, CONFIG_RELATIVE_PATH),
    stateDirectory,
    dataPath: join(stateDirectory, "nanasa.sqlite"),
    runtimeDirectory: join(root, ".nanasa", "runtime"),
  };
}

function diagnostic(
  code: string,
  message: string,
  path: Array<string | number> = [],
  position?: { line: number; column: number },
): ConfigDiagnostic {
  return {
    severity: "error",
    code,
    message,
    path,
    ...(position === undefined ? {} : position),
  };
}

function errorStatus(paths: NanasaPaths, diagnostics: ConfigDiagnostic[]): ConfigStatus {
  return ConfigStatusSchema.parse({
    state: "error",
    repoRoot: paths.repoRoot,
    configPath: paths.configPath,
    diagnostics,
  });
}

function assertInsideRepository(repoRoot: string, configuredPath: string): string {
  if (configuredPath.includes("\0")) {
    throw new Error("Working directory may not contain NUL characters");
  }
  const candidate = resolve(repoRoot, configuredPath);
  const relativePath = relative(repoRoot, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Working directory must remain beneath the repository root");
  }
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error("Working directory must reference an existing directory");
  }
  const realCandidate = realpathSync(candidate);
  const realRelativePath = relative(repoRoot, realCandidate);
  if (
    realRelativePath === ".." ||
    realRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(realRelativePath)
  ) {
    throw new Error("Working directory symlinks must remain beneath the repository root");
  }
  return realCandidate;
}

function validateAgentType(agentType: AgentTypeConfig): string | undefined {
  if (agentType.command.some((argument) => argument.includes("\0"))) {
    return "Command arguments may not contain NUL characters";
  }
  for (const [name, value] of Object.entries(agentType.environment)) {
    if (["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(name)) {
      return `Environment variable ${name} is not allowed`;
    }
    if (value.includes("\0")) {
      return `Environment variable ${name} may not contain NUL characters`;
    }
  }
  if (agentType.adapter === "copilot-cli" && agentType.kind !== "copilot") {
    return "The copilot-cli adapter requires copilot compatibility";
  }
  if (agentType.adapter === "pi-rpc" && agentType.kind !== "pi") {
    return "The pi-rpc adapter requires pi compatibility";
  }
  return undefined;
}

function parseConfig(source: string, paths: NanasaPaths): NanasaConfig {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    merge: false,
    customTags: [],
    resolveKnownTags: false,
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    lineCounter,
  });

  if (document.errors.length > 0) {
    const diagnostics = document.errors.map((error) => {
      const offset = error.pos[0];
      const position = offset === undefined ? undefined : lineCounter.linePos(offset);
      return diagnostic(
        error.code,
        error.message,
        [],
        position === undefined ? undefined : { line: position.line, column: position.col },
      );
    });
    throw new ConfigLoadError(errorStatus(paths, diagnostics));
  }

  const astDiagnostics: ConfigDiagnostic[] = [];
  let nodeCount = 0;
  visit(document, {
    Node(_key, node, ancestry) {
      nodeCount += 1;
      if (nodeCount > MAX_CONFIG_NODES) {
        astDiagnostics.push(
          diagnostic("config_too_complex", `Configuration exceeds ${MAX_CONFIG_NODES} nodes`),
        );
        return visit.BREAK;
      }
      if (ancestry.length > MAX_CONFIG_DEPTH * 2 + 2) {
        astDiagnostics.push(
          diagnostic("config_too_deep", `Configuration exceeds depth ${MAX_CONFIG_DEPTH}`),
        );
        return visit.BREAK;
      }
      if (node.tag !== undefined && !node.tag.startsWith(CORE_TAG_PREFIX)) {
        astDiagnostics.push(diagnostic("custom_tag", `Custom YAML tag ${node.tag} is not allowed`));
        return visit.BREAK;
      }
      return undefined;
    },
    Alias() {
      astDiagnostics.push(diagnostic("yaml_alias", "YAML aliases and anchors are not allowed"));
      return visit.BREAK;
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        astDiagnostics.push(diagnostic("yaml_merge", "YAML merge keys are not allowed"));
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (astDiagnostics.length > 0) {
    throw new ConfigLoadError(errorStatus(paths, astDiagnostics));
  }

  const parsed = RawNanasaConfigSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success) {
    throw new ConfigLoadError(
      errorStatus(
        paths,
        parsed.error.issues.map((issue) =>
          diagnostic(
            "invalid_config",
            issue.message,
            issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
          ),
        ),
      ),
    );
  }

  const agentTypes = Object.fromEntries(
    Object.entries(parsed.data.agentTypes).map(([key, rawAgentType]) => {
      let cwd: string | undefined;
      try {
        cwd = assertInsideRepository(paths.repoRoot, rawAgentType.cwd ?? ".");
      } catch (error) {
        throw new ConfigLoadError(
          errorStatus(paths, [
            diagnostic(
              "invalid_cwd",
              error instanceof Error ? error.message : "Invalid working directory",
              ["agentTypes", key, "cwd"],
            ),
          ]),
        );
      }
      const normalized = AgentTypeConfigSchema.safeParse({ ...rawAgentType, key, cwd });
      if (!normalized.success) {
        throw new ConfigLoadError(
          errorStatus(
            paths,
            normalized.error.issues.map((issue) =>
              diagnostic("invalid_agent_type", issue.message, [
                "agentTypes",
                key,
                ...issue.path.filter(
                  (segment): segment is string | number => typeof segment !== "symbol",
                ),
              ]),
            ),
          ),
        );
      }
      const agentType = normalized.data;
      const invalidReason = validateAgentType(agentType);
      if (invalidReason !== undefined) {
        throw new ConfigLoadError(
          errorStatus(paths, [
            diagnostic("invalid_agent_type", invalidReason, ["agentTypes", key]),
          ]),
        );
      }
      return [key, agentType];
    }),
  );
  return NanasaConfigSchema.parse({ version: parsed.data.version, agentTypes });
}

export function loadNanasaConfig(repoRoot: string): LoadedNanasaConfig {
  const paths = nanasaPaths(repoRoot);
  if (!existsSync(paths.configPath)) {
    throw new ConfigLoadError(
      errorStatus(paths, [
        diagnostic("config_not_found", "Nanasa configuration file was not found"),
      ]),
    );
  }
  const size = statSync(paths.configPath).size;
  if (size > MAX_CONFIG_BYTES) {
    throw new ConfigLoadError(
      errorStatus(paths, [
        diagnostic("config_too_large", `Configuration exceeds ${MAX_CONFIG_BYTES} bytes`),
      ]),
    );
  }
  const source = readFileSync(paths.configPath, "utf8");
  const config = parseConfig(source, paths);
  const revision = createHash("sha256").update(source).digest("hex");
  const status = ConfigStatusSchema.parse({
    state: "ready",
    repoRoot: paths.repoRoot,
    configPath: paths.configPath,
    revision,
    diagnostics: [],
  });
  return { ...paths, config, status };
}

export function discoverAndLoadNanasaConfig(startPath = process.cwd()): LoadedNanasaConfig {
  return loadNanasaConfig(discoverRepositoryRoot(startPath));
}
