import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  AgentKindSchema,
  CONFIG_VERSION,
  type ConfigDiagnostic,
  type ConfigStatus,
  ConfigStatusSchema,
  ConfiguredGroupSchema,
  ConfiguredProviderExtensionSchema,
  CredentialProfileReferenceSchema,
  DesiredModelPolicySchema,
  ExtensionIdSchema,
  InstructionPathSchema,
  IntegrationConfigSchema,
  IntegrationIdSchema,
  MessageConfigSchema,
  type NanasaConfig,
  NanasaConfigSchema,
  NativeRecoveryPolicySchema,
  ProviderStatePolicySchema,
  RepositoryIntentSchema,
  RoleDefinitionSchema,
  RoleIdSchema,
  TerminalPolicySchema,
} from "@nanasa/contracts";
import { isScalar, LineCounter, parseDocument, visit } from "yaml";
import { z } from "zod";
import { validateInstructionFiles } from "./instruction-resolver.js";
import { resolveProviderStateHome, validateProviderStatePolicy } from "./provider-state-home.js";

const CONFIG_RELATIVE_PATH = join(".nanasa", "config.yaml");
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_DEPTH = 20;
const MAX_CONFIG_NODES = 10_000;
const CORE_TAG_PREFIX = "tag:yaml.org,2002:";

const RawIntegrationConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: AgentKindSchema,
    command: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    cwd: z.string().min(1).max(4_096).optional(),
    providerState: ProviderStatePolicySchema.default({ scope: "membership" }),
    credentials: CredentialProfileReferenceSchema.default({ kind: "provider-managed" }),
    model: DesiredModelPolicySchema.default({ resumePolicy: "preserve-session" }),
    nativeRecovery: NativeRecoveryPolicySchema.default({
      mode: "resume-or-restart",
      confirmationTimeoutSeconds: 30,
    }),
    extensions: z.array(ExtensionIdSchema).max(32).default([]),
    environment: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16_384))
      .default({}),
  })
  .strict();
type RawIntegrationConfig = z.infer<typeof RawIntegrationConfigSchema>;

export const AuthoredNanasaConfigSchema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    repository: RepositoryIntentSchema.default({ path: ".", checkout: { kind: "current" } }),
    terminal: TerminalPolicySchema.default({
      checkpoints: {
        enabled: false,
        maxLines: 5_000,
        maxBytes: 1_048_576,
        retentionSeconds: 86_400,
        sensitivity: "repository-private",
      },
    }),
    instructions: z.array(InstructionPathSchema).max(32).default([]),
    integrations: z.record(IntegrationIdSchema, RawIntegrationConfigSchema),
    extensions: z.record(ExtensionIdSchema, ConfiguredProviderExtensionSchema).default({}),
    roles: z.record(RoleIdSchema, RoleDefinitionSchema).default({}),
    groups: z.record(z.string().trim().min(1).max(128), ConfiguredGroupSchema).default({}),
    messages: MessageConfigSchema.default({ retentionPerGroup: 1_000 }),
  })
  .strict();

export interface NanasaPaths {
  repoRoot: string;
  configPath: string;
  stateDirectory: string;
  dataPath: string;
  runtimeDirectory: string;
  integrationsDirectory: string;
}
export interface LoadedNanasaConfig extends NanasaPaths {
  config: NanasaConfig;
  status: ConfigStatus;
}
export class ConfigLoadError extends Error {
  public constructor(public readonly status: ConfigStatus) {
    super(status.diagnostics.map((item) => item.message).join("; "));
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
    if (existsSync(join(current, CONFIG_RELATIVE_PATH))) return realpathSync(current);
    if (gitRoot === undefined && existsSync(join(current, ".git"))) gitRoot = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (gitRoot !== undefined) return realpathSync(gitRoot);
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
    integrationsDirectory: join(root, ".nanasa", "integrations"),
  };
}
function diagnostic(
  code: string,
  message: string,
  path: Array<string | number> = [],
  position?: { line: number; column: number },
): ConfigDiagnostic {
  return { severity: "error", code, message, path, ...(position === undefined ? {} : position) };
}
function errorStatus(paths: NanasaPaths, diagnostics: ConfigDiagnostic[]): ConfigStatus {
  return ConfigStatusSchema.parse({
    state: "error",
    repoRoot: paths.repoRoot,
    configPath: paths.configPath,
    diagnostics,
  });
}
function assertInsideRepository(repoRoot: string, configuredPath: string, label: string): string {
  if (configuredPath.includes("\0")) throw new Error(`${label} may not contain NUL characters`);
  const candidate = resolve(repoRoot, configuredPath);
  const relativePath = relative(repoRoot, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must remain beneath the repository root`);
  }
  if (!existsSync(candidate) || !statSync(candidate).isDirectory())
    throw new Error(`${label} must reference an existing directory`);
  const realCandidate = realpathSync(candidate);
  const realRelative = relative(repoRoot, realCandidate);
  if (
    realRelative === ".." ||
    realRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(realRelative)
  ) {
    throw new Error(`${label} symlinks must remain beneath the repository root`);
  }
  return realCandidate;
}
function validateIntegration(integration: RawIntegrationConfig): string | undefined {
  if (integration.command.some((argument) => argument.includes("\0")))
    return "Command arguments may not contain NUL characters";
  for (const [name, value] of Object.entries(integration.environment)) {
    if (["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(name))
      return `Environment variable ${name} is not allowed`;
    if (value.includes("\0")) return `Environment variable ${name} may not contain NUL characters`;
  }
  try {
    validateProviderStatePolicy(integration.providerState);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid provider state policy";
  }
  return undefined;
}

export function parseNanasaConfigSource(
  source: string,
  paths: NanasaPaths,
): { config: NanasaConfig } {
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
    throw new ConfigLoadError(
      errorStatus(
        paths,
        document.errors.map((error) => {
          const offset = error.pos[0];
          const position = offset === undefined ? undefined : lineCounter.linePos(offset);
          return diagnostic(
            error.code,
            error.message,
            [],
            position === undefined ? undefined : { line: position.line, column: position.col },
          );
        }),
      ),
    );
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
  if (astDiagnostics.length > 0) throw new ConfigLoadError(errorStatus(paths, astDiagnostics));
  const parsed = AuthoredNanasaConfigSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
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
  let repositoryPath: string;
  try {
    repositoryPath = assertInsideRepository(
      paths.repoRoot,
      parsed.data.repository.path,
      "Repository path",
    );
  } catch (error) {
    throw new ConfigLoadError(
      errorStatus(paths, [
        diagnostic(
          "invalid_repository",
          error instanceof Error ? error.message : "Invalid repository path",
          ["repository", "path"],
        ),
      ]),
    );
  }
  const integrations = Object.fromEntries(
    Object.entries(parsed.data.integrations).map(([id, raw]) => {
      let cwd: string;
      try {
        cwd = assertInsideRepository(repositoryPath, raw.cwd ?? ".", "Working directory");
      } catch (error) {
        throw new ConfigLoadError(
          errorStatus(paths, [
            diagnostic(
              "invalid_cwd",
              error instanceof Error ? error.message : "Invalid working directory",
              ["integrations", id, "cwd"],
            ),
          ]),
        );
      }
      const invalid = validateIntegration(raw);
      if (invalid !== undefined)
        throw new ConfigLoadError(
          errorStatus(paths, [diagnostic("invalid_integration", invalid, ["integrations", id])]),
        );
      return [id, IntegrationConfigSchema.parse({ ...raw, id, cwd })];
    }),
  );
  const resolvedHomes = new Map<string, string>();
  for (const [id, integration] of Object.entries(integrations)) {
    const validationAgent =
      integration.providerState.scope === "membership" ? "agent_validation" : undefined;
    const home = resolveProviderStateHome(
      paths.integrationsDirectory,
      id,
      integration.providerState,
      validationAgent,
    );
    const collision = resolvedHomes.get(home);
    if (collision !== undefined)
      throw new ConfigLoadError(
        errorStatus(paths, [
          diagnostic("provider_state_collision", `Provider state home collides with ${collision}`, [
            "integrations",
            id,
            "providerState",
          ]),
        ]),
      );
    resolvedHomes.set(home, id);
  }
  const config = NanasaConfigSchema.parse({
    ...parsed.data,
    repository: { ...parsed.data.repository, path: repositoryPath },
    integrations,
  });
  try {
    validateInstructionFiles(paths.repoRoot, config);
  } catch (error) {
    throw new ConfigLoadError(
      errorStatus(paths, [
        diagnostic(
          "invalid_instruction_file",
          error instanceof Error ? error.message : "Invalid instruction file",
          ["instructions"],
        ),
      ]),
    );
  }
  return { config };
}

export function loadNanasaConfig(repoRoot: string): LoadedNanasaConfig {
  const paths = nanasaPaths(repoRoot);
  if (!existsSync(paths.configPath))
    throw new ConfigLoadError(
      errorStatus(paths, [
        diagnostic("config_not_found", "Nanasa configuration file was not found"),
      ]),
    );
  if (statSync(paths.configPath).size > MAX_CONFIG_BYTES)
    throw new ConfigLoadError(
      errorStatus(paths, [
        diagnostic("config_too_large", `Configuration exceeds ${MAX_CONFIG_BYTES} bytes`),
      ]),
    );
  const source = readFileSync(paths.configPath, "utf8");
  const { config } = parseNanasaConfigSource(source, paths);
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
