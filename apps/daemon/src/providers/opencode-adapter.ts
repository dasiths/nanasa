import { join } from "node:path";
import type { NativeSessionReference } from "@nanasa/contracts";
import { OPENCODE_STATUS_REPORTER_SOURCE } from "../status-reporter-assets.js";
import {
  generatedAgentName,
  json,
  normalizeSessionReference,
  unsupportedSessionMutation,
} from "./adapter-support.js";
import {
  closedTerminalWaitReplyInput,
  freezeControlStrategy,
} from "./provider-control-strategy.js";
import type {
  NativeSessionReport,
  ProviderAdapter,
  ProviderOverlayContext,
  ProviderOverlayPlan,
} from "./provider-adapter.js";
import { freezeProviderSemanticClaims } from "./provider-adapter.js";
import { freezeReporterDescriptor } from "./provider-reporter-descriptor.js";

export class OpenCodeAdapter implements ProviderAdapter {
  public readonly id = "opencode" as const;
  public readonly version = "1.0.0";
  public readonly supportedVersions = Object.freeze([">=0.0.0"]);
  public readonly reporter = freezeReporterDescriptor({
    id: "opencode-plugin",
    version: "2",
    source: "opencode",
    readinessEvents: ["session.ready"],
    coverage: {
      session: true,
      turns: true,
      tools: true,
      waits: true,
      effectiveModel: false,
      heartbeat: true,
    },
  });
  public readonly control = freezeControlStrategy({
    waitReplyChannels: ["terminal", "api"],
    supportsPromptAcknowledgement: false,
    supportsCancellation: true,
    terminalSubmitSequence: "\r",
    waitReplyInput: closedTerminalWaitReplyInput,
  });
  public readonly semantics = freezeProviderSemanticClaims(
    {
      reporterReadiness: true,
      modelObservation: "desired-launch",
      waitCoverage: true,
      waitReplyChannels: ["terminal"],
      nativeResume: true,
    },
    this.reporter,
    this.control,
  );
  public recognizeCommand(command: readonly string[]): boolean {
    return command.some((part) => /(?:^|[/\\])opencode(?:\.exe)?$/.test(part));
  }
  public stateEnvironment(stateRoot: string): Readonly<Record<string, string>> {
    return Object.freeze({
      XDG_CONFIG_HOME: join(stateRoot, "xdg-config"),
      XDG_DATA_HOME: join(stateRoot, "xdg-data"),
      XDG_STATE_HOME: join(stateRoot, "xdg-state"),
      XDG_CACHE_HOME: join(stateRoot, "xdg-cache"),
    });
  }
  public modelArguments(model: string): readonly string[] {
    return Object.freeze(["--model", model]);
  }
  public planOverlay(context: ProviderOverlayContext): ProviderOverlayPlan {
    const files: ProviderOverlayPlan["files"][number][] = [
      {
        relativePath: "plugins/nanasa-status.mjs",
        content: OPENCODE_STATUS_REPORTER_SOURCE,
        ownerKind: "reporter",
      },
    ];
    const generatedAgent =
      context.prompt === undefined ? undefined : generatedAgentName(context.membershipId);
    if (context.prompt !== undefined && generatedAgent !== undefined) {
      files.push({
        relativePath: "prompts/system.md",
        content: context.prompt.text,
        ownerKind: "prompt",
      });
    }
    const managed = {
      ...(context.mcpEndpointUrl === undefined
        ? {}
        : {
            mcp: {
              nanasa: {
                type: "remote",
                url: context.mcpEndpointUrl,
                enabled: true,
                oauth: false,
                headers: { Authorization: "Bearer {env:NANASA_MCP_TOKEN}" },
              },
            },
          }),
      ...(generatedAgent === undefined
        ? {}
        : {
            agent: {
              [generatedAgent]: {
                description: `Nanasa-managed ${context.prompt?.role?.name ?? "agent"}`,
                mode: "primary",
                prompt: `{file:${join(context.overlayRoot, "prompts", "system.md")}}`,
                ...(context.readOnly ? { permission: { edit: "deny", bash: "deny" } } : {}),
              },
            },
          }),
    };
    files.push({
      relativePath: "managed-config.json",
      content: json(managed),
      ownerKind: context.readOnly ? "deny-floor" : "manifest",
    });
    return Object.freeze({
      files: Object.freeze(files),
      commandArguments: Object.freeze(
        generatedAgent === undefined ? [] : ["--agent", generatedAgent],
      ),
      environment: Object.freeze({
        OPENCODE_CONFIG_CONTENT: JSON.stringify(managed),
        OPENCODE_CONFIG_DIR: context.overlayRoot,
      }),
      generatedIdentities: Object.freeze(files.map((file) => file.relativePath)),
    });
  }
  public normalizeNativeSession(
    report: NativeSessionReport,
    stateRoot: string,
  ): NativeSessionReference {
    if (report.referenceKind !== "id") throw new Error("OpenCode sessions require an ID");
    return normalizeSessionReference(this.id, report, stateRoot);
  }
  public resumeArguments(reference: NativeSessionReference, model?: string): readonly string[] {
    const result = ["--session", reference.referenceValue];
    if (model !== undefined) result.push(...this.modelArguments(model));
    return Object.freeze(result);
  }
  public credentialEnvironmentNames(): readonly string[] {
    return Object.freeze(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]);
  }
  public credentialHealth(
    environment: Readonly<Record<string, string>>,
  ): "available" | "provider-managed" {
    return this.credentialEnvironmentNames().some((name) => Boolean(environment[name]))
      ? "available"
      : "provider-managed";
  }
  public exportSession = unsupportedSessionMutation;
  public deleteSession = unsupportedSessionMutation;
}
