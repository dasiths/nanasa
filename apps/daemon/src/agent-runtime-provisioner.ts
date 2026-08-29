export * from "./provider-runtime-provisioner.js";

/* Discarded pre-adapter implementation retained only until the alpha source reset completes.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProfile, GroupMembership, ProviderStatePolicy } from "@nanasa/contracts";
import { providerStateEnvironment, resolveProviderStateHome } from "./provider-state-home.js";
import type { EffectiveAgentPrompt } from "./instruction-resolver.js";
import {
  HOOK_STATUS_REPORTER_SOURCE,
  OPENCODE_STATUS_REPORTER_SOURCE,
  PI_STATUS_REPORTER_SOURCE,
} from "./status-reporter-assets.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface AgentRuntimeConfiguration {
  command: string[];
  environment: Record<string, string>;
}

export interface AgentRuntimeProvisionerOptions {
  integrationsDirectory: string;
  providerStates: Readonly<Record<string, ProviderStatePolicy>>;
  mcpEndpointUrl: string;
  piExtensionPath?: string;
  promptResolver?: (membership: GroupMembership, profile: AgentProfile) => EffectiveAgentPrompt;
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Agent runtime path must be a regular directory: ${path}`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`Agent runtime path must be owned by the current user: ${path}`);
  }
  chmodSync(path, DIRECTORY_MODE);
}

function ensurePrivateTree(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const relativePath = relative(resolvedRoot, resolve(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Agent runtime path must remain beneath integrations: ${path}`);
  }
  ensurePrivateDirectory(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    ensurePrivateDirectory(current);
  }
}

function writePrivateJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  renameSync(temporaryPath, path);
  chmodSync(path, FILE_MODE);
}

function readPrivateJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Agent runtime file must be a regular file: ${path}`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`Agent runtime file must be owned by the current user: ${path}`);
  }
  if (status.size > 2 * 1024 * 1024) {
    throw new Error(`Agent runtime JSON exceeds the supported size: ${path}`);
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Agent runtime JSON must contain an object: ${path}`);
  }
  return value as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isNanasaClaudeHook(value: unknown): boolean {
  return JSON.stringify(value).includes("nanasa-status-hook.mjs");
}

function writePrivateText(path: string, value: string): void {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, value.endsWith("\n") ? value : `${value}\n`, {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  renameSync(temporaryPath, path);
  chmodSync(path, FILE_MODE);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function generatedAgentName(membershipId: string): string {
  return `nanasa-${createHash("sha256").update(membershipId).digest("hex").slice(0, 16)}`;
}

function appendProviderArguments(command: string[], providerArguments: string[]): string[] {
  if (command[0] === "make" && command[1] === "claude-copilot") {
    return [...command, `CLAUDE_ARGS=${providerArguments.map(shellQuote).join(" ")}`];
  }
  return [...command, ...providerArguments];
}

const PI_READ_ONLY_POLICY_SOURCE = `export default function (pi) {
  const blocked = new Set(["bash", "edit", "write"]);
  pi.on("tool_call", (event) => {
    if (blocked.has(event.toolName)) {
      return { block: true, reason: "The active Nanasa role is read-only", terminate: true };
    }
  });
}
`;

function commandHook(scriptPath: string, source: "claude-code" | "copilot", eventName: string) {
  return {
    type: "command",
    command: process.execPath,
    args: [scriptPath, source, eventName],
    timeout: 2,
  };
}

export class AgentRuntimeProvisioner {
  readonly #options: AgentRuntimeProvisionerOptions;

  public constructor(options: AgentRuntimeProvisionerOptions) {
    this.#options = options;
    ensurePrivateDirectory(options.integrationsDirectory);
  }
  public provision(membership: GroupMembership, profile: AgentProfile): AgentRuntimeConfiguration {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(membership.id)) {
      throw new Error(`Agent ID is not safe for agent persistence: ${membership.id}`);
    }
    const policy = this.#options.providerStates[profile.agentType];
    if (policy === undefined) {
      throw new Error(`Agent configuration home is missing for ${profile.agentType}`);
    }
    const configHome = resolveProviderStateHome(
      this.#options.integrationsDirectory,
      profile.agentType,
      policy,
      membership.id,
    );
    const memberDirectory = join(
      this.#options.integrationsDirectory,
      "members",
      membership.id,
      profile.agentType,
      const policy = this.#options.integrations[profile.agentType];
      if (policy === undefined) throw new Error(`Provider integration policy is missing for ${profile.agentType}`);
      const adapter = this.#adapters.get(profile.kind);
      const configuredCommand = Object.freeze([profile.command, ...profile.args]);
      if (!adapter.recognizeCommand(configuredCommand)) {
        throw new Error(`Configured command is not recognized by adapter ${adapter.id}`);
      }
      const stateBinding = this.#states.resolve({
        membershipId: membership.id,
        integrationId: profile.agentType,
        policy: policy.providerState,
        credentialReference: policy.credentials,
      });
      const previousLedger = this.#overlays.readLedger(stateBinding.id);
      const overlayRevision = (previousLedger?.revision ?? 0) + 1;
      const overlayRoot = this.#overlays.overlayRoot(stateBinding.id, overlayRevision);
      const effectivePrompt = this.#options.promptResolver?.(membership, profile);
      const permissionFloor = effectivePrompt?.role?.permissionPolicy ?? "inherit";
      const overlay = adapter.planOverlay({
        membershipId: membership.id,
        memberAlias: membership.alias,
        stateRoot: stateBinding.storageReference,
        overlayRoot,
        statusEndpointUrl: this.#options.statusEndpointUrl,
        ...(this.#options.mcpEndpointUrl === undefined ? {} : { mcpEndpointUrl: this.#options.mcpEndpointUrl }),
        ...(effectivePrompt === undefined ? {} : { prompt: effectivePrompt }),
        readOnly: permissionFloor === "read-only",
      });
      const membershipModel = this.#options.desiredModelResolver?.(membership, profile);
      const desiredModel = membershipModel ?? policy.model.model;
      const desiredModelSource =
        membershipModel !== undefined
          ? "membership"
          : policy.model.model !== undefined
            ? "integration"
            : "provider-default";
      const credential = this.#credentials.resolve(
        policy.credentials,
        adapter.id,
        adapter.credentialEnvironmentNames(),
      );
      if (credential.health === "missing") throw new Error(`Credential profile ${credential.profileId} is unavailable`);
      const modelArguments = desiredModel === undefined ? [] : adapter.modelArguments(desiredModel);
      const command = appendProviderArguments(configuredCommand, [
        ...overlay.commandArguments,
        ...modelArguments,
      ]);
      const environment = Object.freeze({
        ...profile.environment,
        ...adapter.stateEnvironment(stateBinding.storageReference),
        ...overlay.environment,
        ...credential.environment,
      });
      const manifest: RepositoryLaunchManifest = Object.freeze({
        repositoryIdentity: this.#options.repositoryIdentity,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        command: Object.freeze([...command]),
        ...(profile.workingDirectory === undefined ? {} : { workingDirectory: profile.workingDirectory }),
        environmentNames: Object.freeze(Object.keys(environment).sort()),
        credentialReference: policy.credentials,
        generatedIdentities: overlay.generatedIdentities,
        permissionFloor,
        ...(desiredModel === undefined ? {} : { desiredModel }),
        modelResumePolicy: policy.model.resumePolicy,
      });
      const launchManifestDigest =
        this.#options.trustService?.digest(manifest) ??
        createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
      if (this.#options.enforceRepositoryTrust === true) this.#options.trustService?.assertTrusted(manifest);
      this.#overlays.commit(stateBinding.id, overlayRevision, adapter.version, overlay.files);
      const snapshot = freezeRunSnapshot({
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        profile,
        stateRoot: stateBinding.storageReference,
        overlayRoot,
        command,
        environment,
        ...(desiredModel === undefined ? {} : { desiredModel }),
        desiredModelSource,
        modelResumePolicy: policy.model.resumePolicy,
        credentialReference: policy.credentials,
        overlayRevision,
        launchManifestDigest,
      });
      return Object.freeze({ command: snapshot.command, environment: snapshot.environment, snapshot, stateBinding, nativeRecovery: policy.nativeRecovery });
    }

    public resumeCommand(snapshot: ProviderRunSnapshot, reference: NativeSessionReference): readonly string[] {
      const adapter = this.#adapters.get(snapshot.profile.kind);
      const resumeModel = snapshot.modelResumePolicy === "enforce-configured" ? snapshot.desiredModel : undefined;
      return Object.freeze(appendProviderArguments(snapshot.command, adapter.resumeArguments(reference, resumeModel)));
    }
        const hook = (eventName: string, matcher?: string) => ({
      */
