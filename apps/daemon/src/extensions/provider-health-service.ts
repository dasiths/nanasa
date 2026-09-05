import { accessSync, constants, existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExtensionLockEntry, NanasaConfig, ProviderExtensionHealth } from "@nanasa/contracts";
import type { ExtensionLockRepository } from "./extension-lock-repository.js";
import {
  assertCompatible,
  descriptorDigest,
  ExtensionPackageError,
  sha256,
} from "./extension-package-loader.js";

function available(command: string, cwd: string): boolean {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : join(cwd, command)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  return candidates.some((candidate) => {
    try {
      const status = statSync(candidate);
      if (!status.isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function packageDrift(entry: ExtensionLockEntry): string[] {
  if (entry.source.kind === "builtin") return [];
  if (!existsSync(entry.packageReference)) return ["Package cache entry is missing"];
  const root = lstatSync(entry.packageReference);
  if (!root.isDirectory() || root.isSymbolicLink()) return ["Package cache entry is unsafe"];
  const diagnostics: string[] = [];
  for (const asset of entry.descriptor.assets) {
    const path = join(entry.packageReference, ...asset.path.split("/"));
    try {
      const status = lstatSync(path);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
        diagnostics.push(`Asset is unsafe: ${asset.path}`);
      } else if (status.size !== asset.bytes || sha256(readFileSync(path)) !== asset.sha256) {
        diagnostics.push(`Asset digest changed: ${asset.path}`);
      }
    } catch {
      diagnostics.push(`Asset is missing: ${asset.path}`);
    }
  }
  return diagnostics;
}

export class ProviderHealthService {
  public constructor(
    private readonly locks: ExtensionLockRepository,
    private readonly config: () => { config: NanasaConfig; revision: string },
    private readonly productVersion: string,
  ) {}

  public inspect(extensionId: string): ProviderExtensionHealth {
    const checkedAt = new Date().toISOString();
    let entry: ExtensionLockEntry | undefined;
    try {
      entry = this.locks.read().extensions[extensionId];
    } catch (error) {
      return {
        extensionId,
        state: "invalid",
        checkedAt,
        diagnostics: [
          {
            code: error instanceof ExtensionPackageError ? error.code : "extension_lock_invalid",
            message: error instanceof Error ? error.message : "Extension lock is invalid",
          },
        ],
        repairable: false,
        rollbackAvailable: false,
      };
    }
    if (entry === undefined) {
      return {
        extensionId,
        state: "not-installed",
        checkedAt,
        diagnostics: [],
        repairable: false,
        rollbackAvailable: false,
      };
    }
    const base = {
      extensionId,
      version: entry.descriptor.metadata.version,
      checkedAt,
      rollbackAvailable: entry.previous !== undefined,
    };
    if (!entry.enabled) {
      return { ...base, state: "disabled", diagnostics: [], repairable: false };
    }
    if (
      descriptorDigest(entry.descriptor) !== entry.descriptorDigest ||
      entry.grantedPermissions.join("\0") !== entry.descriptor.permissions.join("\0")
    ) {
      return {
        ...base,
        state: "invalid",
        diagnostics: [
          {
            code: "extension_lock_tampered",
            message: "Descriptor or permissions do not match the lock",
          },
        ],
        repairable: false,
      };
    }
    try {
      assertCompatible(entry.descriptor, this.productVersion);
    } catch (error) {
      return {
        ...base,
        state: "incompatible",
        diagnostics: [
          {
            code: "extension_incompatible",
            message: error instanceof Error ? error.message : "Extension is incompatible",
          },
        ],
        repairable: false,
      };
    }
    const drift = packageDrift(entry);
    if (drift.length > 0) {
      return {
        ...base,
        state: "drifted",
        diagnostics: drift.map((message) => ({ code: "extension_package_drift", message })),
        repairable: true,
      };
    }
    const current = this.config();
    const trust = this.locks
      .listTrust()
      .find(
        (receipt) =>
          receipt.extensionId === extensionId &&
          receipt.packageDigest === entry.packageDigest &&
          receipt.configRevision === current.revision,
      );
    if (entry.source.kind !== "builtin" && trust === undefined) {
      return {
        ...base,
        state: "untrusted",
        diagnostics: [
          {
            code: "extension_trust_required",
            message: "The current extension plan is not trusted",
          },
        ],
        repairable: false,
      };
    }
    const providerKinds = new Set(
      entry.descriptor.providers.map((provider) =>
        provider.strategies.adapter.replace(/-adapter-v1$/, ""),
      ),
    );
    const unavailable = Object.entries(current.config.integrations).filter(
      ([, integration]) =>
        providerKinds.has(integration.kind) &&
        !available(integration.command[0]!, integration.cwd ?? current.config.repository.path),
    );
    if (unavailable.length > 0) {
      return {
        ...base,
        state: "unavailable",
        diagnostics: unavailable.map(([id]) => ({
          code: "provider_command_unavailable",
          message: `Configured provider command is unavailable for ${id}`,
        })),
        repairable: false,
      };
    }
    return { ...base, state: "current", diagnostics: [], repairable: false };
  }
}
