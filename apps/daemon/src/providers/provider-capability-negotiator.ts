import {
  type CapabilityDeclaration,
  canonicalJson,
  type HostCapabilitySupport,
  negotiateProviderCapabilities,
  PROVIDER_CAPABILITY_IDS,
  type ProviderGrant,
  ProviderGrantSchema,
  type ProviderPackageManifest,
  type SelectedCapability,
} from "@nanasa/contracts";

export const HOST_PROVIDER_CAPABILITIES = Object.freeze(
  PROVIDER_CAPABILITY_IDS.map((id) =>
    Object.freeze({
      id,
      version: Object.freeze({
        major: id === "reporter" ? 2 : 1,
        minimumMinor: 0,
        maximumMinor: 0,
      }),
    }),
  ),
) satisfies readonly HostCapabilitySupport[];

const RESERVED_BUILTIN_PROVIDERS = Object.freeze(["copilot", "claude-code", "pi", "opencode"]);

export class ProviderNamespaceOwnership {
  readonly #owners = new Map<string, string>();

  public constructor() {
    for (const providerId of RESERVED_BUILTIN_PROVIDERS) this.#owners.set(providerId, "nanasa");
  }

  public assertManifest(manifest: ProviderPackageManifest): void {
    const publisherId = manifest.generation.publisherId;
    const providerId = manifest.providerId;
    const ownsNamespace =
      manifest.generation.namespaceClaims.includes(providerId) &&
      (publisherId === "nanasa" && RESERVED_BUILTIN_PROVIDERS.includes(providerId)
        ? true
        : providerId === publisherId || providerId.startsWith(`${publisherId}.`));
    if (!ownsNamespace) {
      throw new Error(`Provider namespace ${providerId} is not owned by ${publisherId}`);
    }
    const owner = this.#owners.get(providerId);
    if (owner !== undefined && owner !== publisherId) {
      throw new Error(`Provider namespace ${providerId} is already owned by ${owner}`);
    }
  }

  public claim(manifest: ProviderPackageManifest): void {
    this.assertManifest(manifest);
    this.#owners.set(manifest.providerId, manifest.generation.publisherId);
  }

  public owner(providerId: string): string | undefined {
    return this.#owners.get(providerId);
  }
}

function selectedById(
  capabilities: readonly SelectedCapability[],
): Map<string, SelectedCapability> {
  return new Map(capabilities.map((capability) => [capability.id, capability]));
}

function subset(values: readonly string[], allowed: ReadonlySet<string>, message: string): void {
  if (values.some((value) => !allowed.has(value))) throw new Error(message);
}

export class ProviderPermissionPolicy {
  public resolve(
    capabilities: readonly SelectedCapability[],
    requestedInput: readonly ProviderGrant[],
  ): readonly ProviderGrant[] {
    const requested = requestedInput.map((grant) => ProviderGrantSchema.parse(grant));
    const canonical = requested.map((grant) => canonicalJson(grant));
    if (new Set(canonical).size !== canonical.length) {
      throw new Error("Provider grants must not contain duplicates");
    }

    const selected = selectedById(capabilities);
    const launch = selected.get("launch")?.payload as
      | { files: Array<{ recipeId: string }> }
      | undefined;
    const state = selected.get("state")?.payload as { scopes: string[] } | undefined;
    const reporter = selected.get("reporter")?.payload as
      | { sourceId: string; events: string[] }
      | undefined;
    const control = selected.get("control")?.payload as
      | { operations: Array<{ operationId: string; transport: string }> }
      | undefined;
    const credentials = selected.get("credentials")?.payload as
      | { slots: Array<{ slotId: string; targetNames: string[] }> }
      | undefined;
    const recipeIds = new Set(launch?.files.map((file) => file.recipeId) ?? []);
    const stateScopes = new Set(state?.scopes ?? []);
    const reporterEvents = new Set(reporter?.events ?? []);
    const terminalOperations = new Set(
      control?.operations
        .filter((operation) => operation.transport === "terminal")
        .map((operation) => operation.operationId) ?? [],
    );
    const providerOperations = new Set(
      control?.operations
        .filter((operation) => operation.transport !== "terminal")
        .map((operation) => operation.operationId) ?? [],
    );
    const credentialTargets = new Map(
      credentials?.slots.map((slot) => [slot.slotId, new Set(slot.targetNames)]) ?? [],
    );

    for (const grant of requested) {
      switch (grant.permission) {
        case "provider-state.read-managed":
          subset(grant.parameters.scopes, stateScopes, "State grant exceeds declared scopes");
          break;
        case "provider-state.write-owned":
          subset(grant.parameters.recipeIds, recipeIds, "State write grant exceeds file recipes");
          break;
        case "runtime.launch":
          break;
        case "network.connect":
          if (!selected.has("mcp")) throw new Error("Network grant requires MCP capability");
          break;
        case "reporter.emit":
          if (reporter?.sourceId !== grant.parameters.sourceId) {
            throw new Error("Reporter grant source does not match reporter capability");
          }
          subset(grant.parameters.events, reporterEvents, "Reporter grant exceeds declared events");
          break;
        case "terminal.operate":
          subset(
            grant.parameters.operationIds,
            terminalOperations,
            "Terminal grant exceeds terminal control operations",
          );
          break;
        case "provider.operation":
          subset(
            grant.parameters.operationIds,
            providerOperations,
            "Provider-operation grant exceeds nonterminal control operations",
          );
          break;
        case "credential.inject":
          for (const slotId of grant.parameters.slotIds) {
            if (!credentialTargets.has(slotId))
              throw new Error(`Unknown credential slot ${slotId}`);
          }
          for (const target of grant.parameters.targetNames) {
            if (
              !grant.parameters.slotIds.some(
                (slotId) => credentialTargets.get(slotId)?.has(target) === true,
              )
            ) {
              throw new Error(`Credential target ${target} is not owned by a granted slot`);
            }
          }
          break;
      }
    }
    return Object.freeze(
      requested
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
        .map((grant) => Object.freeze(grant)),
    );
  }
}

export function negotiateProviderPackage(
  manifest: ProviderPackageManifest,
  host: readonly HostCapabilitySupport[] = HOST_PROVIDER_CAPABILITIES,
  namespaceOwnership = new ProviderNamespaceOwnership(),
  permissionPolicy = new ProviderPermissionPolicy(),
): {
  readonly capabilities: readonly SelectedCapability[];
  readonly grants: readonly ProviderGrant[];
} {
  namespaceOwnership.assertManifest(manifest);
  const negotiation = negotiateProviderCapabilities(
    manifest.capabilities as readonly CapabilityDeclaration[],
    host,
  );
  const grants = permissionPolicy.resolve(negotiation.selected, manifest.requestedGrants);
  return Object.freeze({ capabilities: negotiation.selected, grants });
}
