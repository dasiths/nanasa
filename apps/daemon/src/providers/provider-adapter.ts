import type {
  AgentKind,
  AgentProfile,
  CredentialProfileReference,
  ModelResumePolicy,
  NativeSessionReference,
} from "@nanasa/contracts";
import type { EffectiveAgentPrompt } from "../instruction-resolver.js";
import type { ProviderControlStrategy } from "./provider-control-strategy.js";
import type { ProviderReporterDescriptor } from "./provider-reporter-descriptor.js";

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

export interface ProviderRunSnapshot {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profile: Readonly<AgentProfile>;
  readonly stateRoot: string;
  readonly overlayRoot: string;
  readonly configuredCommand: readonly string[];
  readonly overlayArguments: readonly string[];
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly desiredModel?: string;
  readonly desiredModelSource: "membership" | "integration" | "provider-default";
  readonly modelResumePolicy: ModelResumePolicy;
  readonly credentialReference: Readonly<CredentialProfileReference>;
  readonly overlayRevision: number;
  readonly launchManifestDigest: string;
}

export interface NativeSessionReport {
  readonly source: string;
  readonly referenceKind: "id" | "path";
  readonly referenceValue: string;
  readonly effectiveModel?: string;
}

export interface ProviderAdapter {
  readonly id: AgentKind;
  readonly version: string;
  readonly supportedVersions: readonly string[];
  readonly reporter: ProviderReporterDescriptor;
  readonly control: ProviderControlStrategy;
  recognizeCommand(command: readonly string[]): boolean;
  stateEnvironment(stateRoot: string): Readonly<Record<string, string>>;
  modelArguments(model: string): readonly string[];
  planOverlay(context: ProviderOverlayContext): ProviderOverlayPlan;
  normalizeNativeSession(report: NativeSessionReport, stateRoot: string): NativeSessionReference;
  resumeArguments(reference: NativeSessionReference, model?: string): readonly string[];
  credentialEnvironmentNames(): readonly string[];
  credentialHealth(environment: Readonly<Record<string, string>>): "available" | "provider-managed";
  exportSession(reference: NativeSessionReference, destination: string): Promise<boolean>;
  deleteSession(reference: NativeSessionReference): Promise<boolean>;
}

export function freezeRunSnapshot(snapshot: ProviderRunSnapshot): ProviderRunSnapshot {
  return Object.freeze({
    ...snapshot,
    profile: Object.freeze({
      ...snapshot.profile,
      args: Object.freeze([...snapshot.profile.args]),
      environment: Object.freeze({ ...snapshot.profile.environment }),
    }),
    configuredCommand: Object.freeze([...snapshot.configuredCommand]),
    overlayArguments: Object.freeze([...snapshot.overlayArguments]),
    command: Object.freeze([...snapshot.command]),
    environment: Object.freeze({ ...snapshot.environment }),
    credentialReference: Object.freeze({ ...snapshot.credentialReference }),
  }) as unknown as ProviderRunSnapshot;
}

export function appendProviderArguments(
  command: readonly string[],
  providerArguments: readonly string[],
): string[] {
  if (command[0] === "make" && command[1] === "claude-copilot") {
    return [...command, `CLAUDE_ARGS=${providerArguments.map(shellQuote).join(" ")}`];
  }
  return [...command, ...providerArguments];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
