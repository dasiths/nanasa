import { createHash } from "node:crypto";
import type {
  AgentProfile,
  AgentRun,
  CredentialProfileReference,
  DesiredModelPolicy,
  GroupMembership,
  NativeRecoveryPolicy,
  NativeSessionReference,
  ProviderStateBinding,
  ProviderStatePolicy,
  RunProviderBinding,
} from "@nanasa/contracts";
import { AgentKindSchema } from "@nanasa/contracts";
import type { EffectiveAgentPrompt } from "./instruction-resolver.js";
import { providerOverlayBindingId, ProviderStateRepository } from "./provider-state-repository.js";
import {
  ProviderBoundRuntimePlanner,
  type RecoveredProviderRuntime,
} from "./providers/provider-bound-runtime-planner.js";
import { ProviderReporterDriverRegistry } from "./providers/provider-reporter-driver-registry.js";
import { ProviderRunBindingRepository } from "./providers/provider-run-binding-repository.js";
import {
  ProviderSnapshotEvaluator,
  type ProviderSnapshotEvaluatorOptions,
  type SnapshotControlPolicy,
} from "./providers/provider-snapshot-evaluator.js";
import type { ResolvedProviderAdapter } from "./providers/resolved-provider-adapter.js";
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
  readonly binding: RunProviderBinding;
  readonly stateBinding: ProviderStateBinding;
  readonly nativeRecovery: NativeRecoveryPolicy;
  readonly desiredModel?: string;
  readonly desiredModelSource: "membership" | "integration" | "provider-default";
}

export interface AgentRuntimeProvisionerOptions {
  integrationsDirectory: string;
  integrations: Readonly<Record<string, ProviderIntegrationPolicy>>;
  statusEndpointUrl: string;
  mcpEndpointUrl?: string;
  repositoryIdentity: string;
  planner: ProviderBoundRuntimePlanner;
  bindings: ProviderRunBindingRepository;
  evaluatorOptions?: ProviderSnapshotEvaluatorOptions;
  stateRepository?: ProviderStateRepository;
  credentialBroker?: UserCredentialBroker;
  trustService?: RepositoryTrustService;
  enforceRepositoryTrust?: boolean;
  assertProviderExtension?: (kind: AgentProfile["kind"]) => void;
  promptResolver?: (membership: GroupMembership, profile: AgentProfile) => EffectiveAgentPrompt;
  desiredModelResolver?: (membership: GroupMembership, profile: AgentProfile) => string | undefined;
}

export class AgentRuntimeProvisioner {
  readonly #options: AgentRuntimeProvisionerOptions;
  readonly #planner: ProviderBoundRuntimePlanner;
  readonly #bindings: ProviderRunBindingRepository;
  readonly #evaluatorOptions: ProviderSnapshotEvaluatorOptions;
  readonly #states: ProviderStateRepository;
  readonly #credentials: UserCredentialBroker;

  public constructor(options: AgentRuntimeProvisionerOptions) {
    this.#options = options;
    this.#planner = options.planner;
    this.#bindings = options.bindings;
    this.#evaluatorOptions = options.evaluatorOptions ?? {};
    this.#states =
      options.stateRepository ?? new ProviderStateRepository(options.integrationsDirectory);
    this.#credentials = options.credentialBroker ?? new UserCredentialBroker();
  }

  public async provision(
    run: AgentRun,
    membership: GroupMembership,
    profile: AgentProfile,
    nativeSession?: NativeSessionReference,
  ): Promise<AgentRuntimeConfiguration> {
    const policy = this.#options.integrations[profile.agentType];
    if (policy === undefined)
      throw new Error(`Provider integration policy is missing for ${profile.agentType}`);
    this.#options.assertProviderExtension?.(profile.kind);
    const snapshot = await this.#bindings.resolveActiveSnapshot(profile.kind);
    const evaluator = this.#evaluator(snapshot);
    const configuredCommand = Object.freeze([profile.command, ...profile.args]);
    if (!evaluator.matchesConfiguredCommand(configuredCommand)) {
      throw new Error(`Configured command is not recognized by snapshot ${snapshot.digest}`);
    }
    const stateBinding = this.#states.resolve({
      membershipId: membership.id,
      integrationId: profile.agentType,
      policy: policy.providerState,
      credentialReference: policy.credentials,
    });
    const effectivePrompt = this.#options.promptResolver?.(membership, profile);
    const permissionFloor = effectivePrompt?.role?.permissionPolicy ?? "inherit";
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
      profile.kind,
      evaluator.credentialEnvironmentNames(),
    );
    if (credential.health === "missing")
      throw new Error(`Credential profile ${credential.profileId} is unavailable`);
    const overlayId = providerOverlayBindingId(run.id, profile.agentType);
    const overlayRoot = this.#planner.overlayRoot(overlayId);
    const normalizedSession =
      nativeSession === undefined
        ? undefined
        : evaluator.normalizeNativeSession(
            {
              source: nativeSession.source,
              referenceKind: nativeSession.referenceKind,
              referenceValue: nativeSession.referenceValue,
            },
            stateBinding.storageReference,
          );
    const preview = evaluator.launch({
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
      configuredCommand,
      ...(desiredModel === undefined ? {} : { model: desiredModel }),
      ...(normalizedSession === undefined ? {} : { nativeSession: normalizedSession }),
      enforceConfiguredModelOnResume: policy.model.resumePolicy === "enforce-configured",
    });
    const additionalEnvironment = Object.freeze({
      ...profile.environment,
      ...credential.environment,
    });
    const environment = Object.freeze({ ...additionalEnvironment, ...preview.environment });
    const manifest: RepositoryLaunchManifest = Object.freeze({
      repositoryIdentity: this.#options.repositoryIdentity,
      adapterId: snapshot.body.adapterId,
      adapterVersion: snapshot.body.extensionGeneration,
      command: preview.command,
      ...(profile.workingDirectory === undefined
        ? {}
        : { workingDirectory: profile.workingDirectory }),
      environmentNames: Object.freeze(Object.keys(environment).sort()),
      credentialReference: policy.credentials,
      generatedIdentities: preview.overlay.generatedIdentities,
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
    const bound = await this.#planner.bindAndCommit({
      runId: run.id,
      generation: run.generation,
      integrationId: profile.agentType,
      providerId: profile.kind,
      providerStateId: stateBinding.id,
      overlayId,
      credentialSlots: this.#credentialSlots(snapshot, policy.credentials),
      additionalEnvironment,
      additionalEnvironmentNames: [
        "NANASA_MCP_TOKEN",
        "NANASA_STATUS_URL",
        "NANASA_REPORTER_PROVIDER_ID",
        "NANASA_REPORTER_ADAPTER_ID",
        "NANASA_REPORTER_ID",
        "NANASA_REPORTER_SOURCE",
        "NANASA_REPORTER_PROTOCOL_VERSION",
        "NANASA_REPORTER_VERSION",
        "NANASA_REPORTER_RUN_ID",
        "NANASA_REPORTER_GENERATION",
        "NANASA_REPORTER_EPOCH",
        "NANASA_REPORTER_SEQUENCE_FILE",
        ...(this.#options.mcpEndpointUrl === undefined ? [] : ["NANASA_MCP_URL"]),
      ],
      repositoryTrustDigest: launchManifestDigest,
      membershipId: membership.id,
      memberAlias: membership.alias,
      stateRoot: stateBinding.storageReference,
      statusEndpointUrl: this.#options.statusEndpointUrl,
      ...(this.#options.mcpEndpointUrl === undefined
        ? {}
        : { mcpEndpointUrl: this.#options.mcpEndpointUrl }),
      ...(effectivePrompt === undefined ? {} : { prompt: effectivePrompt }),
      readOnly: permissionFloor === "read-only",
      configuredCommand,
      ...(desiredModel === undefined ? {} : { model: desiredModel }),
      ...(normalizedSession === undefined ? {} : { nativeSession: normalizedSession }),
      modelResumePolicy: policy.model.resumePolicy,
      ...(profile.workingDirectory === undefined
        ? {}
        : { workingDirectory: profile.workingDirectory }),
    });
    return Object.freeze({
      command: bound.command,
      environment: bound.environment,
      binding: bound.binding,
      stateBinding,
      nativeRecovery: policy.nativeRecovery,
      ...(desiredModel === undefined ? {} : { desiredModel }),
      desiredModelSource,
    });
  }

  public async controlPolicy(run: AgentRun): Promise<SnapshotControlPolicy> {
    return this.#evaluatorForRun(run).then((evaluator) => evaluator.controlPolicy());
  }

  public async encodeWaitReply(
    run: AgentRun,
    reply: Parameters<ProviderSnapshotEvaluator["encodeWaitReply"]>[0],
  ): Promise<string> {
    return this.#evaluatorForRun(run).then((evaluator) => evaluator.encodeWaitReply(reply));
  }

  public async processRecognizer(run: AgentRun): Promise<{
    recognizeCommand(command: readonly string[]): boolean;
  }> {
    const evaluator = await this.#evaluatorForRun(run);
    return Object.freeze({
      recognizeCommand: (command: readonly string[]) => evaluator.matchesObservedProcess(command),
    });
  }

  public async reporterPolicy(run: AgentRun): Promise<{
    integrationId: string;
    adapterId: string;
    reporterId: string;
    source: string;
    reporterVersion: string;
    events: readonly string[];
  }> {
    const recovered = await this.#bindings.requireForRecovery(run.id, run.generation);
    const policy = this.#evaluator(recovered.snapshot).reporterPolicy() as {
      driverId: string;
      sourceId: string;
      reporterVersion: string;
      events: string[];
    };
    return Object.freeze({
      integrationId: recovered.binding.integrationId,
      adapterId: recovered.binding.adapterId,
      reporterId: policy.driverId,
      source: policy.sourceId,
      reporterVersion: policy.reporterVersion,
      events: Object.freeze([...policy.events]),
    });
  }

  public async normalizeNativeSession(
    run: AgentRun,
    report: {
      source: string;
      referenceKind: "id" | "path";
      referenceValue: string;
    },
    stateRoot: string,
  ): Promise<NativeSessionReference> {
    const evaluator = await this.#evaluatorForRun(run);
    const normalized = evaluator.normalizeNativeSession(report, stateRoot);
    return Object.freeze({
      provider: AgentKindSchema.parse(normalized.providerId),
      source: normalized.source,
      referenceKind: normalized.referenceKind === "state-contained-path" ? "path" : "id",
      referenceValue: normalized.referenceValue,
      dedupeHash: normalized.dedupeDigest,
    });
  }

  public recover(run: AgentRun): Promise<RecoveredProviderRuntime> {
    return this.#planner.recover(run.id, run.generation);
  }

  public async providerStateRoot(run: AgentRun): Promise<string> {
    const recovered = await this.#bindings.requireForRecovery(run.id, run.generation);
    return recovered.binding.launchPlan.stateStorageReference;
  }

  async #evaluatorForRun(run: AgentRun): Promise<ProviderSnapshotEvaluator> {
    const recovered = await this.#bindings.requireForRecovery(run.id, run.generation);
    return this.#evaluator(recovered.snapshot);
  }

  #evaluator(snapshot: ResolvedProviderAdapter): ProviderSnapshotEvaluator {
    return new ProviderSnapshotEvaluator(
      snapshot,
      ProviderReporterDriverRegistry.fromSnapshot(snapshot),
      this.#evaluatorOptions,
    );
  }

  #credentialSlots(
    snapshot: ResolvedProviderAdapter,
    reference: CredentialProfileReference,
  ): Readonly<Record<string, string>> {
    const credentials = snapshot.body.capabilities.find(
      (capability) => capability.id === "credentials",
    )?.payload as { slots?: Array<{ slotId: string }> } | undefined;
    const value = reference.kind === "provider-managed" ? "provider-managed" : reference.profileId;
    return Object.freeze(
      Object.fromEntries((credentials?.slots ?? []).map((slot) => [slot.slotId, value])),
    );
  }
}
