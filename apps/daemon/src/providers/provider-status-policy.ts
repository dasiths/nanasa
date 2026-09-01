import {
  ScreenCapabilityPayloadSchema,
  SemanticStatusCapabilityPayloadSchema,
} from "@nanasa/contracts";
import type { ResolvedProviderAdapter } from "./resolved-provider-adapter.js";

export interface ProviderStatusPolicy {
  readonly semantic: ReturnType<typeof SemanticStatusCapabilityPayloadSchema.parse>;
  readonly screen: ReturnType<typeof ScreenCapabilityPayloadSchema.parse>;
  readonly screenManifest: unknown;
}

export function providerStatusPolicy(adapter: ResolvedProviderAdapter): ProviderStatusPolicy {
  const semanticCapability = adapter.body.capabilities.find(
    (capability) => capability.id === "semantic-status",
  );
  const screenCapability = adapter.body.capabilities.find(
    (capability) => capability.id === "screen",
  );
  if (semanticCapability === undefined || screenCapability === undefined) {
    throw new Error("Provider snapshot does not declare complete status policy");
  }
  const semantic = SemanticStatusCapabilityPayloadSchema.parse(semanticCapability.payload);
  const screen = ScreenCapabilityPayloadSchema.parse(screenCapability.payload);
  const manifest = adapter.assets.get(screen.manifestDigest);
  if (manifest.kind !== "screen-manifest") {
    throw new Error("Provider screen capability references a non-manifest asset");
  }
  return Object.freeze({ semantic, screen, screenManifest: manifest.payload });
}
