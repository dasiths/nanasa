import type { WorkspaceSection } from "../hooks/use-portal-preferences.js";

export interface GroupDestinationDefinition {
  id: WorkspaceSection;
  label: string;
  commandLabel: string;
  commandDescription: string;
  keywords: string[];
}

export const groupDestinations = [
  {
    id: "terminals",
    label: "Terminals",
    commandLabel: "Open group terminals",
    commandDescription: "View and control active terminals for the selected group",
    keywords: ["runs", "console", "pty"],
  },
  {
    id: "messages",
    label: "Messages",
    commandLabel: "Open group messages",
    commandDescription: "Read message history and communicate with the selected group",
    keywords: ["chat", "inbox", "communication"],
  },
  {
    id: "activity",
    label: "Attention",
    commandLabel: "Open group attention",
    commandDescription: "Review responses, health, completions, delivery, and durable progress",
    keywords: ["activity", "attention", "waits", "approvals"],
  },
] as const satisfies readonly GroupDestinationDefinition[];

export type GlobalDestinationGroup = "operations" | "system" | "utilities";

export interface GlobalDestinationDefinition {
  id:
    | "attention"
    | "agents"
    | "checkouts"
    | "extensions"
    | "settings"
    | "diagnostics"
    | "help"
    | "release"
    | "service"
    | "remote";
  label: string;
  heading: string;
  group: GlobalDestinationGroup;
  commandLabel: string;
  commandDescription: string;
  keywords: string[];
  shortcut?: string;
}

export const globalDestinationDefinitions = [
  {
    id: "attention",
    label: "Attention",
    heading: "Attention",
    group: "operations",
    commandLabel: "Open attention",
    commandDescription: "Review waits, blockers, failures, and completion across every group",
    keywords: ["inbox", "blocked", "approval"],
    shortcut: "Alt+a",
  },
  {
    id: "agents",
    label: "All agents",
    heading: "All agents",
    group: "operations",
    commandLabel: "Open all agents",
    commandDescription: "Browse agents across every group",
    keywords: ["directory", "members", "runs"],
    shortcut: "Alt+g",
  },
  {
    id: "checkouts",
    label: "Team workspaces",
    heading: "Team workspaces",
    group: "operations",
    commandLabel: "Open team workspaces",
    commandDescription: "Assign team workspaces and manage worktrees",
    keywords: ["git", "branches", "worktrees"],
    shortcut: "Alt+c",
  },
  {
    id: "extensions",
    label: "Providers",
    heading: "Providers",
    group: "utilities",
    commandLabel: "Open providers",
    commandDescription: "Set up providers and resolve issues preventing agents from running",
    keywords: ["providers", "packages", "integrations"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    heading: "Diagnostics",
    group: "system",
    commandLabel: "Open diagnostics",
    commandDescription: "Inspect daemon configuration, provider state, and checkpoints",
    keywords: ["health", "config", "metadata"],
    shortcut: "Alt+d",
  },
  {
    id: "service",
    label: "Service",
    heading: "Service",
    group: "system",
    commandLabel: "Open service",
    commandDescription: "Inspect lifecycle and planned reconnect behavior",
    keywords: ["systemd", "restart", "daemon"],
  },
  {
    id: "remote",
    label: "Remote access",
    heading: "Remote access",
    group: "system",
    commandLabel: "Open remote access",
    commandDescription: "Review loopback SSH tunnel status and guidance",
    keywords: ["ssh", "tunnel", "connect"],
  },
  {
    id: "settings",
    label: "Preferences",
    heading: "Preferences",
    group: "utilities",
    commandLabel: "Open preferences",
    commandDescription: "Change browser presentation, accessibility, and notifications",
    keywords: ["settings", "theme", "notifications"],
    shortcut: "Ctrl+,",
  },
  {
    id: "help",
    label: "Help",
    heading: "Help",
    group: "utilities",
    commandLabel: "Open help",
    commandDescription: "Read keyboard, terminal, and workflow help",
    keywords: ["guide", "shortcuts", "documentation"],
    shortcut: "Alt+h",
  },
  {
    id: "release",
    label: "About Nanasa",
    heading: "About Nanasa",
    group: "utilities",
    commandLabel: "Open About Nanasa",
    commandDescription: "Review installed product identity and compatibility",
    keywords: ["release", "version", "build"],
  },
] as const satisfies readonly GlobalDestinationDefinition[];

export type GlobalDestination = (typeof globalDestinationDefinitions)[number]["id"];

export const globalDestinations = globalDestinationDefinitions.map(
  ({ id }) => id,
) as GlobalDestination[];

export function globalDestinationDefinition(
  destination: GlobalDestination,
): (typeof globalDestinationDefinitions)[number] {
  return globalDestinationDefinitions.find(({ id }) => id === destination)!;
}
