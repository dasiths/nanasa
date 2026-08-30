import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeSessionReference } from "@nanasa/contracts";
import { PI_STATUS_REPORTER_SOURCE } from "../status-reporter-assets.js";
import { json, normalizeSessionReference, unsupportedSessionMutation } from "./adapter-support.js";
import type {
  NativeSessionReport,
  ProviderAdapter,
  ProviderOverlayContext,
  ProviderOverlayPlan,
} from "./provider-adapter.js";
import { freezeProviderSemanticClaims } from "./provider-adapter.js";
import {
  closedTerminalWaitReplyInput,
  freezeControlStrategy,
} from "./provider-control-strategy.js";
import { freezeReporterDescriptor } from "./provider-reporter-descriptor.js";

const READ_ONLY_SOURCE = `export default function (pi) {\n  const blocked = new Set(["bash", "edit", "write"]);\n  pi.on("tool_call", (event) => {\n    if (blocked.has(event.toolName)) return { block: true, reason: "The active Nanasa role is read-only", terminate: true };\n  });\n}\n`;

export class PiAdapter implements ProviderAdapter {
  public readonly id = "pi" as const;
  public readonly version = "1.0.0";
  public readonly supportedVersions = Object.freeze([">=0.0.0"]);
  public readonly reporter = freezeReporterDescriptor({
    id: "pi-extension",
    version: "2",
    source: "pi",
    readinessEvents: ["session.ready"],
    coverage: {
      session: true,
      turns: true,
      tools: true,
      waits: false,
      effectiveModel: false,
      heartbeat: true,
    },
  });
  public readonly control = freezeControlStrategy({
    waitReplyChannels: ["terminal"],
    supportsPromptAcknowledgement: false,
    supportsCancellation: true,
    terminalSubmitSequence: "\r",
    waitReplyInput: closedTerminalWaitReplyInput,
  });
  public readonly semantics = freezeProviderSemanticClaims(
    {
      reporterReadiness: true,
      modelObservation: "desired-launch",
      waitCoverage: false,
      waitReplyChannels: [],
      nativeResume: true,
    },
    this.reporter,
    this.control,
  );
  readonly #mcpAdapterPath: string;

  public constructor(mcpAdapterPath = fileURLToPath(import.meta.resolve("pi-mcp-adapter"))) {
    this.#mcpAdapterPath = mcpAdapterPath;
  }
  public recognizeCommand(command: readonly string[]): boolean {
    return command.some((part) => /(?:^|[/\\])pi(?:\.exe)?$/.test(part));
  }
  public stateEnvironment(stateRoot: string): Readonly<Record<string, string>> {
    return Object.freeze({ PI_CODING_AGENT_DIR: stateRoot });
  }
  public modelArguments(model: string): readonly string[] {
    return Object.freeze(["--model", model]);
  }
  public planOverlay(context: ProviderOverlayContext): ProviderOverlayPlan {
    const reporterPath = join(context.overlayRoot, "extensions", "status.mjs");
    const commandArguments = ["--extension", reporterPath];
    const files: ProviderOverlayPlan["files"][number][] = [
      {
        relativePath: "extensions/status.mjs",
        content: PI_STATUS_REPORTER_SOURCE,
        ownerKind: "reporter",
      },
    ];
    const environment: Record<string, string> = {};
    if (context.mcpEndpointUrl !== undefined) {
      const mcpPath = join(context.overlayRoot, "mcp.json");
      files.push({
        relativePath: "mcp.json",
        content: json({
          settings: { directTools: true, hostConfigDiscovery: "off" },
          mcpServers: {
            nanasa: {
              url: context.mcpEndpointUrl,
              headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
              protocolVersion: "auto",
              lifecycle: "eager",
            },
          },
        }),
        ownerKind: "mcp",
      });
      commandArguments.push("--extension", this.#mcpAdapterPath);
      environment.NANASA_PI_MCP_CONFIG = mcpPath;
    }
    if (context.prompt !== undefined) {
      const promptPath = join(context.overlayRoot, "prompts", "system.md");
      files.push({
        relativePath: "prompts/system.md",
        content: context.prompt.text,
        ownerKind: "prompt",
      });
      commandArguments.push("--append-system-prompt", promptPath);
    }
    if (context.readOnly) {
      const policyPath = join(context.overlayRoot, "extensions", "read-only.mjs");
      files.push({
        relativePath: "extensions/read-only.mjs",
        content: READ_ONLY_SOURCE,
        ownerKind: "deny-floor",
      });
      commandArguments.push("--extension", policyPath);
    }
    return Object.freeze({
      files: Object.freeze(files),
      commandArguments: Object.freeze(commandArguments),
      environment: Object.freeze(environment),
      generatedIdentities: Object.freeze(files.map((file) => file.relativePath)),
    });
  }
  public normalizeNativeSession(
    report: NativeSessionReport,
    stateRoot: string,
  ): NativeSessionReference {
    return normalizeSessionReference(this.id, report, stateRoot);
  }
  public resumeArguments(reference: NativeSessionReference, model?: string): readonly string[] {
    const result = ["--session", reference.referenceValue];
    if (model !== undefined) result.push(...this.modelArguments(model));
    return Object.freeze(result);
  }
  public credentialEnvironmentNames(): readonly string[] {
    return Object.freeze(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]);
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
