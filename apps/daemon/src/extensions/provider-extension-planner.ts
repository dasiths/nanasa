import { createHash } from "node:crypto";
import type {
  ExtensionLock,
  NanasaConfig,
  ProviderExtensionDescriptor,
  ProviderExtensionPlan,
} from "@nanasa/contracts";
import { canonicalJson } from "./extension-package-loader.js";

const environmentByAdapter = {
  "copilot-adapter-v1": ["COPILOT_HOME", "COPILOT_CACHE_HOME", "NANASA_STATUS_URL"],
  "claude-code-adapter-v1": ["CLAUDE_CONFIG_DIR", "NANASA_STATUS_URL"],
  "pi-adapter-v1": ["PI_CODING_AGENT_DIR", "NANASA_STATUS_URL"],
  "opencode-adapter-v1": [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "NANASA_STATUS_URL",
  ],
} as const;

const kindByAdapter = {
  "copilot-adapter-v1": "copilot",
  "claude-code-adapter-v1": "claude-code",
  "pi-adapter-v1": "pi",
  "opencode-adapter-v1": "opencode",
} as const;

export interface ProviderExtensionPlanningContext {
  readonly descriptor: ProviderExtensionDescriptor;
  readonly config: NanasaConfig;
  readonly configRevision: string;
  readonly lock: ExtensionLock;
  readonly packageReference: string;
}

export class ProviderExtensionPlanner {
  public plan(context: ProviderExtensionPlanningContext): ProviderExtensionPlan {
    const provider = context.descriptor.providers[0]!;
    const providerKind = kindByAdapter[provider.strategies.adapter];
    const integrationIds = Object.entries(context.config.integrations)
      .filter(([, integration]) => integration.kind === providerKind)
      .map(([id]) => id)
      .sort();
    const impactedAgents = Object.values(context.config.groups)
      .flatMap((group) =>
        Object.entries(group.agents)
          .filter(([, agent]) => integrationIds.includes(agent.integrationId))
          .map(([agentId]) => agentId),
      )
      .sort();
    const mutations: ProviderExtensionPlan["mutations"] = [
      {
        kind: "package",
        target: context.packageReference,
        ownershipKey: `extension:${context.descriptor.metadata.id}`,
      },
      {
        kind: "lock",
        target: ".nanasa/extensions.lock.yaml",
        ownershipKey: `extension-lock:${context.descriptor.metadata.id}`,
      },
      ...provider.strategies.provisioning.map((strategy, index) => ({
        kind: strategy === "owned-file-v1" ? ("owned-file" as const) : ("managed-key" as const),
        target: `provider-home:${provider.id}:${strategy}:${index}`,
        ownershipKey: `${context.descriptor.metadata.id}:${provider.id}:${strategy}:${index}`,
      })),
    ];
    const commands = integrationIds.map((integrationId) => {
      const integration = context.config.integrations[integrationId]!;
      return {
        integrationId,
        executable: integration.command[0]!,
        argv: integration.command.slice(1),
        cwd: integration.cwd ?? context.config.repository.path,
        environmentNames: [
          ...new Set([
            ...Object.keys(integration.environment),
            ...environmentByAdapter[provider.strategies.adapter],
          ]),
        ].sort(),
      };
    });
    const material = {
      extensionId: context.descriptor.metadata.id,
      version: context.descriptor.metadata.version,
      configRevision: context.configRevision,
      lockRevision: context.lock.revision,
      permissions: [...context.descriptor.permissions].sort(),
      mutations,
      commands,
      impactedAgents,
    };
    return {
      ...material,
      planDigest: createHash("sha256").update(canonicalJson(material)).digest("hex"),
      requiresStoppedRuns: impactedAgents.length > 0,
    };
  }
}
