import { join } from "node:path";
import type { NativeSessionReference } from "@nanasa/contracts";
import { HOOK_STATUS_REPORTER_SOURCE } from "../status-reporter-assets.js";
import { json, normalizeSessionReference, unsupportedSessionMutation } from "./adapter-support.js";
import { freezeControlStrategy } from "./provider-control-strategy.js";
import type {
  NativeSessionReport,
  ProviderAdapter,
  ProviderOverlayContext,
  ProviderOverlayPlan,
} from "./provider-adapter.js";
import { freezeReporterDescriptor } from "./provider-reporter-descriptor.js";

export class ClaudeCodeAdapter implements ProviderAdapter {
  public readonly id = "claude-code" as const;
  public readonly version = "1.0.0";
  public readonly supportedVersions = Object.freeze([">=0.0.0"]);
  public readonly reporter = freezeReporterDescriptor({
    id: "claude-hooks",
    version: "1",
    source: "claude-code",
    readinessEvents: ["session.ready"],
    coverage: {
      session: true,
      turns: true,
      tools: true,
      waits: true,
      effectiveModel: true,
      heartbeat: false,
    },
  });
  public readonly control = freezeControlStrategy({
    waitReplyChannels: ["terminal", "hook"],
    supportsPromptAcknowledgement: false,
    supportsCancellation: true,
    terminalSubmitSequence: "\r",
  });

  public recognizeCommand(command: readonly string[]): boolean {
    return (
      command.some((part) => /(?:^|[/\\])claude(?:\.exe)?$/.test(part)) ||
      (command[0] === "make" && command[1] === "claude-copilot")
    );
  }
  public stateEnvironment(stateRoot: string): Readonly<Record<string, string>> {
    return Object.freeze({ CLAUDE_CONFIG_DIR: stateRoot });
  }
  public modelArguments(model: string): readonly string[] {
    return Object.freeze(["--model", model]);
  }
  public planOverlay(context: ProviderOverlayContext): ProviderOverlayPlan {
    const reporterPath = join(context.overlayRoot, "reporters", "status-hook.mjs");
    const settingsPath = join(context.overlayRoot, "settings.json");
    const commandArguments = ["--settings", settingsPath];
    const event = (name: string, matcher?: string) => ({
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [
        {
          type: "command",
          command: process.execPath,
          args: [reporterPath, "claude-code", name],
          timeout: 2,
        },
      ],
    });
    const files: ProviderOverlayPlan["files"][number][] = [
      {
        relativePath: "reporters/status-hook.mjs",
        content: HOOK_STATUS_REPORTER_SOURCE,
        ownerKind: "reporter",
      },
      {
        relativePath: "settings.json",
        content: json({
          hooks: {
            SessionStart: [event("SessionStart")],
            UserPromptSubmit: [event("UserPromptSubmit")],
            PreToolUse: [event("PreToolUse", "*")],
            PermissionRequest: [event("PermissionRequest", "*")],
            PostToolUse: [event("PostToolUse", "*")],
            PostToolUseFailure: [event("PostToolUseFailure", "*")],
            Stop: [event("Stop")],
            StopFailure: [event("StopFailure")],
            PreCompact: [event("PreCompact")],
            PostCompact: [event("PostCompact")],
            Elicitation: [event("Elicitation")],
            ElicitationResult: [event("ElicitationResult")],
            SessionEnd: [event("SessionEnd")],
          },
          ...(context.readOnly ? { permissions: { deny: ["Edit", "Write", "Bash"] } } : {}),
        }),
        ownerKind: context.readOnly ? "deny-floor" : "reporter",
      },
    ];
    if (context.mcpEndpointUrl !== undefined) {
      const mcpPath = join(context.overlayRoot, "mcp.json");
      files.push({
        relativePath: "mcp.json",
        content: json({
          mcpServers: {
            nanasa: {
              type: "http",
              url: context.mcpEndpointUrl,
              headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
            },
          },
        }),
        ownerKind: "mcp",
      });
      commandArguments.push("--mcp-config", mcpPath);
    }
    if (context.prompt !== undefined) {
      const promptPath = join(context.overlayRoot, "prompts", "system.md");
      files.push({
        relativePath: "prompts/system.md",
        content: context.prompt.text,
        ownerKind: "prompt",
      });
      commandArguments.push("--append-system-prompt-file", promptPath);
    }
    return Object.freeze({
      files: Object.freeze(files),
      commandArguments: Object.freeze(commandArguments),
      environment: Object.freeze({}),
      generatedIdentities: Object.freeze(files.map((file) => file.relativePath)),
    });
  }
  public normalizeNativeSession(
    report: NativeSessionReport,
    stateRoot: string,
  ): NativeSessionReference {
    if (report.referenceKind !== "id") throw new Error("Claude Code sessions require an ID");
    return normalizeSessionReference(this.id, report, stateRoot);
  }
  public resumeArguments(reference: NativeSessionReference, model?: string): readonly string[] {
    const result = ["--resume", reference.referenceValue];
    if (model !== undefined) result.push(...this.modelArguments(model));
    return Object.freeze(result);
  }
  public credentialEnvironmentNames(): readonly string[] {
    return Object.freeze([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ]);
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
