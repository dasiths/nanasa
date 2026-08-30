import type {
  ExtensionLock,
  ExtensionPackageSignature,
  ExtensionPackageSourceSchema,
  ProviderCatalogItem,
  ProviderExtensionDescriptor,
  ProviderExtensionHealth,
} from "@nanasa/contracts";
import type { z } from "zod";
import type { ProviderAdapterRegistry } from "../providers/provider-adapter-registry.js";
import { descriptorDigest } from "./extension-package-loader.js";

type ExtensionPackageSource = z.infer<typeof ExtensionPackageSourceSchema>;

export interface CatalogPackage {
  readonly descriptor: ProviderExtensionDescriptor;
  readonly descriptorDigest: string;
  readonly packageDigest: string;
  readonly packageReference: string;
  readonly source: ExtensionPackageSource;
  readonly signature?: ExtensionPackageSignature;
  readonly signatureState: "builtin" | "verified" | "unavailable";
}

const permissions = [
  "provider-home:read-managed",
  "provider-home:write-owned",
  "runtime:launch-provider",
  "prompt:append",
  "mcp:register-nanasa",
  "reporter:status",
  "native-session:resume",
] as const;

const definitions = {
  copilot: {
    extensionId: "nanasa.copilot",
    name: "GitHub Copilot",
    publisher: "Nanasa",
    commandNames: ["copilot"],
    strategies: {
      adapter: "copilot-adapter-v1",
      home: "copilot-home-v1",
      prompt: "copilot-agent-v1",
      mcp: "copilot-mcp-v1",
      reporter: "copilot-hooks-v2",
      control: "copilot-terminal-v1",
      nativeResume: "copilot-resume-v1",
      provisioning: ["owned-file-v1", "managed-json-object-v1"],
    },
  },
  "claude-code": {
    extensionId: "nanasa.claude-code",
    name: "Claude Code",
    publisher: "Nanasa",
    commandNames: ["claude"],
    strategies: {
      adapter: "claude-code-adapter-v1",
      home: "claude-code-home-v1",
      prompt: "claude-settings-v1",
      mcp: "claude-mcp-v1",
      reporter: "claude-hooks-v2",
      control: "claude-terminal-v1",
      nativeResume: "claude-resume-v1",
      provisioning: ["owned-file-v1", "managed-json-object-v1", "managed-json-array-v1"],
    },
  },
  pi: {
    extensionId: "nanasa.pi",
    name: "Pi",
    publisher: "Nanasa",
    commandNames: ["pi"],
    strategies: {
      adapter: "pi-adapter-v1",
      home: "pi-home-v1",
      prompt: "pi-prompt-v1",
      mcp: "pi-mcp-v1",
      reporter: "pi-events-v2",
      control: "pi-terminal-v1",
      nativeResume: "pi-resume-v1",
      provisioning: ["owned-file-v1", "managed-json-object-v1"],
    },
  },
  opencode: {
    extensionId: "nanasa.opencode",
    name: "OpenCode",
    publisher: "Nanasa",
    commandNames: ["opencode"],
    strategies: {
      adapter: "opencode-adapter-v1",
      home: "opencode-xdg-v1",
      prompt: "opencode-primary-agent-v1",
      mcp: "opencode-mcp-v1",
      reporter: "opencode-events-v2",
      control: "opencode-terminal-v1",
      nativeResume: "opencode-resume-v1",
      provisioning: ["owned-file-v1", "managed-json-object-v1"],
    },
  },
} as const;

export class ProviderCatalogService {
  readonly #packages = new Map<string, Map<string, CatalogPackage>>();

  public constructor(adapters: ProviderAdapterRegistry) {
    for (const adapter of adapters.list()) {
      const definition = definitions[adapter.id];
      const descriptor: ProviderExtensionDescriptor = {
        apiVersion: "nanasa.dev/provider-extension/v1",
        kind: "ProviderExtension",
        metadata: {
          id: definition.extensionId,
          name: definition.name,
          version: adapter.version,
          publisher: definition.publisher,
          description: `Nanasa-maintained declarative provider package for ${definition.name}`,
        },
        compatibility: {
          minNanasaVersion: "0.0.0",
          reporterProtocol: 2,
        },
        providers: [
          {
            id: adapter.id,
            displayName: definition.name,
            commandNames: [...definition.commandNames],
            strategies: {
              ...definition.strategies,
              provisioning: [...definition.strategies.provisioning],
            },
          },
        ],
        permissions: [...permissions],
        assets: [],
      };
      const digest = descriptorDigest(descriptor);
      this.add({
        descriptor,
        descriptorDigest: digest,
        packageDigest: digest,
        packageReference: `builtin:${definition.extensionId}@${adapter.version}`,
        source: { kind: "builtin", name: definition.extensionId },
        signatureState: "builtin",
      });
    }
  }

  public add(item: CatalogPackage): void {
    const versions = this.#packages.get(item.descriptor.metadata.id) ?? new Map();
    if (versions.has(item.descriptor.metadata.version)) {
      throw new Error(
        `Duplicate extension package ${item.descriptor.metadata.id}@${item.descriptor.metadata.version}`,
      );
    }
    versions.set(item.descriptor.metadata.version, Object.freeze(item));
    this.#packages.set(item.descriptor.metadata.id, versions);
  }

  public get(extensionId: string, version?: string): CatalogPackage {
    const versions = this.#packages.get(extensionId);
    if (versions === undefined) throw new Error(`Unknown provider extension ${extensionId}`);
    if (version !== undefined) {
      const selected = versions.get(version);
      if (selected === undefined)
        throw new Error(`Unknown provider extension ${extensionId}@${version}`);
      return selected;
    }
    return [...versions.values()].sort((left, right) =>
      right.descriptor.metadata.version.localeCompare(left.descriptor.metadata.version, undefined, {
        numeric: true,
      }),
    )[0]!;
  }

  public packages(): readonly CatalogPackage[] {
    return Object.freeze(
      [...this.#packages.values()].flatMap((versions) => [...versions.values()]),
    );
  }

  public list(
    lock: ExtensionLock,
    health: (extensionId: string) => ProviderExtensionHealth,
  ): ProviderCatalogItem[] {
    return [...this.#packages.keys()].sort().map((extensionId) => {
      const installed = lock.extensions[extensionId];
      const item = this.get(extensionId, installed?.descriptor.metadata.version);
      return {
        descriptor: item.descriptor,
        source: item.source,
        descriptorDigest: item.descriptorDigest,
        packageDigest: item.packageDigest,
        signatureState: item.signatureState,
        installed: installed !== undefined,
        enabled: installed?.enabled ?? false,
        health: health(extensionId),
      };
    });
  }
}
