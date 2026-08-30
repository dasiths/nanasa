import { join } from "node:path";
import type { NativeSessionReference } from "@nanasa/contracts";
import { HOOK_STATUS_REPORTER_SOURCE } from "../status-reporter-assets.js";
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

export class CopilotAdapter implements ProviderAdapter {
  public readonly id = "copilot" as const;
  public readonly version = "1.0.0";
  public readonly supportedVersions = Object.freeze([">=0.0.0"]);
  public readonly reporter = freezeReporterDescriptor({
    id: "copilot-hooks",
    version: "2",
    source: "copilot",
    readinessEvents: ["session.ready"],
    coverage: {
      session: true,
      turns: true,
      tools: true,
      waits: true,
      effectiveModel: false,
      heartbeat: false,
    },
  });
  public readonly control = freezeControlStrategy({
    waitReplyChannels: ["terminal"],
    supportsPromptAcknowledgement: false,
    supportsCancellation: true,
    terminalSubmitSequence: "\u001b[I\r",
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
    return command.some((part) => /(?:^|[/\\])copilot(?:\.exe)?$/.test(part));
  }

  public stateEnvironment(stateRoot: string): Readonly<Record<string, string>> {
    return Object.freeze({ COPILOT_HOME: stateRoot, COPILOT_CACHE_HOME: join(stateRoot, "cache") });
  }

  public modelArguments(model: string): readonly string[] {
    return Object.freeze(["--model", model]);
  }

  public planOverlay(context: ProviderOverlayContext): ProviderOverlayPlan {
    const reporterPath = join(context.overlayRoot, "reporters", "status-hook.mjs");
    const hookConfigPath = join(context.overlayRoot, "reporters", "hooks.json");
    const commandArguments: string[] = [];
    const files: ProviderOverlayPlan["files"][number][] = [
      {
        relativePath: "reporters/status-hook.mjs",
        content: HOOK_STATUS_REPORTER_SOURCE,
        ownerKind: "reporter",
      },
      {
        relativePath: "reporters/hooks.json",
        content: json({
          version: 1,
          hooks: {
            sessionStart: [this.#hook(reporterPath, "sessionStart")],
            userPromptSubmitted: [this.#hook(reporterPath, "userPromptSubmitted")],
            preToolUse: [this.#hook(reporterPath, "preToolUse", ".*")],
            permissionRequest: [this.#hook(reporterPath, "permissionRequest", ".*")],
            postToolUse: [this.#hook(reporterPath, "postToolUse", ".*")],
            postToolUseFailure: [this.#hook(reporterPath, "postToolUseFailure", ".*")],
            agentStop: [this.#hook(reporterPath, "agentStop")],
            errorOccurred: [this.#hook(reporterPath, "errorOccurred")],
            preCompact: [this.#hook(reporterPath, "preCompact")],
            sessionEnd: [this.#hook(reporterPath, "sessionEnd")],
          },
        }),
        ownerKind: "reporter",
      },
    ];
    if (context.mcpEndpointUrl !== undefined) {
      const mcpPath = join(context.overlayRoot, "mcp", "config.json");
      files.push({
        relativePath: "mcp/config.json",
        content: json({
          mcpServers: {
            nanasa: {
              type: "http",
              url: context.mcpEndpointUrl,
              headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
              tools: ["*"],
            },
          },
        }),
        ownerKind: "mcp",
      });
      commandArguments.push("--additional-mcp-config", `@${mcpPath}`);
    }
    if (context.prompt !== undefined) {
      const name = generatedAgentName(context.membershipId);
      files.push({
        relativePath: `prompts/${name}.agent.md`,
        content: `---\nname: ${JSON.stringify(`Nanasa ${context.memberAlias}`)}\ndescription: ${JSON.stringify(`Nanasa-managed ${context.prompt.role?.name ?? "agent"}`)}\ninfer: false\n---\n\n${context.prompt.text}`,
        ownerKind: "prompt",
      });
      commandArguments.push("--agent", name);
    }
    if (context.readOnly) commandArguments.push("--deny-tool=write", "--deny-tool=shell");
    return Object.freeze({
      files: Object.freeze(files),
      commandArguments: Object.freeze(commandArguments),
      environment: Object.freeze({ NANASA_COPILOT_HOOKS_CONFIG: hookConfigPath }),
      generatedIdentities: Object.freeze(files.map((file) => file.relativePath)),
    });
  }

  public normalizeNativeSession(
    report: NativeSessionReport,
    stateRoot: string,
  ): NativeSessionReference {
    if (report.referenceKind !== "id") throw new Error("Copilot sessions require an ID");
    return normalizeSessionReference(this.id, report, stateRoot);
  }

  public resumeArguments(reference: NativeSessionReference, model?: string): readonly string[] {
    const result = [`--resume=${reference.referenceValue}`];
    if (model !== undefined) result.push(...this.modelArguments(model));
    return Object.freeze(result);
  }

  public credentialEnvironmentNames(): readonly string[] {
    return Object.freeze(["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]);
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

  #hook(reporterPath: string, eventName: string, matcher?: string): Record<string, unknown> {
    return {
      type: "command",
      ...(matcher === undefined ? {} : { matcher }),
      bash: `${JSON.stringify(process.execPath)} ${JSON.stringify(reporterPath)} copilot ${JSON.stringify(eventName)}`,
      timeoutSec: 2,
    };
  }
}
