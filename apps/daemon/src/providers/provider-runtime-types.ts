import type { EffectiveAgentPrompt } from "../instruction-resolver.js";

export interface GeneratedOverlayFile {
  readonly relativePath: string;
  readonly content: string;
  readonly mode?: number;
  readonly ownerKind: "reporter" | "prompt" | "mcp" | "deny-floor" | "manifest";
}

export interface ProviderOverlayContext {
  readonly membershipId: string;
  readonly memberAlias: string;
  readonly stateRoot: string;
  readonly overlayRoot: string;
  readonly mcpEndpointUrl?: string;
  readonly statusEndpointUrl: string;
  readonly prompt?: EffectiveAgentPrompt;
  readonly readOnly: boolean;
}

export interface ProviderOverlayPlan {
  readonly files: readonly GeneratedOverlayFile[];
  readonly commandArguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly generatedIdentities: readonly string[];
}
