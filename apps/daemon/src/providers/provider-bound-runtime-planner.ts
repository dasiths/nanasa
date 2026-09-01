import { createHash } from "node:crypto";
import {
  canonicalJson,
  type RunProviderBinding,
  type RunProviderLaunchSelection,
  RunProviderLaunchSelectionSchema,
} from "@nanasa/contracts";
import type { GeneratedOverlayFile } from "./provider-runtime-types.js";
import {
  ProviderOverlayRepository,
  type RecoveredProviderOverlay,
} from "./provider-overlay-repository.js";
import { ProviderReporterDriverRegistry } from "./provider-reporter-driver-registry.js";
import {
  ProviderRunBindingRepository,
  type RecoveredRunProviderBinding,
} from "./provider-run-binding-repository.js";
import {
  ProviderSnapshotEvaluator,
  type ProviderSnapshotEvaluatorOptions,
  type SnapshotLaunchInput,
  type SnapshotNativeSession,
} from "./provider-snapshot-evaluator.js";
import type { ResolvedProviderAdapter } from "./resolved-provider-adapter.js";

export interface BindProviderRuntimeInput
  extends Omit<SnapshotLaunchInput, "overlayRoot" | "enforceConfiguredModelOnResume"> {
  readonly runId: string;
  readonly generation: number;
  readonly integrationId: string;
  readonly providerId: string;
  readonly providerStateId: string;
  readonly overlayId: string;
  readonly credentialSlots: Readonly<Record<string, string>>;
  readonly additionalEnvironment?: Readonly<Record<string, string>>;
  readonly additionalEnvironmentNames?: readonly string[];
  readonly repositoryTrustDigest: string;
  readonly workingDirectory?: string;
  readonly modelResumePolicy: "preserve-session" | "enforce-configured";
  readonly createdAt?: string;
}

export interface BoundProviderRuntime {
  readonly binding: RunProviderBinding;
  readonly snapshot: ResolvedProviderAdapter;
  readonly overlay: RecoveredProviderOverlay;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface RecoveredProviderRuntime {
  readonly recoveredBinding: RecoveredRunProviderBinding;
  readonly overlay: RecoveredProviderOverlay;
  readonly launchPlan: RunProviderLaunchSelection;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function overlayContentDigest(files: readonly GeneratedOverlayFile[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        files.map((file) => [
          file.relativePath,
          createHash("sha256").update(file.content).digest("hex"),
          file.mode ?? 0o600,
        ]),
      ),
    )
    .digest("hex");
}

function capabilityPayload(adapter: ResolvedProviderAdapter, id: string): unknown {
  const selected = adapter.body.capabilities.find((capability) => capability.id === id);
  if (selected === undefined) throw new Error(`Provider snapshot is missing ${id} capability`);
  return selected.payload;
}

function launchDigest(
  snapshotDigest: string,
  overlayId: string,
  revision: number,
  launchPlan: RunProviderLaunchSelection,
  overlayDigests: {
    readonly recipeDigest: string;
    readonly assetDigest: string;
    readonly contentDigest: string;
  },
): string {
  return digest({ snapshotDigest, overlayId, revision, launchPlan, ...overlayDigests });
}

export class ProviderBoundRuntimePlanner {
  readonly #bindings: ProviderRunBindingRepository;
  readonly #overlays: ProviderOverlayRepository;
  readonly #evaluatorOptions: ProviderSnapshotEvaluatorOptions;

  public constructor(
    bindings: ProviderRunBindingRepository,
    overlays: ProviderOverlayRepository,
    evaluatorOptions: ProviderSnapshotEvaluatorOptions = {},
  ) {
    this.#bindings = bindings;
    this.#overlays = overlays;
    this.#evaluatorOptions = evaluatorOptions;
  }

  public async bindAndCommit(input: BindProviderRuntimeInput): Promise<BoundProviderRuntime> {
    const snapshot = await this.#bindings.resolveActiveSnapshot(input.providerId);
    const evaluator = this.#evaluator(snapshot);
    const revision = 1;
    const overlayRoot = this.#overlays.overlayRoot(input.overlayId, revision);
    const planned = evaluator.launch({
      membershipId: input.membershipId,
      memberAlias: input.memberAlias,
      stateRoot: input.stateRoot,
      overlayRoot,
      statusEndpointUrl: input.statusEndpointUrl,
      ...(input.mcpEndpointUrl === undefined ? {} : { mcpEndpointUrl: input.mcpEndpointUrl }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      readOnly: input.readOnly,
      configuredCommand: input.configuredCommand,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.nativeSession === undefined ? {} : { nativeSession: input.nativeSession }),
      enforceConfiguredModelOnResume: input.modelResumePolicy === "enforce-configured",
    });
    const environment = Object.freeze({
      ...input.additionalEnvironment,
      ...planned.environment,
    });
    const launchPlan = RunProviderLaunchSelectionSchema.parse({
      configuredCommand: input.configuredCommand,
      command: planned.command,
      overlayArguments: planned.overlay.commandArguments,
      environmentNames: [
        ...new Set([...Object.keys(environment), ...(input.additionalEnvironmentNames ?? [])]),
      ].sort(),
      stateStorageReference: input.stateRoot,
      ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
      ...(input.model === undefined ? {} : { desiredModel: input.model }),
      modelResumePolicy: input.modelResumePolicy,
    });
    const overlayDigests = {
      recipeDigest: digest(
        (capabilityPayload(snapshot, "launch") as { files?: unknown }).files ?? [],
      ),
      assetDigest: digest(snapshot.body.assets),
      contentDigest: overlayContentDigest(planned.overlay.files),
    };
    const exactLaunchDigest = launchDigest(
      snapshot.digest,
      input.overlayId,
      revision,
      launchPlan,
      overlayDigests,
    );
    const prompt = capabilityPayload(snapshot, "prompt") as { readOnlyFloor: string[] };
    const binding = await this.#bindings.create({
      runId: input.runId,
      generation: input.generation,
      integrationId: input.integrationId,
      providerId: input.providerId,
      snapshotDigest: snapshot.digest,
      providerStateId: input.providerStateId,
      overlayId: input.overlayId,
      credentialSlots: input.credentialSlots,
      launchPlan,
      launchDigest: exactLaunchDigest,
      permissionFloorDigest: digest({ readOnly: input.readOnly, floor: prompt.readOnlyFloor }),
      repositoryTrustDigest: input.repositoryTrustDigest,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
    const overlay = this.#overlays.commit({
      binding,
      snapshot,
      adapterVersion: snapshot.body.extensionGeneration,
      files: planned.overlay.files,
      revision,
    });
    if (
      overlay.record.recipeDigest !== overlayDigests.recipeDigest ||
      overlay.record.assetDigest !== overlayDigests.assetDigest ||
      overlay.record.contentDigest !== overlayDigests.contentDigest
    ) {
      throw new Error("Committed provider overlay does not match the bound launch selection");
    }
    return Object.freeze({
      binding,
      snapshot,
      overlay,
      command: Object.freeze([...planned.command]),
      environment,
    });
  }

  public overlayRoot(overlayId: string, revision = 1): string {
    return this.#overlays.overlayRoot(overlayId, revision);
  }

  public async recover(runId: string, generation: number): Promise<RecoveredProviderRuntime> {
    const recoveredBinding = await this.#bindings.requireForRecovery(runId, generation);
    const overlay = this.#overlays.requireForRecovery(recoveredBinding);
    const expectedLaunchDigest = launchDigest(
      recoveredBinding.snapshot.digest,
      recoveredBinding.binding.overlayId,
      overlay.record.revision,
      recoveredBinding.binding.launchPlan,
      {
        recipeDigest: overlay.record.recipeDigest,
        assetDigest: overlay.record.assetDigest,
        contentDigest: overlay.record.contentDigest,
      },
    );
    if (expectedLaunchDigest !== recoveredBinding.binding.launchDigest) {
      throw new Error("Pinned provider launch selection digest does not match recovery evidence");
    }
    return Object.freeze({
      recoveredBinding,
      overlay,
      launchPlan: recoveredBinding.binding.launchPlan,
    });
  }

  public resumeCommand(
    runtime: RecoveredProviderRuntime,
    nativeSession: SnapshotNativeSession,
  ): readonly string[] {
    const evaluator = this.#evaluator(runtime.recoveredBinding.snapshot);
    const launchPlan = runtime.launchPlan;
    const argumentsList = [
      ...launchPlan.overlayArguments,
      ...evaluator.resumeArguments(nativeSession),
      ...(launchPlan.modelResumePolicy === "enforce-configured" &&
      launchPlan.desiredModel !== undefined
        ? evaluator.modelArguments(launchPlan.desiredModel)
        : []),
    ];
    return evaluator.augmentConfiguredCommand(launchPlan.configuredCommand, argumentsList);
  }

  #evaluator(snapshot: ResolvedProviderAdapter): ProviderSnapshotEvaluator {
    return new ProviderSnapshotEvaluator(
      snapshot,
      ProviderReporterDriverRegistry.fromSnapshot(snapshot),
      this.#evaluatorOptions,
    );
  }
}
