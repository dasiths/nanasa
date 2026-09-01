import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { OpenWaitReply } from "@nanasa/contracts";
import type { EffectiveAgentPrompt } from "../instruction-resolver.js";
import type {
  GeneratedOverlayFile,
  ProviderOverlayContext,
  ProviderOverlayPlan,
} from "./provider-adapter.js";
import type { ProviderReporterDriverRegistry } from "./provider-reporter-driver-registry.js";
import type { ResolvedProviderAdapter } from "./resolved-provider-adapter.js";

interface Matcher {
  readonly executableNames: readonly string[];
  readonly requiredArgvLiterals: readonly string[];
  readonly wrapperExecutableNames: readonly string[];
}

interface FileRecipe {
  readonly recipeId: string;
  readonly relativePath: string;
  readonly mode: "private-file" | "private-directory";
  readonly assetDigest?: string;
}

export interface SnapshotLaunchInput extends ProviderOverlayContext {
  readonly configuredCommand: readonly string[];
  readonly model?: string;
  readonly nativeSession?: SnapshotNativeSession;
  readonly enforceConfiguredModelOnResume?: boolean;
}

export interface SnapshotLaunchPlan {
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly overlay: ProviderOverlayPlan;
}

export interface SnapshotNativeSession {
  readonly providerId: string;
  readonly source: string;
  readonly referenceKind: "id" | "state-contained-path";
  readonly referenceValue: string;
  readonly dedupeDigest: string;
}

export interface SnapshotControlPolicy {
  readonly waitReplyChannels: readonly string[];
  readonly supportsPromptAcknowledgement: boolean;
  readonly supportsCancellation: boolean;
  readonly terminalSubmitSequence: string;
  readonly operations: readonly unknown[];
}

export interface ProviderSnapshotEvaluatorOptions {
  readonly nodeExecutable?: string;
  readonly runtimeAssetPaths?: Readonly<Record<string, string>>;
}

function capability<T>(adapter: ResolvedProviderAdapter, id: string): T {
  const selected = adapter.body.capabilities.find((item) => item.id === id);
  if (selected === undefined) throw new Error(`Provider capability is unavailable: ${id}`);
  return selected.payload as T;
}

function executableName(value: string): string {
  return basename(value.replaceAll("\\", "/"));
}

function matches(
  command: readonly string[],
  executable: string | undefined,
  matcher: Matcher,
): boolean {
  const names = new Set(matcher.executableNames);
  const executableMatches =
    (executable !== undefined && names.has(executableName(executable))) ||
    command.some((part) => names.has(executableName(part)));
  if (!executableMatches) return false;
  if (matcher.requiredArgvLiterals.some((literal) => !command.includes(literal))) return false;
  return (
    matcher.wrapperExecutableNames.length === 0 ||
    matcher.wrapperExecutableNames.includes(executableName(command[0] ?? ""))
  );
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function generatedAgentName(membershipId: string): string {
  return `nanasa-${createHash("sha256").update(membershipId).digest("hex").slice(0, 16)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertLoopbackEndpoint(value: string): void {
  const endpoint = new URL(value);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname)
  ) {
    throw new Error("MCP endpoint must use HTTP on loopback");
  }
}

export class ProviderSnapshotEvaluator {
  readonly #adapter: ResolvedProviderAdapter;
  readonly #reporters: ProviderReporterDriverRegistry;
  readonly #nodeExecutable: string;
  readonly #runtimeAssetPaths: Readonly<Record<string, string>>;

  public constructor(
    adapter: ResolvedProviderAdapter,
    reporters: ProviderReporterDriverRegistry,
    options: ProviderSnapshotEvaluatorOptions = {},
  ) {
    this.#adapter = adapter;
    this.#reporters = reporters;
    this.#nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.#runtimeAssetPaths = Object.freeze({ ...options.runtimeAssetPaths });
  }

  public matchesConfiguredCommand(command: readonly string[]): boolean {
    const recognition = capability<{ configuredCommandMatchers: Matcher[] }>(
      this.#adapter,
      "recognition",
    );
    return recognition.configuredCommandMatchers.some((matcher) =>
      matches(command, undefined, matcher),
    );
  }

  public matchesObservedProcess(argv: readonly string[], executable?: string): boolean {
    const recognition = capability<{ observedProcessMatchers: Matcher[] }>(
      this.#adapter,
      "recognition",
    );
    return recognition.observedProcessMatchers.some((matcher) =>
      matches(argv, executable, matcher),
    );
  }

  public augmentConfiguredCommand(
    command: readonly string[],
    providerArguments: readonly string[],
  ): readonly string[] {
    if (!this.matchesConfiguredCommand(command)) {
      throw new Error("Configured command is not eligible for provider augmentation");
    }
    const recognition = capability<{ configuredCommandMatchers: Matcher[] }>(
      this.#adapter,
      "recognition",
    );
    const matched = recognition.configuredCommandMatchers.find((matcher) =>
      matches(command, undefined, matcher),
    );
    const launch = capability<{
      wrapperArgumentSlot?: number;
      wrapperArgumentPrefix?: string;
    }>(this.#adapter, "launch");
    if (
      matched?.wrapperExecutableNames.length !== 0 &&
      launch.wrapperArgumentSlot !== undefined &&
      launch.wrapperArgumentPrefix !== undefined
    ) {
      if (launch.wrapperArgumentSlot > command.length) {
        throw new Error("Configured wrapper argument slot is outside the command");
      }
      const result = [...command];
      result.splice(
        launch.wrapperArgumentSlot,
        0,
        `${launch.wrapperArgumentPrefix}${providerArguments.map((argument) => shellQuote(argument)).join(" ")}`,
      );
      return Object.freeze(result);
    }
    if (matched?.wrapperExecutableNames.length !== 0) {
      throw new Error("Configured wrapper has no declarative argument slot");
    }
    if (launch.wrapperArgumentSlot === undefined) {
      return Object.freeze([...command, ...providerArguments]);
    }
    return Object.freeze([...command, ...providerArguments]);
  }

  public stateEnvironment(stateRoot: string): Readonly<Record<string, string>> {
    const state = capability<{
      environmentNames: string[];
      environmentPaths: Record<string, string>;
    }>(this.#adapter, "state");
    return Object.freeze(
      Object.fromEntries(
        state.environmentNames.map((name) => {
          const template = state.environmentPaths[name];
          if (template === undefined) throw new Error("State environment mapping is incomplete");
          return [name, template.replace("{stateRoot}", stateRoot)];
        }),
      ),
    );
  }

  public planOverlay(context: ProviderOverlayContext): ProviderOverlayPlan {
    const launch = capability<{ files: FileRecipe[] }>(this.#adapter, "launch");
    const reporter = capability<{ driverId: string; sourceId: string }>(this.#adapter, "reporter");
    const promptPolicy = capability<{ maximumBytes: number; readOnlyFloor: string[] }>(
      this.#adapter,
      "prompt",
    );
    const files: GeneratedOverlayFile[] = [];
    const commandArguments: string[] = [];
    const environment: Record<string, string> = {};
    const generatedIdentities: string[] = [];
    const generatedName = generatedAgentName(context.membershipId);
    const providerId = this.#adapter.body.providerId;
    const copilotReporterPath = join(
      context.overlayRoot,
      "copilot-status-plugin",
      "status-hook.mjs",
    );
    const openCodeManaged = {
      plugin: [join(context.overlayRoot, "plugins", "nanasa-status.js")],
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
      ...(context.prompt === undefined
        ? {}
        : {
            agent: {
              [generatedName]: {
                description: `Nanasa-managed ${context.prompt.role?.name ?? "agent"}`,
                mode: "primary",
                prompt: `{file:${join(context.overlayRoot, "prompts", "system.md")}}`,
                ...(context.readOnly ? { permission: { edit: "deny", bash: "deny" } } : {}),
              },
            },
          }),
    };

    for (const recipe of launch.files) {
      if (recipe.assetDigest === undefined)
        throw new Error(`File recipe ${recipe.recipeId} has no asset`);
      const asset = this.#adapter.assets.get(recipe.assetDigest);
      const relativePath = recipe.relativePath.replace("{generatedAgentName}", generatedName);
      let content: string | undefined;
      let ownerKind: GeneratedOverlayFile["ownerKind"];
      switch (recipe.recipeId) {
        case "copilot.reporter.source":
          content = this.#reporters.source(reporter.driverId);
          ownerKind = "reporter";
          break;
        case "claude.reporter.source":
        case "pi.reporter.source":
        case "opencode.reporter.source":
        case "opencode.tui.source":
        case "pi.read-only.source":
          if (asset.kind !== "literal") throw new Error(`${recipe.recipeId} asset kind mismatch`);
          content = this.#adapter.assets.get(recipe.assetDigest).payload as string;
          ownerKind = recipe.recipeId === "pi.read-only.source" ? "deny-floor" : "reporter";
          if (recipe.recipeId === "pi.read-only.source" && !context.readOnly) continue;
          break;
        case "copilot.reporter.plugin":
          if (asset.kind !== "copilot-plugin-manifest")
            throw new Error("Copilot plugin asset kind mismatch");
          content = json(asset.payload);
          ownerKind = "reporter";
          break;
        case "copilot.reporter.hooks": {
          if (asset.kind !== "copilot-hooks-manifest")
            throw new Error("Copilot hooks asset kind mismatch");
          const payload = asset.payload as {
            version: number;
            hooks: Array<{ hook: string; event: string; matcher?: string }>;
          };
          const hooks: Record<string, unknown[]> = {};
          for (const hook of payload.hooks) {
            hooks[hook.hook] = [
              {
                type: "command",
                ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
                bash: `${shellQuote(this.#nodeExecutable)} ${shellQuote(copilotReporterPath)} ${reporter.sourceId} ${shellQuote(hook.event)}`,
                timeoutSec: 2,
              },
            ];
          }
          content = json({ version: payload.version, hooks });
          ownerKind = "reporter";
          break;
        }
        case "copilot.mcp.config":
          if (context.mcpEndpointUrl === undefined) continue;
          if (asset.kind !== "copilot-mcp-config")
            throw new Error("Copilot MCP asset kind mismatch");
          assertLoopbackEndpoint(context.mcpEndpointUrl);
          content = json({
            mcpServers: {
              nanasa: {
                type: "http",
                url: context.mcpEndpointUrl,
                headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
                tools: ["*"],
              },
            },
          });
          ownerKind = "mcp";
          break;
        case "copilot.prompt.agent":
          if (context.prompt === undefined) continue;
          if (asset.kind !== "copilot-prompt")
            throw new Error("Copilot prompt asset kind mismatch");
          if (Buffer.byteLength(context.prompt.text, "utf8") > promptPolicy.maximumBytes) {
            throw new Error("Effective provider prompt exceeds its snapshot limit");
          }
          content = this.#renderPrompt(context.prompt, context.memberAlias);
          ownerKind = "prompt";
          break;
        case "claude.settings": {
          if (asset.kind !== "claude-hooks-manifest")
            throw new Error("Claude hooks asset kind mismatch");
          const reporterPath = join(context.overlayRoot, "reporters", "status-hook.mjs");
          const payload = asset.payload as {
            hooks: Array<{ hook: string; event: string; matcher?: string }>;
          };
          const hooks: Record<string, unknown[]> = {};
          for (const hook of payload.hooks) {
            hooks[hook.hook] = [
              {
                ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
                hooks: [
                  {
                    type: "command",
                    command: this.#nodeExecutable,
                    args: [reporterPath, reporter.sourceId, hook.event],
                    timeout: 2,
                  },
                ],
              },
            ];
          }
          content = json({
            hooks,
            ...(context.readOnly ? { permissions: { deny: promptPolicy.readOnlyFloor } } : {}),
          });
          ownerKind = context.readOnly ? "deny-floor" : "reporter";
          break;
        }
        case "claude.mcp.config":
          if (context.mcpEndpointUrl === undefined) continue;
          if (asset.kind !== "claude-mcp-config") throw new Error("Claude MCP asset kind mismatch");
          assertLoopbackEndpoint(context.mcpEndpointUrl);
          content = json({
            mcpServers: {
              nanasa: {
                type: "http",
                url: context.mcpEndpointUrl,
                headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
              },
            },
          });
          ownerKind = "mcp";
          break;
        case "claude.prompt.system":
        case "pi.prompt.system":
        case "opencode.prompt.system":
          if (context.prompt === undefined) continue;
          if (asset.kind !== "plain-prompt") throw new Error("Prompt asset kind mismatch");
          if (Buffer.byteLength(context.prompt.text, "utf8") > promptPolicy.maximumBytes) {
            throw new Error("Effective provider prompt exceeds its snapshot limit");
          }
          content = context.prompt.text;
          ownerKind = "prompt";
          break;
        case "pi.mcp.config":
          if (context.mcpEndpointUrl === undefined) continue;
          if (asset.kind !== "pi-mcp-config") throw new Error("Pi MCP asset kind mismatch");
          assertLoopbackEndpoint(context.mcpEndpointUrl);
          content = json({
            settings: { directTools: true, hostConfigDiscovery: "off" },
            mcpServers: {
              nanasa: {
                url: context.mcpEndpointUrl,
                headers: { Authorization: "Bearer ${NANASA_MCP_TOKEN}" },
                protocolVersion: "auto",
                lifecycle: "lazy",
              },
            },
          });
          ownerKind = "mcp";
          break;
        case "opencode.tui.config":
          if (asset.kind !== "opencode-tui-config")
            throw new Error("OpenCode TUI config asset kind mismatch");
          content = json(asset.payload);
          ownerKind = "reporter";
          break;
        case "opencode.managed.config":
          if (asset.kind !== "opencode-managed-config")
            throw new Error("OpenCode managed config asset kind mismatch");
          content = json(openCodeManaged);
          ownerKind = context.readOnly ? "deny-floor" : "manifest";
          break;
        default:
          throw new Error(`Unsupported provider file recipe ${recipe.recipeId}`);
      }
      files.push({ relativePath, content, ownerKind });
      generatedIdentities.push(relativePath);
    }

    switch (providerId) {
      case "copilot":
        commandArguments.push("--plugin-dir", join(context.overlayRoot, "copilot-status-plugin"));
        if (context.mcpEndpointUrl !== undefined) {
          commandArguments.push(
            "--additional-mcp-config",
            `@${join(context.overlayRoot, "mcp", "config.json")}`,
          );
        }
        if (context.prompt !== undefined) {
          commandArguments.push("--agent", `nanasa-status-reporter:${generatedName}`);
        }
        if (context.readOnly) {
          commandArguments.push(...promptPolicy.readOnlyFloor.map((tool) => `--deny-tool=${tool}`));
        }
        break;
      case "claude-code":
        commandArguments.push("--settings", join(context.overlayRoot, "settings.json"));
        if (context.mcpEndpointUrl !== undefined) {
          commandArguments.push("--mcp-config", join(context.overlayRoot, "mcp.json"));
        }
        if (context.prompt !== undefined) {
          commandArguments.push(
            "--append-system-prompt-file",
            join(context.overlayRoot, "prompts", "system.md"),
          );
        }
        break;
      case "pi": {
        commandArguments.push("--extension", join(context.overlayRoot, "extensions", "status.mjs"));
        if (context.mcpEndpointUrl !== undefined) {
          const mcp = capability<{ adapterAssetDigest?: string }>(this.#adapter, "mcp");
          if (mcp.adapterAssetDigest === undefined) {
            throw new Error("Pi MCP capability has no pinned adapter asset");
          }
          const adapterAsset = this.#adapter.assets.get(mcp.adapterAssetDigest);
          if (adapterAsset.kind !== "pi-mcp-adapter") {
            throw new Error("Pi MCP runtime asset kind mismatch");
          }
          const adapterPath = this.#runtimeAssetPaths[mcp.adapterAssetDigest];
          if (adapterPath === undefined) {
            throw new Error("Pi MCP runtime asset path is unavailable");
          }
          commandArguments.push(
            "--extension",
            adapterPath,
            "--mcp-config",
            join(context.overlayRoot, "mcp.json"),
          );
        }
        if (context.prompt !== undefined) {
          commandArguments.push(
            "--append-system-prompt",
            join(context.overlayRoot, "prompts", "system.md"),
          );
        }
        if (context.readOnly) {
          commandArguments.push(
            "--extension",
            join(context.overlayRoot, "extensions", "read-only.mjs"),
          );
        }
        break;
      }
      case "opencode":
        if (context.prompt !== undefined) commandArguments.push("--agent", generatedName);
        environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(openCodeManaged);
        environment.OPENCODE_CONFIG_DIR = join(context.stateRoot, "xdg-config", "opencode");
        environment.OPENCODE_TUI_CONFIG = join(context.overlayRoot, "tui.jsonc");
        break;
      default:
        if (launch.files.length === 0) break;
        throw new Error(`Unsupported trusted built-in provider ${providerId}`);
    }
    return Object.freeze({
      files: Object.freeze(files.map((file) => Object.freeze(file))),
      commandArguments: Object.freeze(commandArguments),
      environment: Object.freeze(environment),
      generatedIdentities: Object.freeze(generatedIdentities),
    });
  }

  public launch(input: SnapshotLaunchInput): SnapshotLaunchPlan {
    const overlay = this.planOverlay(input);
    const argumentsList = [...overlay.commandArguments];
    if (input.nativeSession !== undefined) {
      argumentsList.push(...this.resumeArguments(input.nativeSession));
    }
    if (
      input.model !== undefined &&
      (input.nativeSession === undefined || input.enforceConfiguredModelOnResume === true)
    ) {
      argumentsList.push(...this.modelArguments(input.model));
    }
    return Object.freeze({
      command: this.augmentConfiguredCommand(input.configuredCommand, argumentsList),
      environment: Object.freeze({
        ...this.stateEnvironment(input.stateRoot),
        ...overlay.environment,
      }),
      overlay,
    });
  }

  public modelArguments(model: string): readonly string[] {
    const models = capability<{ identifierPattern: string; launchTemplate: string[] }>(
      this.#adapter,
      "models",
    );
    if (models.identifierPattern !== "^[^\\s\\0]{1,256}$") {
      throw new Error("Provider model identifier policy is unsupported by this interpreter");
    }
    if (Buffer.byteLength(model, "utf8") > 256 || /[\s\0]/u.test(model)) {
      throw new Error("Provider model identifier is invalid");
    }
    return Object.freeze(models.launchTemplate.map((value) => value.replace("{model}", model)));
  }

  public normalizeNativeSession(
    report: {
      readonly source: string;
      readonly referenceKind: "id" | "path";
      readonly referenceValue: string;
    },
    stateRoot?: string,
  ): SnapshotNativeSession {
    const sessions = capability<{
      referenceKinds: string[];
      maximumReferenceBytes: number;
    }>(this.#adapter, "sessions");
    const referenceKind = report.referenceKind === "path" ? "state-contained-path" : "id";
    if (!sessions.referenceKinds.includes(referenceKind)) {
      throw new Error("Provider native session reference kind is unsupported");
    }
    if (
      Buffer.byteLength(report.referenceValue, "utf8") > sessions.maximumReferenceBytes ||
      /[\0\r\n]/u.test(report.referenceValue)
    ) {
      throw new Error("Native session reference is malformed or oversized");
    }
    if (referenceKind === "state-contained-path") {
      if (stateRoot === undefined || !isAbsolute(report.referenceValue)) {
        throw new Error("Native session path requires an absolute provider state root");
      }
      const path = resolve(report.referenceValue);
      const root = resolve(stateRoot);
      const child = relative(root, path);
      if (child === "" || child === ".." || child.startsWith("../") || isAbsolute(child)) {
        throw new Error("Native session path must remain inside provider state");
      }
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(report.referenceValue)) {
      throw new Error("Native session ID contains unsupported characters");
    }
    return Object.freeze({
      providerId: this.#adapter.body.providerId,
      source: report.source,
      referenceKind,
      referenceValue: report.referenceValue,
      dedupeDigest: digest(
        `${this.#adapter.body.providerId}\0${referenceKind}\0${report.referenceValue}`,
      ),
    });
  }

  public resumeArguments(reference: SnapshotNativeSession): readonly string[] {
    const sessions = capability<{
      referenceKinds: string[];
      resumeArgumentTemplate: string[];
    }>(this.#adapter, "sessions");
    if (
      reference.providerId !== this.#adapter.body.providerId ||
      !sessions.referenceKinds.includes(reference.referenceKind)
    ) {
      throw new Error("Native session does not belong to this provider snapshot");
    }
    return Object.freeze(
      sessions.resumeArgumentTemplate.map((value) =>
        value.replace("{reference}", reference.referenceValue),
      ),
    );
  }

  public credentialEnvironmentNames(): readonly string[] {
    const credentials = capability<{ slots: Array<{ targetNames: string[] }> }>(
      this.#adapter,
      "credentials",
    );
    return Object.freeze(credentials.slots.flatMap((slot) => slot.targetNames));
  }

  public controlPolicy(): SnapshotControlPolicy {
    const control = capability<{
      operations: Array<{ kind: string; codecId: string; acknowledgement: string }>;
    }>(this.#adapter, "control");
    const reporter = capability<{ waitTransports: string[] }>(this.#adapter, "reporter");
    const prompt = control.operations.find((operation) => operation.kind === "prompt");
    const submitByCodec: Readonly<Record<string, string>> = {
      "copilot.bracketed-paste-submit": "\u001b[I\r",
      "nanasa.carriage-return": "\r",
    };
    const terminalSubmitSequence = prompt === undefined ? undefined : submitByCodec[prompt.codecId];
    if (terminalSubmitSequence === undefined) {
      throw new Error("Provider prompt operation uses an unsupported terminal codec");
    }
    return Object.freeze({
      waitReplyChannels: Object.freeze([...reporter.waitTransports]),
      supportsPromptAcknowledgement: prompt?.acknowledgement === "reporter",
      supportsCancellation: control.operations.some((operation) => operation.kind === "cancel"),
      terminalSubmitSequence,
      operations: Object.freeze([...control.operations]),
    });
  }

  public encodeWaitReply(reply: OpenWaitReply): string {
    switch (reply.kind) {
      case "answer":
        return reply.text;
      case "select":
        return reply.option;
      case "allow-once":
      case "approve-plan":
        return "y";
      case "deny":
      case "reject-plan":
        return "n";
    }
  }

  public reporterPolicy(): Readonly<Record<string, unknown>> {
    return Object.freeze({ ...capability<Record<string, unknown>>(this.#adapter, "reporter") });
  }

  public statusPolicy(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      ...capability<Record<string, unknown>>(this.#adapter, "semantic-status"),
    });
  }

  public screenPolicy(): Readonly<{ capability: unknown; manifest: unknown }> {
    const screen = capability<{ manifestDigest: string }>(this.#adapter, "screen");
    const manifest = this.#adapter.assets.get(screen.manifestDigest);
    if (manifest.kind !== "screen-manifest") throw new Error("Screen manifest asset kind mismatch");
    return Object.freeze({ capability: screen, manifest: manifest.payload });
  }

  #renderPrompt(prompt: EffectiveAgentPrompt, memberAlias: string): string {
    return `---\nname: ${JSON.stringify(`Nanasa ${memberAlias}`)}\ndescription: ${JSON.stringify(`Nanasa-managed ${prompt.role?.name ?? "agent"}`)}\ninfer: false\n---\n\n${prompt.text}`;
  }
}
