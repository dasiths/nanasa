import {
  type ProviderUpdatePlan,
  ProviderUpdatePlanSchema,
  type RunProviderBinding,
} from "@nanasa/contracts";

interface RunProviderBindingLookup {
  getForRun(
    runId: string,
    generation: number,
  ): Pick<RunProviderBinding, "providerId" | "snapshotDigest"> | undefined;
}

interface ActiveProviderRuntimeIndex {
  get(providerId: string): {
    readonly providerId: string;
    readonly snapshotDigest: string;
  };
}

export interface DetectProviderUpdateInput {
  readonly runId: string;
  readonly generation: number;
  readonly memberId: string;
}

export function planProviderUpdate(input: {
  readonly runId: string;
  readonly generation: number;
  readonly memberId: string;
  readonly providerId: string;
  readonly previousSnapshotDigest: string;
  readonly currentSnapshotDigest: string;
}): ProviderUpdatePlan {
  return ProviderUpdatePlanSchema.parse({
    ...input,
    status: input.previousSnapshotDigest === input.currentSnapshotDigest ? "current" : "outdated",
  });
}

export class ProviderUpdateDetector {
  readonly #bindings: RunProviderBindingLookup;
  readonly #index: ActiveProviderRuntimeIndex;

  public constructor(bindings: RunProviderBindingLookup, index: ActiveProviderRuntimeIndex) {
    this.#bindings = bindings;
    this.#index = index;
  }

  public detect(input: DetectProviderUpdateInput): ProviderUpdatePlan {
    const detected = this.detectIfBound(input);
    if (detected === undefined)
      throw new Error("Run provider binding is unavailable for update detection");
    return detected;
  }

  public detectIfBound(input: DetectProviderUpdateInput): ProviderUpdatePlan | undefined {
    const binding = this.#bindings.getForRun(input.runId, input.generation);
    if (binding === undefined) return undefined;
    const active = this.#index.get(binding.providerId);
    return planProviderUpdate({
      ...input,
      providerId: binding.providerId,
      previousSnapshotDigest: binding.snapshotDigest,
      currentSnapshotDigest: active.snapshotDigest,
    });
  }
}
