import { createHash } from "node:crypto";
import type {
  AgentProfile,
  CredentialProfileReference,
  DesiredModelPolicy,
  GroupMembership,
  NativeRecoveryPolicy,
  NativeSessionReference,
  ProviderStateBinding,
  ProviderStatePolicy,
} from "@nanasa/contracts";
import { GeneratedOverlayTransaction } from "./generated-overlay-transaction.js";
import type { EffectiveAgentPrompt } from "./instruction-resolver.js";
import { providerOverlayBindingId, ProviderStateRepository } from "./provider-state-repository.js";
import { ProviderAdapterRegistry } from "./providers/provider-adapter-registry.js";
import {
  appendProviderArguments,
  freezeRunSnapshot,
  type ProviderRunSnapshot,
} from "./providers/provider-adapter.js";
import {
  type RepositoryLaunchManifest,
  RepositoryTrustService,
} from "./repository-trust-service.js";
import { UserCredentialBroker } from "./user-credential-broker.js";

export interface ProviderIntegrationPolicy {
  readonly providerState: ProviderStatePolicy;
  readonly credentials: CredentialProfileReference;
  readonly model: DesiredModelPolicy;
  readonly nativeRecovery: NativeRecoveryPolicy;
}

export interface AgentRuntimeConfiguration {
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly snapshot: ProviderRunSnapshot;
  readonly stateBinding: ProviderStateBinding;
  readonly nativeRecovery: NativeRecoveryPolicy;
}

export interface AgentRuntimeProvisionerOptions {
  integrationsDirectory: string;
  integrations: Readonly<Record<string, ProviderIntegrationPolicy>>;
  statusEndpointUrl: string;
  mcpEndpointUrl?: string;
  repositoryIdentity: string;
  adapterRegistry?: ProviderAdapterRegistry;
  stateRepository?: ProviderStateRepository;
  overlayTransaction?: GeneratedOverlayTransaction;
  credentialBroker?: UserCredentialBroker;
  trustService?: RepositoryTrustService;
  enforceRepositoryTrust?: boolean;
  assertProviderExtension?: (kind: AgentProfile["kind"]) => void;
  promptResolver?: (membership: GroupMembership, profile: AgentProfile) => EffectiveAgentPrompt;
  desiredModelResolver?: (membership: GroupMembership, profile: AgentProfile) => string | undefined;
}

export class AgentRuntimeProvisioner {
  readonly #options: AgentRuntimeProvisionerOptions;
  readonly #adapters: ProviderAdapterRegistry;
  readonly #states: ProviderStateRepository;
  readonly #overlays: GeneratedOverlayTransaction;
  readonly #credentials: UserCredentialBroker;

  public constructor(options: AgentRuntimeProvisionerOptions) {
    this.#options = options;
    this.#adapters = options.adapterRegistry ?? ProviderAdapterRegistry.builtIn();
    this.#states =
      options.stateRepository ?? new ProviderStateRepository(options.integrationsDirectory);
    this.#overlays =
      options.overlayTransaction ?? new GeneratedOverlayTransaction(options.integrationsDirectory);
    this.#credentials = options.credentialBroker ?? new UserCredentialBroker();
  }

  public provision(membership: GroupMembership, profile: AgentProfile): AgentRuntimeConfiguration {
    const policy = this.#options.integrations[profile.agentType];
    if (policy === undefined)
      throw new Error(`Provider integration policy is missing for ${profile.agentType}`);
    this.#options.assertProviderExtension?.(profile.kind);
    const adapter = this.#adapters.get(profile.kind);
    const configuredCommand = Object.freeze([profile.command, ...profile.args]);
    const acceptsProviderArguments = adapter.recognizeCommand(configuredCommand);
    const stateBinding = this.#states.resolve({
      membershipId: membership.id,
      integrationId: profile.agentType,
      policy: policy.providerState,
      credentialReference: policy.credentials,
    });
    const overlayBindingId = providerOverlayBindingId(membership.id, profile.agentType);
    const previousLedger = this.#overlays.readLedger(overlayBindingId);
    const overlayRevision = (previousLedger?.revision ?? 0) + 1;
    const overlayRoot = this.#overlays.overlayRoot(overlayBindingId, overlayRevision);
    const effectivePrompt = this.#options.promptResolver?.(membership, profile);
    const permissionFloor = effectivePrompt?.role?.permissionPolicy ?? "inherit";
    const overlay = adapter.planOverlay({
      membershipId: membership.id,
      memberAlias: membership.alias,
      stateRoot: stateBinding.storageReference,
      overlayRoot,
      statusEndpointUrl: this.#options.statusEndpointUrl,
      ...(this.#options.mcpEndpointUrl === undefined
        ? {}
        : { mcpEndpointUrl: this.#options.mcpEndpointUrl }),
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
    if (credential.health === "missing")
      throw new Error(`Credential profile ${credential.profileId} is unavailable`);
    const command = acceptsProviderArguments
      ? appendProviderArguments(configuredCommand, [
          ...overlay.commandArguments,
          ...(desiredModel === undefined ? [] : adapter.modelArguments(desiredModel)),
        ])
      : [...configuredCommand];
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
      ...(profile.workingDirectory === undefined
        ? {}
        : { workingDirectory: profile.workingDirectory }),
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
    if (this.#options.enforceRepositoryTrust === true) {
      if (this.#options.trustService === undefined)
        throw new Error("Repository trust enforcement requires a trust service");
      this.#options.trustService.assertTrusted(manifest);
    }
    this.#overlays.commit(overlayBindingId, overlayRevision, adapter.version, overlay.files);
    const snapshot = freezeRunSnapshot({
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      profile,
      stateRoot: stateBinding.storageReference,
      overlayRoot,
      configuredCommand,
      overlayArguments: overlay.commandArguments,
      command,
      environment,
      ...(desiredModel === undefined ? {} : { desiredModel }),
      desiredModelSource,
      modelResumePolicy: policy.model.resumePolicy,
      credentialReference: policy.credentials,
      overlayRevision,
      launchManifestDigest,
    });
    return Object.freeze({
      command: snapshot.command,
      environment: snapshot.environment,
      snapshot,
      stateBinding,
      nativeRecovery: policy.nativeRecovery,
    });
  }

  public resumeCommand(
    snapshot: ProviderRunSnapshot,
    reference: NativeSessionReference,
  ): readonly string[] {
    const adapter = this.#adapters.get(snapshot.profile.kind);
    const resumeModel =
      snapshot.modelResumePolicy === "enforce-configured" ? snapshot.desiredModel : undefined;
    return Object.freeze(
      appendProviderArguments(snapshot.configuredCommand, [
        ...snapshot.overlayArguments,
        ...adapter.resumeArguments(reference, resumeModel),
      ]),
    );
  }
}
