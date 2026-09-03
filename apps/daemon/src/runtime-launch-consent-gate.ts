import type {
  CustomLaunchConsentRequest,
  CustomLaunchConsentSubject,
  IntegrationConfig,
  StartAgentRunResult,
} from "@nanasa/contracts";

import type { ConfigRepository } from "./config-repository.js";
import { repositoryLauncherFiles } from "./custom-launch-consent-subject.js";
import {
  type CurrentLaunchConsentSubject,
  LaunchConsentService,
  type ResolveLaunchConsentInput,
} from "./launch-consent-service.js";
import type { ProviderRunBindingRepository } from "./providers/provider-run-binding-repository.js";
import type { ResolvedProviderAdapter } from "./providers/resolved-provider-adapter.js";
import type { RuntimeLaunchConsentGate as CoordinatorLaunchConsentGate } from "./run-runtime-coordinator.js";
import { DomainError, type NanasaStore } from "./store.js";

const REPORTER_ENVIRONMENT_NAMES = [
  "NANASA_MCP_TOKEN",
  "NANASA_STATUS_URL",
  "NANASA_REPORTER_PROVIDER_ID",
  "NANASA_REPORTER_ADAPTER_ID",
  "NANASA_REPORTER_ID",
  "NANASA_REPORTER_SOURCE",
  "NANASA_REPORTER_PROTOCOL_VERSION",
  "NANASA_REPORTER_VERSION",
  "NANASA_REPORTER_RUN_ID",
  "NANASA_REPORTER_GENERATION",
  "NANASA_REPORTER_EPOCH",
  "NANASA_REPORTER_SEQUENCE_FILE",
] as const;

function capabilityEnvironmentNames(
  adapter: ResolvedProviderAdapter,
  capabilityId: "credentials" | "launch" | "state",
): string[] {
  const payload = adapter.body.capabilities.find((item) => item.id === capabilityId)?.payload as
    | { environmentNames?: unknown; slots?: Array<{ targetNames?: unknown }> }
    | undefined;
  const direct = Array.isArray(payload?.environmentNames)
    ? payload.environmentNames.filter((name): name is string => typeof name === "string")
    : [];
  const credentialNames =
    capabilityId === "credentials"
      ? (payload?.slots ?? []).flatMap((slot) =>
          Array.isArray(slot.targetNames)
            ? slot.targetNames.filter((name): name is string => typeof name === "string")
            : [],
        )
      : [];
  return [...direct, ...credentialNames];
}

function independentPermissionFloorCapability(
  adapter: ResolvedProviderAdapter,
): string | undefined {
  const capability = adapter.body.capabilities.find(
    (item) => String(item.id) === "custom-launch-permission-floor",
  );
  const payload = capability?.payload as { readOnly?: unknown } | undefined;
  return payload?.readOnly === "independently-enforced"
    ? `${capability!.id}@${capability!.version.major}.${capability!.version.minor}`
    : undefined;
}

function environmentNames(
  integration: IntegrationConfig,
  adapter: ResolvedProviderAdapter,
  runtimeEnvironmentNames: readonly string[],
): string[] {
  const launcherName =
    integration.launcher?.providerArguments !== undefined &&
    integration.launcher.providerArguments !== "append"
      ? [integration.launcher.providerArguments.name]
      : [];
  return [
    ...new Set([
      ...Object.keys(integration.environment),
      ...capabilityEnvironmentNames(adapter, "credentials"),
      ...capabilityEnvironmentNames(adapter, "launch"),
      ...capabilityEnvironmentNames(adapter, "state"),
      ...REPORTER_ENVIRONMENT_NAMES,
      ...runtimeEnvironmentNames,
      ...launcherName,
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

export interface RuntimeLaunchConsentGateOptions {
  readonly repositoryIdentity: string;
  readonly configRepository: ConfigRepository;
  readonly store: NanasaStore;
  readonly providerBindings: ProviderRunBindingRepository;
  readonly consentService: LaunchConsentService;
  readonly runtimeEnvironmentNames?: readonly string[];
}

export class RuntimeLaunchConsentGate implements CoordinatorLaunchConsentGate {
  readonly #repositoryIdentity: string;
  readonly #configRepository: ConfigRepository;
  readonly #store: NanasaStore;
  readonly #providerBindings: ProviderRunBindingRepository;
  readonly #consentService: LaunchConsentService;
  readonly #runtimeEnvironmentNames: readonly string[];

  public constructor(options: RuntimeLaunchConsentGateOptions) {
    this.#repositoryIdentity = options.repositoryIdentity;
    this.#configRepository = options.configRepository;
    this.#store = options.store;
    this.#providerBindings = options.providerBindings;
    this.#consentService = options.consentService;
    this.#runtimeEnvironmentNames = options.runtimeEnvironmentNames ?? [];
  }

  public async resolve(
    groupId: string,
    memberId: string,
  ): Promise<
    | { readonly status: "built-in" | "trusted" }
    | Extract<StartAgentRunResult, { status: "approval-required" | "denied" }>
  > {
    const input = await this.#input(groupId, memberId);
    const resolution = this.#consentService.resolve(input);
    if (resolution.status === "built-in" || resolution.status === "trusted") return resolution;
    return { status: resolution.status, request: resolution.request };
  }

  public async resolveForAutomaticRecovery(
    groupId: string,
    memberId: string,
  ): Promise<{ readonly status: "built-in" | "trusted" | "approval-required" | "denied" }> {
    const resolution = this.#consentService.inspectForAutomaticRecovery(
      await this.#input(groupId, memberId),
    );
    return { status: resolution.status };
  }

  public async inspectForRecovery(
    groupId: string,
    memberId: string,
  ): Promise<{ readonly status: "built-in" | "trusted" | "approval-required" | "denied" }> {
    const resolution = this.#consentService.inspect(await this.#input(groupId, memberId));
    return { status: resolution.status };
  }

  public async resolveCurrentSubject(
    request: Pick<
      CustomLaunchConsentRequest,
      "repositoryIdentity" | "groupId" | "agentId" | "memberId" | "integrationId"
    >,
  ): Promise<CurrentLaunchConsentSubject | undefined> {
    let input: ResolveLaunchConsentInput;
    try {
      input = await this.#input(request.groupId, request.memberId);
    } catch (error) {
      if (
        error instanceof DomainError &&
        ["membership_not_active", "agent_not_found", "integration_not_found"].includes(error.code)
      ) {
        return undefined;
      }
      throw error;
    }
    if (
      input.commandSource === "builtin" ||
      input.repositoryIdentity !== request.repositoryIdentity ||
      input.agentId !== request.agentId ||
      input.integrationId !== request.integrationId
    ) {
      return undefined;
    }
    return { subject: input.subject, configRevision: input.configRevision };
  }

  async #input(groupId: string, memberId: string): Promise<ResolveLaunchConsentInput> {
    const loaded = this.#configRepository.load();
    const membership = this.#store
      .listActiveMemberships(groupId)
      .find((candidate) => candidate.memberId === memberId);
    if (membership === undefined) {
      throw new DomainError("membership_not_active", "The member is not active", 404);
    }
    const configuredAgent = loaded.config.groups[groupId]?.agents[membership.id];
    if (configuredAgent === undefined) {
      throw new DomainError("agent_not_found", "The configured agent was not found", 404);
    }
    const integration = loaded.config.integrations[configuredAgent.integrationId];
    if (integration === undefined) {
      throw new DomainError("integration_not_found", "The integration was not found", 404);
    }
    if (integration.commandSource === "builtin") return { commandSource: "builtin" };
    if (loaded.status.revision === undefined) {
      throw new DomainError(
        "config_revision_unavailable",
        "A valid configuration revision is required for custom launch consent",
        409,
      );
    }

    const adapter = await this.#providerBindings.resolveActiveSnapshot(integration.kind);
    const permissionFloor =
      membership.roleId === undefined
        ? "inherit"
        : (loaded.config.roles[membership.roleId]?.permissionPolicy ?? "inherit");
    const permissionFloorCapability = independentPermissionFloorCapability(adapter);
    if (permissionFloor === "read-only" && permissionFloorCapability === undefined) {
      throw new DomainError(
        "custom_launcher_permission_floor_unsupported",
        "The active provider cannot enforce the read-only floor independently of this custom launcher",
        409,
      );
    }
    const launcher = integration.launcher?.providerArguments;
    if (launcher === undefined) throw new Error("Custom integration has no launcher strategy");

    const subject: CustomLaunchConsentSubject = {
      repositoryIdentity: this.#repositoryIdentity,
      integrationId: integration.id,
      providerKind: integration.kind,
      adapterId: adapter.body.adapterId,
      adapterSecurityVersion: adapter.body.extensionGeneration,
      configuredCommand: integration.command,
      launcher,
      launcherFiles: repositoryLauncherFiles({
        repositoryRoot: loaded.repoRoot,
        ...(integration.cwd === undefined ? {} : { workingDirectory: integration.cwd }),
        configuredCommand: integration.command,
      }),
      ...(integration.cwd === undefined ? {} : { workingDirectory: integration.cwd }),
      environmentNames: environmentNames(integration, adapter, this.#runtimeEnvironmentNames),
      credentialReference: integration.credentials,
      permissionFloor,
      ...(permissionFloorCapability === undefined ? {} : { permissionFloorCapability }),
    };
    return {
      commandSource: "custom",
      repositoryIdentity: this.#repositoryIdentity,
      groupId,
      agentId: membership.id,
      memberId,
      integrationId: integration.id,
      subject,
      configRevision: loaded.status.revision,
    };
  }
}
