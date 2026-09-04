import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AgentProfile,
  ExecutionProfile,
  GroupMembership,
  NanasaConfig,
  ProviderFileSelection,
} from "@nanasa/contracts";

const MAX_PROVIDER_FILE_BYTES = 256 * 1024;
const MAX_PROVIDER_FILES_BYTES = 1024 * 1024;

export type ProviderPolicyErrorCode =
  | "execution_profile_not_authorized"
  | "provider_file_invalid"
  | "provider_file_not_authorized";

export class ProviderPolicyError extends Error {
  public constructor(
    public readonly code: ProviderPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderPolicyError";
  }
}

export interface ResolvedProviderFile {
  readonly sourcePath: string;
  readonly scope: "integration" | "agent";
  readonly content: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface EffectiveProviderPolicy {
  readonly configRevision?: string;
  readonly executionProfileId?: string;
  readonly executionProfile?: ExecutionProfile;
  readonly providerFiles: readonly ResolvedProviderFile[];
}

export interface ResolveEffectiveProviderPolicyInput {
  readonly repoRoot: string;
  readonly config: NanasaConfig;
  readonly membership: GroupMembership;
  readonly profile: Pick<AgentProfile, "agentType">;
  readonly allowAutonomous: boolean;
  readonly allowProviderFiles: boolean;
  readonly configRevision?: string;
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function snapshotProviderFile(
  repoRoot: string,
  sourcePath: string,
  scope: ResolvedProviderFile["scope"],
): ResolvedProviderFile {
  const root = realpathSync(resolve(repoRoot));
  const candidate = resolve(root, sourcePath);
  if (!isInside(root, candidate)) {
    throw new ProviderPolicyError(
      "provider_file_invalid",
      `Provider file must remain beneath the repository: ${sourcePath}`,
    );
  }
  let status;
  try {
    status = lstatSync(candidate);
  } catch {
    throw new ProviderPolicyError(
      "provider_file_invalid",
      `Provider file does not exist: ${sourcePath}`,
    );
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new ProviderPolicyError(
      "provider_file_invalid",
      `Provider file must be a regular file without symlinks: ${sourcePath}`,
    );
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new ProviderPolicyError(
      "provider_file_invalid",
      `Provider file must be owned by the daemon user: ${sourcePath}`,
    );
  }
  if (status.size > MAX_PROVIDER_FILE_BYTES) {
    throw new ProviderPolicyError(
      "provider_file_invalid",
      `Provider file exceeds ${MAX_PROVIDER_FILE_BYTES} bytes: ${sourcePath}`,
    );
  }
  const realCandidate = realpathSync(candidate);
  if (!isInside(root, realCandidate)) {
    throw new ProviderPolicyError(
      "provider_file_invalid",
      `Provider file symlink target escapes the repository: ${sourcePath}`,
    );
  }

  const descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino) {
      throw new ProviderPolicyError(
        "provider_file_invalid",
        `Provider file changed while being inspected: ${sourcePath}`,
      );
    }
    const bytes = readFileSync(descriptor);
    const content = bytes.toString("utf8");
    try {
      JSON.parse(content);
    } catch {
      throw new ProviderPolicyError(
        "provider_file_invalid",
        `Provider file must contain valid JSON: ${sourcePath}`,
      );
    }
    return Object.freeze({
      sourcePath,
      scope,
      content,
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    });
  } finally {
    closeSync(descriptor);
  }
}

function selectedPaths(
  integration: ProviderFileSelection,
  agent: ProviderFileSelection,
): Array<{ path: string; scope: ResolvedProviderFile["scope"] }> {
  const integrationPaths =
    integration.mcp === undefined || integration.mcp.mode === "disabled"
      ? []
      : integration.mcp.paths.map((path) => ({ path, scope: "integration" as const }));
  if (agent.mcp === undefined) return integrationPaths;
  if (agent.mcp.mode === "disabled") return [];
  const agentPaths = agent.mcp.paths.map((path) => ({ path, scope: "agent" as const }));
  return agent.mcp.mode === "replace" ? agentPaths : [...integrationPaths, ...agentPaths];
}

export function resolveEffectiveProviderPolicy(
  input: ResolveEffectiveProviderPolicyInput,
): EffectiveProviderPolicy {
  const integration = input.config.integrations[input.profile.agentType];
  if (integration === undefined) {
    throw new Error(`Provider integration policy is missing for ${input.profile.agentType}`);
  }
  const agent = input.config.groups[input.membership.groupId]?.agents[input.membership.id];
  if (agent === undefined)
    throw new Error(`Configured agent is missing for ${input.membership.id}`);
  const executionProfileId = integration.executionProfile;
  const executionProfile =
    executionProfileId === undefined
      ? undefined
      : (input.config.executionProfiles ?? {})[executionProfileId];
  if (executionProfileId !== undefined && executionProfile === undefined) {
    throw new Error(`Execution profile is missing for ${executionProfileId}`);
  }
  if (
    executionProfile !== undefined &&
    (executionProfile.continuation === "autonomous" ||
      executionProfile.questions === "disabled" ||
      executionProfile.approvals !== "provider-default") &&
    !input.allowAutonomous
  ) {
    throw new ProviderPolicyError(
      "execution_profile_not_authorized",
      `Execution profile ${executionProfileId} requires daemon authorization`,
    );
  }

  const paths = selectedPaths(integration.providerFiles ?? {}, agent.providerFiles ?? {});
  if (paths.length > 0 && !input.allowProviderFiles) {
    throw new ProviderPolicyError(
      "provider_file_not_authorized",
      "Repository provider files require daemon authorization",
    );
  }
  const seen = new Set<string>();
  const providerFiles = paths.map(({ path, scope }) => {
    if (seen.has(path)) {
      throw new ProviderPolicyError(
        "provider_file_invalid",
        `Effective provider file paths must be unique: ${path}`,
      );
    }
    seen.add(path);
    return snapshotProviderFile(input.repoRoot, path, scope);
  });
  const totalBytes = providerFiles.reduce((total, file) => total + file.bytes, 0);
  if (totalBytes > MAX_PROVIDER_FILES_BYTES) {
    throw new ProviderPolicyError(
      "provider_file_invalid",
      `Provider files exceed ${MAX_PROVIDER_FILES_BYTES} combined bytes`,
    );
  }
  return Object.freeze({
    ...(input.configRevision === undefined ? {} : { configRevision: input.configRevision }),
    ...(executionProfileId === undefined ? {} : { executionProfileId }),
    ...(executionProfile === undefined
      ? {}
      : { executionProfile: Object.freeze(executionProfile) }),
    providerFiles: Object.freeze(providerFiles),
  });
}
