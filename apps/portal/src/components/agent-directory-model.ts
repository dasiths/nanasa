import type { Checkout, IntegrationConfig, NanasaConfig, PortalSnapshot } from "@nanasa/contracts";
import { memberStatusView } from "../member-status.js";

export function configuredProviderHome(integration: IntegrationConfig, agentId: string): string {
  const policy = integration.providerState;
  const suffix =
    policy.scope === "membership"
      ? `members/${agentId}/${integration.id}`
      : policy.scope === "integration"
        ? `integrations/${integration.id}`
        : `custom/${policy.path.replaceAll("{integrationId}", integration.id).replaceAll("{agentId}", agentId)}`;
  return `.nanasa/integrations/state/${suffix}`;
}

function mappedDirectory(
  checkout: Checkout | undefined,
  primary: Checkout | undefined,
  cwd: string | undefined,
): string | undefined {
  if (checkout === undefined || primary === undefined || checkout.kind === "bare") return undefined;
  if (cwd === undefined || cwd === primary.path) return checkout.path;
  const prefix = `${primary.path.replace(/\/$/, "")}/`;
  if (!cwd.startsWith(prefix)) return undefined;
  return `${checkout.path.replace(/\/$/, "")}/${cwd.slice(prefix.length)}`;
}

export function agentDirectoryEntries(snapshot: PortalSnapshot, config: NanasaConfig) {
  const primary = snapshot.checkouts.find(
    (checkout) => checkout.id === snapshot.repositories[0]?.primaryCheckoutId,
  );
  return snapshot.memberships
    .filter((member) => member.state === "active")
    .map((member) => {
      const group = snapshot.groups.find((candidate) => candidate.id === member.groupId);
      const configuredGroup = config.groups?.[member.groupId];
      const agent = configuredGroup?.agents[member.id];
      const integration =
        agent === undefined ? undefined : config.integrations?.[agent.integrationId];
      const role = agent?.roleId === undefined ? undefined : config.roles?.[agent.roleId];
      const checkout =
        group?.checkoutId === undefined
          ? primary
          : snapshot.checkouts.find((candidate) => candidate.id === group.checkoutId);
      const profile =
        integration?.executionProfile === undefined
          ? undefined
          : config.executionProfiles?.[integration.executionProfile];
      const layers =
        agent === undefined
          ? []
          : [
              {
                name: "Built-in",
                source: "Nanasa",
                files: ["builtin:nanasa-coordination-v1", "builtin:nanasa-assignment-v1"],
              },
              { name: "Global", source: "All agents", files: config.instructions },
              {
                name: "Team",
                source: group?.name ?? member.groupId,
                files: configuredGroup?.instructions ?? [],
              },
              { name: "Role", source: role?.name ?? "Unassigned", files: role?.instructions ?? [] },
              { name: "Agent", source: agent.name, files: agent.instructions },
            ];
      return {
        member,
        group,
        agent,
        integration,
        role,
        checkout,
        profile,
        layers,
        state: memberStatusView(snapshot.agentStatuses, snapshot.runs, member),
        startingDirectory:
          integration === undefined
            ? undefined
            : mappedDirectory(checkout, primary, integration.cwd),
        providerHome:
          integration === undefined ? undefined : configuredProviderHome(integration, member.id),
        desiredModel: agent?.desiredModel ?? integration?.model.model,
        modelSource:
          agent?.desiredModel !== undefined
            ? "Agent override"
            : integration?.model.model !== undefined
              ? "Integration"
              : "Provider default",
        sourceCount: layers.reduce((count, layer) => count + layer.files.length, 0),
        layerCount: layers.filter((layer) => layer.files.length > 0).length,
      };
    });
}

export type AgentDirectoryEntry = ReturnType<typeof agentDirectoryEntries>[number];
