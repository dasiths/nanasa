import { existsSync, lstatSync, rmSync } from "node:fs";
import type { ProviderStateBinding } from "@nanasa/contracts";
import { GeneratedOverlayTransaction } from "./generated-overlay-transaction.js";
import { providerOverlayBindingId, ProviderStateRepository } from "./provider-state-repository.js";

export class ProviderStateLifecycle {
  public constructor(
    private readonly states: ProviderStateRepository,
    private readonly overlays: GeneratedOverlayTransaction,
  ) {}

  public retain(bindingId: string): ProviderStateBinding {
    return this.states.retain(bindingId);
  }

  public resetGenerated(bindingId: string): boolean {
    const binding = this.states.get(bindingId);
    if (binding?.memberId === undefined) return false;
    return this.overlays.removeConservatively(
      providerOverlayBindingId(binding.memberId, binding.integrationId),
    );
  }

  public deleteOwnedState(
    bindingId: string,
    activeBindingIds: ReadonlySet<string>,
  ): ProviderStateBinding {
    if (activeBindingIds.has(bindingId)) throw new Error("Active provider state cannot be deleted");
    const binding = this.states.get(bindingId);
    if (binding === undefined) throw new Error("Provider state binding was not found");
    if (binding.scope === "integration") {
      const sharedReferences = this.states
        .list()
        .filter(
          (candidate) =>
            candidate.id !== binding.id &&
            candidate.storageReference === binding.storageReference &&
            candidate.lifecycle !== "deleted",
        );
      if (sharedReferences.length > 0)
        throw new Error("Shared integration state is still referenced");
    }
    this.states.markDeleting(bindingId);
    if (binding.memberId !== undefined) {
      this.overlays.removeConservatively(
        providerOverlayBindingId(binding.memberId, binding.integrationId),
      );
    }
    if (existsSync(binding.storageReference)) {
      const status = lstatSync(binding.storageReference);
      if (!status.isDirectory() || status.isSymbolicLink())
        throw new Error("Provider state deletion refused an unsafe path");
      rmSync(binding.storageReference, { recursive: true, force: false });
    }
    return this.states.markDeleted(bindingId);
  }
}
