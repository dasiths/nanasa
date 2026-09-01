import { createHash } from "node:crypto";
import {
  canonicalJsonBytes,
  parseResolvedProviderAdapterSnapshot,
  type ResolvedProviderAdapterSnapshotBody,
  ResolvedProviderAdapterSnapshotSchema,
} from "@nanasa/contracts";

export type ProviderAssetKind =
  | "literal"
  | "copilot-plugin-manifest"
  | "copilot-hooks-manifest"
  | "copilot-mcp-config"
  | "copilot-prompt"
  | "claude-hooks-manifest"
  | "claude-mcp-config"
  | "plain-prompt"
  | "pi-mcp-config"
  | "pi-mcp-adapter"
  | "opencode-tui-config"
  | "opencode-managed-config"
  | "screen-manifest";

export interface ProviderAssetContent {
  readonly digest: string;
  readonly path: string;
  readonly mediaType: string;
  readonly kind: ProviderAssetKind;
  readonly payload: unknown;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function providerAssetBytes(
  asset: Pick<ProviderAssetContent, "kind" | "payload">,
): Uint8Array {
  if (asset.kind === "literal") {
    if (typeof asset.payload !== "string") {
      throw new Error("Literal provider assets must contain text bytes");
    }
    return new TextEncoder().encode(asset.payload);
  }
  return canonicalJsonBytes({ kind: asset.kind, payload: asset.payload });
}

export class ProviderAssetRegistry {
  readonly #assets: ReadonlyMap<string, ProviderAssetContent>;

  public constructor(assets: readonly ProviderAssetContent[]) {
    const indexed = new Map<string, ProviderAssetContent>();
    for (const asset of assets) {
      const bytes = providerAssetBytes(asset);
      if (digest(bytes) !== asset.digest) {
        throw new Error(`Provider asset digest mismatch for ${asset.path}`);
      }
      if (indexed.has(asset.digest)) throw new Error(`Duplicate provider asset ${asset.digest}`);
      indexed.set(
        asset.digest,
        deepFreeze({
          ...asset,
          payload: structuredClone(asset.payload),
        }),
      );
    }
    this.#assets = indexed;
  }

  public get(digestValue: string): ProviderAssetContent {
    const asset = this.#assets.get(digestValue);
    if (asset === undefined) throw new Error(`Provider asset is unavailable: ${digestValue}`);
    return asset;
  }

  public list(): readonly ProviderAssetContent[] {
    return Object.freeze([...this.#assets.values()]);
  }
}

export interface ResolvedProviderAdapter {
  readonly digest: string;
  readonly canonicalBytes: string;
  readonly body: ResolvedProviderAdapterSnapshotBody;
  readonly assets: ProviderAssetRegistry;
}

export async function resolveProviderAdapter(
  snapshotInput: unknown,
  assets: ProviderAssetRegistry,
): Promise<ResolvedProviderAdapter> {
  const snapshot = await parseResolvedProviderAdapterSnapshot(snapshotInput);
  const declaredAssets = new Map(snapshot.body.assets.map((asset) => [asset.digest, asset]));
  for (const asset of assets.list()) {
    const declared = declaredAssets.get(asset.digest);
    if (
      declared === undefined ||
      declared.path !== asset.path ||
      declared.mediaType !== asset.mediaType
    ) {
      throw new Error(`Provider asset declaration mismatch for ${asset.path}`);
    }
    if (declared.bytes !== providerAssetBytes(asset).byteLength) {
      throw new Error(`Provider asset byte count mismatch for ${asset.path}`);
    }
  }
  for (const declared of snapshot.body.assets) assets.get(declared.digest);
  const immutableSnapshot = deepFreeze(ResolvedProviderAdapterSnapshotSchema.parse(snapshot));
  return Object.freeze({
    ...immutableSnapshot,
    body: immutableSnapshot.body,
    assets,
  });
}

export function assertFunctionFreeProviderSnapshot(value: unknown, path = "snapshot"): void {
  if (typeof value === "function")
    throw new Error(`Provider snapshot contains a function at ${path}`);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFunctionFreeProviderSnapshot(item, `${path}/${index}`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assertFunctionFreeProviderSnapshot(item, `${path}/${key}`);
  }
}
