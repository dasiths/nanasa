import type {
  AgentKind,
  ExtensionLifecycleCommand,
  ExtensionLockGeneration,
  InstallProviderExtensionCommand,
  NanasaConfig,
  ProviderCatalogItem,
  ProviderExtensionInspect,
  ProviderExtensionPlan,
  TrustProviderExtensionCommand,
} from "@nanasa/contracts";
import {
  ProviderAdapterStrategySchema,
  ProviderControlStrategyIdSchema,
  ProviderExtensionDescriptorSchema,
  ProviderHomeStrategySchema,
  ProviderMcpStrategySchema,
  ProviderNativeResumeStrategySchema,
  ProviderPromptStrategySchema,
  ProviderProvisioningStrategySchema,
  ProviderReporterStrategySchema,
  REQUIRED_PROVIDER_EXTENSION_PERMISSIONS,
} from "@nanasa/contracts";
import { z } from "zod";
import type { NanasaStore } from "../store.js";
import type { ExtensionLockRepository } from "./extension-lock-repository.js";
import { ExtensionPackageError } from "./extension-package-loader.js";
import type { ProviderCatalogService, CatalogPackage } from "./provider-catalog-service.js";
import type { ProviderExtensionPlanner } from "./provider-extension-planner.js";
import type { ProviderHealthService } from "./provider-health-service.js";

interface ConfigSnapshot {
  readonly config: NanasaConfig;
  readonly revision: string;
}

function generation(item: CatalogPackage, installedAt: string): ExtensionLockGeneration {
  return {
    descriptor: item.descriptor,
    descriptorDigest: item.descriptorDigest,
    packageDigest: item.packageDigest,
    source: item.source,
    ...(item.signature === undefined ? {} : { signature: item.signature }),
    grantedPermissions: [...item.descriptor.permissions],
    packageReference: item.packageReference,
    installedAt,
  };
}

const activeStatuses = new Set(["starting", "running", "stopping"]);

export class ProviderExtensionService {
  public constructor(
    private readonly locks: ExtensionLockRepository,
    private readonly catalog: ProviderCatalogService,
    private readonly planner: ProviderExtensionPlanner,
    private readonly healthService: ProviderHealthService,
    private readonly config: () => ConfigSnapshot,
    private readonly store: NanasaStore,
    private readonly repositoryIdentity: string,
  ) {}

  public initializeBuiltIns(): void {
    this.locks.initialize((current) => {
      const extensions = { ...current.extensions };
      let changed = false;
      const installedAt = new Date().toISOString();
      for (const item of this.catalog
        .packages()
        .filter((candidate) => candidate.source.kind === "builtin")) {
        if (extensions[item.descriptor.metadata.id] !== undefined) continue;
        extensions[item.descriptor.metadata.id] = {
          ...generation(item, installedAt),
          enabled: true,
        };
        changed = true;
      }
      return changed ? { version: 1, revision: current.revision + 1, extensions } : current;
    });
    const current = this.config();
    for (const item of this.catalog
      .packages()
      .filter((candidate) => candidate.source.kind === "builtin")) {
      const plan = this.plan(item.descriptor.metadata.id, item.descriptor.metadata.version);
      if (this.locks.findTrust(item.descriptor.metadata.id, plan.planDigest) !== undefined)
        continue;
      this.locks.saveTrust({
        extensionId: item.descriptor.metadata.id,
        version: item.descriptor.metadata.version,
        repositoryIdentity: this.repositoryIdentity,
        configRevision: current.revision,
        planDigest: plan.planDigest,
        packageDigest: item.packageDigest,
        permissions: [...item.descriptor.permissions],
        principalId: "nanasa-builtin",
        trustedAt: new Date().toISOString(),
      });
    }
  }

  public list(): ProviderCatalogItem[] {
    const lock = this.locks.read();
    return this.catalog.list(lock, (extensionId) => this.healthService.inspect(extensionId));
  }

  public plan(extensionId: string, version?: string): ProviderExtensionPlan {
    const item = this.catalog.get(extensionId, version);
    const current = this.config();
    return this.planner.plan({
      descriptor: item.descriptor,
      config: current.config,
      configRevision: current.revision,
      lock: this.locks.read(),
      packageReference: item.packageReference,
    });
  }

  public inspect(extensionId: string): ProviderExtensionInspect {
    const lock = this.locks.read();
    const locked = lock.extensions[extensionId];
    const item = this.catalog.get(extensionId, locked?.descriptor.metadata.version);
    const catalog = this.catalog
      .list(lock, (id) => this.healthService.inspect(id))
      .find((candidate) => candidate.descriptor.metadata.id === extensionId);
    if (catalog === undefined)
      throw new ExtensionPackageError("extension_not_found", "Provider extension not found");
    return {
      catalog,
      ...(locked === undefined ? {} : { lock: locked }),
      plan: this.planner.plan({
        descriptor: item.descriptor,
        config: this.config().config,
        configRevision: this.config().revision,
        lock,
        packageReference: item.packageReference,
      }),
    };
  }

  public trust(extensionId: string, principalId: string, command: TrustProviderExtensionCommand) {
    const plan = this.plan(extensionId);
    this.assertPlan(command.planDigest, command.configRevision, plan);
    const item = this.catalog.get(extensionId, plan.version);
    return this.locks.saveTrust({
      extensionId,
      version: plan.version,
      repositoryIdentity: this.repositoryIdentity,
      configRevision: plan.configRevision,
      planDigest: plan.planDigest,
      packageDigest: item.packageDigest,
      permissions: [...plan.permissions],
      principalId,
      trustedAt: new Date().toISOString(),
    });
  }

  public install(
    extensionId: string,
    command: InstallProviderExtensionCommand,
  ): ProviderExtensionInspect {
    const plan = this.plan(extensionId);
    this.assertPlan(command.planDigest, command.configRevision, plan);
    if (command.expectedLockRevision !== plan.lockRevision) {
      throw new ExtensionPackageError(
        "extension_lock_revision_stale",
        "Extension lock revision changed",
      );
    }
    this.assertStopped(plan);
    const item = this.catalog.get(extensionId, plan.version);
    const trust = this.locks.findTrust(extensionId, plan.planDigest);
    if (trust === undefined || trust.packageDigest !== item.packageDigest) {
      throw new ExtensionPackageError(
        "extension_trust_required",
        "Trust the exact extension plan before installation",
      );
    }
    const installedAt = new Date().toISOString();
    this.locks.mutate(command.expectedLockRevision, (current) => {
      const previous = current.extensions[extensionId];
      const next = generation(item, installedAt);
      return {
        version: 1,
        revision: current.revision + 1,
        extensions: {
          ...current.extensions,
          [extensionId]: {
            ...next,
            enabled: true,
            ...(previous === undefined ? {} : { previous: this.currentGeneration(previous) }),
          },
        },
      };
    });
    return this.inspect(extensionId);
  }

  public repair(
    extensionId: string,
    command: InstallProviderExtensionCommand,
  ): ProviderExtensionInspect {
    const plan = this.plan(extensionId);
    this.assertPlan(command.planDigest, command.configRevision, plan);
    this.assertStopped(plan);
    const item = this.catalog.get(extensionId, plan.version);
    const trust = this.locks.findTrust(extensionId, plan.planDigest);
    if (trust === undefined) {
      throw new ExtensionPackageError(
        "extension_trust_required",
        "Trust the exact repair plan before repair",
      );
    }
    this.locks.mutate(command.expectedLockRevision, (current) => {
      const existing = current.extensions[extensionId];
      if (existing === undefined) {
        throw new ExtensionPackageError(
          "extension_not_installed",
          "Provider extension is not installed",
        );
      }
      return {
        ...current,
        revision: current.revision + 1,
        extensions: {
          ...current.extensions,
          [extensionId]: {
            ...generation(item, new Date().toISOString()),
            enabled: true,
            ...(existing.previous === undefined ? {} : { previous: existing.previous }),
          },
        },
      };
    });
    return this.inspect(extensionId);
  }

  public disable(
    extensionId: string,
    command: ExtensionLifecycleCommand,
  ): ProviderExtensionInspect {
    const plan = this.plan(extensionId);
    this.assertStopped(plan);
    this.locks.mutate(command.expectedLockRevision, (current) => {
      const existing = current.extensions[extensionId];
      if (existing === undefined)
        throw new ExtensionPackageError(
          "extension_not_installed",
          "Provider extension is not installed",
        );
      return {
        ...current,
        revision: current.revision + 1,
        extensions: { ...current.extensions, [extensionId]: { ...existing, enabled: false } },
      };
    });
    return this.inspect(extensionId);
  }

  public rollback(
    extensionId: string,
    command: ExtensionLifecycleCommand,
  ): ProviderExtensionInspect {
    const plan = this.plan(extensionId);
    this.assertStopped(plan);
    this.locks.mutate(command.expectedLockRevision, (current) => {
      const existing = current.extensions[extensionId];
      if (existing?.previous === undefined) {
        throw new ExtensionPackageError(
          "extension_rollback_unavailable",
          "No rollback generation is available",
        );
      }
      return {
        ...current,
        revision: current.revision + 1,
        extensions: {
          ...current.extensions,
          [extensionId]: {
            ...existing.previous,
            enabled: true,
            previous: this.currentGeneration(existing),
          },
        },
      };
    });
    return this.inspect(extensionId);
  }

  public remove(extensionId: string, command: ExtensionLifecycleCommand): ProviderCatalogItem {
    const plan = this.plan(extensionId);
    this.assertStopped(plan);
    if (plan.commands.length > 0) {
      throw new ExtensionPackageError(
        "extension_referenced",
        "Remove integrations that reference this provider strategy before removing the extension",
      );
    }
    this.locks.mutate(command.expectedLockRevision, (current) => {
      if (current.extensions[extensionId] === undefined) {
        throw new ExtensionPackageError(
          "extension_not_installed",
          "Provider extension is not installed",
        );
      }
      const extensions = { ...current.extensions };
      delete extensions[extensionId];
      return { version: 1, revision: current.revision + 1, extensions };
    });
    this.locks.removeTrust(extensionId);
    return this.list().find((item) => item.descriptor.metadata.id === extensionId)!;
  }

  public generatedReference() {
    return {
      schema: z.toJSONSchema(ProviderExtensionDescriptorSchema, { unrepresentable: "any" }),
      permissions: [...REQUIRED_PROVIDER_EXTENSION_PERMISSIONS],
      strategies: {
        adapter: ProviderAdapterStrategySchema.options,
        home: ProviderHomeStrategySchema.options,
        prompt: ProviderPromptStrategySchema.options,
        mcp: ProviderMcpStrategySchema.options,
        reporter: ProviderReporterStrategySchema.options,
        control: ProviderControlStrategyIdSchema.options,
        nativeResume: ProviderNativeResumeStrategySchema.options,
        provisioning: ProviderProvisioningStrategySchema.options,
      },
      descriptors: this.catalog.packages().map((item) => item.descriptor),
    };
  }

  public assertProviderKind(kind: AgentKind): void {
    const strategy = `${kind}-adapter-v1`;
    const match = Object.values(this.locks.read().extensions).find((entry) =>
      entry.descriptor.providers.some((provider) => provider.strategies.adapter === strategy),
    );
    if (match === undefined) {
      throw new ExtensionPackageError(
        "provider_extension_not_installed",
        `No installed provider extension supplies ${kind}`,
      );
    }
    const health = this.healthService.inspect(match.descriptor.metadata.id);
    if (!["current", "unavailable"].includes(health.state)) {
      throw new ExtensionPackageError(
        "provider_extension_unhealthy",
        `Provider extension ${match.descriptor.metadata.id} is ${health.state}`,
      );
    }
  }

  private assertPlan(digest: string, configRevision: string, plan: ProviderExtensionPlan): void {
    if (digest !== plan.planDigest || configRevision !== plan.configRevision) {
      throw new ExtensionPackageError(
        "extension_plan_stale",
        "Extension plan or configuration changed",
      );
    }
  }

  private assertStopped(plan: ProviderExtensionPlan): void {
    if (!plan.requiresStoppedRuns) return;
    const memberIds = new Set<string>();
    const config = this.config().config;
    for (const group of Object.values(config.groups)) {
      for (const [agentId, agent] of Object.entries(group.agents)) {
        if (plan.impactedAgents.includes(agentId)) memberIds.add(agent.memberId);
      }
    }
    const active = this.store
      .getSnapshot()
      .runs.some((run) => memberIds.has(run.memberId) && activeStatuses.has(run.status));
    if (active) {
      throw new ExtensionPackageError(
        "extension_active_runs",
        "Stop all affected provider runs before changing the extension lock",
      );
    }
  }

  private currentGeneration(entry: ExtensionLockGeneration): ExtensionLockGeneration {
    return {
      descriptor: entry.descriptor,
      descriptorDigest: entry.descriptorDigest,
      packageDigest: entry.packageDigest,
      source: entry.source,
      ...(entry.signature === undefined ? {} : { signature: entry.signature }),
      grantedPermissions: [...entry.grantedPermissions],
      packageReference: entry.packageReference,
      installedAt: entry.installedAt,
    };
  }
}
