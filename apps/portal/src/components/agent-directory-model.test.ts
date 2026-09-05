import { AgentRunSchema, NanasaConfigSchema, PortalSnapshotSchema } from "@nanasa/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { agentDirectoryEntries } from "./agent-directory-model.js";
import { AgentDirectory } from "./agent-directory.js";

const timestamp = "2026-09-05T12:00:00.000Z";
const directoryConfig = NanasaConfigSchema.parse({
  version: 2,
  instructions: ["global.md"],
  integrations: {
    pi: {
      id: "pi",
      name: "Pi",
      kind: "pi",
      command: ["pi"],
      commandSource: "builtin",
      cwd: "/repo/project",
      executionProfile: "automatic",
      model: { model: "integration-model" },
    },
  },
  executionProfiles: {
    automatic: { continuation: "autonomous", questions: "disabled", approvals: "unrestricted" },
  },
  roles: {
    reviewer: { name: "Reviewer", permissionPolicy: "read-only", instructions: ["reviewer.md"] },
  },
  groups: {
    backend: {
      name: "Backend",
      agents: { builder: { memberId: "builder", name: "Builder", integrationId: "pi" } },
    },
    frontend: {
      name: "Frontend",
      instructions: ["frontend.md"],
      agents: {
        reviewer: {
          memberId: "reviewer",
          name: "Reviewer",
          integrationId: "pi",
          roleId: "reviewer",
          desiredModel: "agent-model",
          instructions: ["agent.md"],
        },
      },
    },
  },
});

const directorySnapshot = PortalSnapshotSchema.parse({
  instanceId: "instance",
  daemonEpoch: 1,
  sequence: 1,
  generatedAt: timestamp,
  groups: [
    {
      id: "backend",
      name: "Backend",
      membershipRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "frontend",
      name: "Frontend",
      membershipRevision: 1,
      checkoutId: "linked",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  memberships: [
    {
      id: "builder",
      groupId: "backend",
      memberId: "builder",
      agentProfileId: "builder",
      alias: "Builder",
      state: "active",
      joinedAt: timestamp,
    },
    {
      id: "reviewer",
      groupId: "frontend",
      memberId: "reviewer",
      agentProfileId: "reviewer",
      alias: "Reviewer",
      state: "active",
      joinedAt: timestamp,
    },
  ],
  repositories: [
    {
      id: "repo",
      commonDirectory: "/repo/.git",
      displayName: "repo",
      objectFormat: "sha1",
      refStorage: "files",
      primaryCheckoutId: "primary",
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  checkouts: [
    {
      id: "primary",
      repositoryId: "repo",
      checkoutKey: "a".repeat(64),
      path: "/repo",
      gitDirectory: "/repo/.git",
      kind: "primary",
      branch: "main",
      dirty: false,
      observedAt: timestamp,
    },
    {
      id: "linked",
      repositoryId: "repo",
      checkoutKey: "b".repeat(64),
      path: "/worktrees/frontend",
      gitDirectory: "/repo/.git/worktrees/frontend",
      kind: "linked",
      branch: "feature/frontend",
      dirty: false,
      observedAt: timestamp,
    },
  ],
  agentProfiles: [],
  runs: [],
  messages: [],
  deliveryOutcomes: [],
});

describe("agent directory configuration projection", () => {
  it("uses team checkout paths, composed prompt sources and agent model precedence", () => {
    const [backend, frontend] = agentDirectoryEntries(directorySnapshot, directoryConfig);
    expect(backend?.startingDirectory).toBe("/repo/project");
    expect(backend?.desiredModel).toBe("integration-model");
    expect(frontend).toMatchObject({
      startingDirectory: "/worktrees/frontend/project",
      desiredModel: "agent-model",
      modelSource: "Agent override",
      sourceCount: 6,
      layerCount: 5,
    });
    expect(frontend?.layers.map((layer) => layer.name)).toEqual([
      "Built-in",
      "Global",
      "Team",
      "Role",
      "Agent",
    ]);
    expect(frontend?.providerHome).toBe(".nanasa/integrations/state/members/reviewer/pi");
    expect(frontend?.role?.permissionPolicy).toBe("read-only");
    expect(frontend?.profile?.approvals).toBe("unrestricted");
  });

  it("supports shared and custom homes, absent profiles and missing checkouts", () => {
    const config = structuredClone(directoryConfig);
    config.integrations.pi!.providerState = { scope: "integration" };
    delete config.integrations.pi!.executionProfile;
    const entries = agentDirectoryEntries(directorySnapshot, config);
    expect(entries[0]?.providerHome).toBe(entries[1]?.providerHome);
    expect(entries[0]?.profile).toBeUndefined();
    config.integrations.pi!.providerState = {
      scope: "custom",
      path: "homes/{integrationId}/{agentId}",
    };
    const snapshot = structuredClone(directorySnapshot);
    snapshot.checkouts = snapshot.checkouts.filter((checkout) => checkout.id !== "linked");
    const frontend = agentDirectoryEntries(snapshot, config)[1];
    expect(frontend?.checkout).toBeUndefined();
    expect(frontend?.startingDirectory).toBeUndefined();
    expect(frontend?.providerHome).toBe(".nanasa/integrations/state/custom/homes/pi/reviewer");
  });
});

describe("agent directory interactions", () => {
  it("shows and searches member IDs separately from configured agent IDs", () => {
    const snapshot = structuredClone(directorySnapshot);
    const config = structuredClone(directoryConfig);
    snapshot.memberships[1]!.memberId = "quiet-curie";
    config.groups.frontend!.agents.reviewer!.memberId = "quiet-curie";
    render(createElement(AgentDirectory, { snapshot, config, onNavigate: vi.fn() }));
    const row = screen.getByRole("button", { name: "Inspect Reviewer" });
    expect(within(row).getByText("quiet-curie")).toBeVisible();
    expect(row).toHaveAccessibleDescription("Member ID: quiet-curie");
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "quiet-curie" } });
    expect(screen.getAllByRole("button", { name: /^Inspect / })).toHaveLength(1);
    fireEvent.click(row);
    const inspector = screen.getByRole("complementary", { name: "Agent configuration" });
    expect(within(inspector).getByText("quiet-curie")).toBeVisible();
    expect(within(inspector).getByText("Agent ID")).toBeVisible();
    expect(within(inspector).getByText("reviewer", { exact: true })).toBeVisible();
  });

  it.each([
    ["clipboard-list", "teal"],
    ["hammer", "blue"],
    ["shield-check", "amber"],
    ["wrench", "rose"],
  ] as const)("uses the configured %s role glyph in rows and inspector", (icon, color) => {
    const config = structuredClone(directoryConfig);
    config.roles.reviewer!.presentation = { icon, color };
    render(
      createElement(AgentDirectory, { snapshot: directorySnapshot, config, onNavigate: vi.fn() }),
    );
    const row = screen.getByRole("button", { name: "Inspect Reviewer" });
    expect(row.querySelector(`.ad-avatar.role-color-${color} .lucide-${icon}`)).not.toBeNull();
    expect(row.querySelector(".ad-avatar")).toHaveAttribute("title", "Reviewer");
    fireEvent.click(row);
    const inspector = screen.getByRole("complementary", { name: "Agent configuration" });
    expect(
      inspector.querySelector(`.ad-avatar.role-color-${color} .lucide-${icon}`),
    ).not.toBeNull();
  });

  it("uses neutral fallbacks for unassigned roles and roles without presentation", () => {
    render(
      createElement(AgentDirectory, {
        snapshot: directorySnapshot,
        config: directoryConfig,
        onNavigate: vi.fn(),
      }),
    );
    expect(
      screen
        .getByRole("button", { name: "Inspect Builder" })
        .querySelector(".ad-avatar.role-color-slate .lucide-bot"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Inspect Reviewer" })
        .querySelector(".ad-avatar.role-color-slate .lucide-briefcase-business"),
    ).not.toBeNull();
  });

  it("opens only the latest live terminal for the selected member and links to its team", () => {
    const snapshot = structuredClone(directorySnapshot);
    snapshot.runs = [
      AgentRunSchema.parse({
        id: "old-run",
        groupId: "backend",
        memberId: "builder",
        agentProfileId: "builder",
        generation: 1,
        status: "stopped",
        startedAt: timestamp,
      }),
      AgentRunSchema.parse({
        id: "live-run",
        groupId: "backend",
        memberId: "builder",
        agentProfileId: "builder",
        generation: 2,
        status: "running",
        startedAt: timestamp,
        terminal: { serverName: "test", sessionId: "$1", windowId: "@1", paneId: "%1" },
      }),
    ];
    const onNavigate = vi.fn();
    render(createElement(AgentDirectory, { snapshot, config: directoryConfig, onNavigate }));
    expect(screen.getByRole("link", { name: "Open terminal" })).toHaveAttribute(
      "href",
      "/groups/backend/terminals/live-run",
    );
    fireEvent.click(screen.getByRole("link", { name: "Open terminal" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/groups/backend/terminals/live-run");
    fireEvent.click(screen.getByRole("button", { name: "Inspect Reviewer" }));
    expect(screen.getByRole("heading", { name: "Reviewer" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Open terminal" })).toBeDisabled();
    fireEvent.click(screen.getByRole("link", { name: "Open team" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/groups/frontend/terminals");
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(
      screen.queryByRole("complementary", { name: "Agent configuration" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect Reviewer" })).toHaveFocus();
  });

  it("groups, filters and collapses agents without losing configuration", () => {
    render(
      createElement(AgentDirectory, {
        snapshot: directorySnapshot,
        config: directoryConfig,
        onNavigate: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "provider" } });
    expect(screen.getByRole("region", { name: "Pi" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Inspect / })).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Search agents"), {
      target: { value: "feature/frontend" },
    });
    expect(screen.getAllByRole("button", { name: /^Inspect / })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Reviewer" }));
    expect(
      within(screen.getByRole("complementary")).getByText("/worktrees/frontend/project"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: /All configured agents/ }));
    expect(screen.queryByRole("button", { name: "Inspect Reviewer" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "not found" } });
    expect(screen.getByText("No matching agents")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "team" } });
    expect(screen.getAllByRole("button", { name: /^Inspect / })).toHaveLength(2);
  });

  it("shows ordered prompt sources, role restrictions, and separate provider file modes", () => {
    const config = structuredClone(directoryConfig);
    config.integrations.pi!.providerFiles = {
      mcp: { mode: "append", paths: ["providers/mcp.json"] },
    };
    config.groups.frontend!.agents.reviewer!.providerFiles = {
      mcp: { mode: "disabled", paths: [] },
    };
    render(
      createElement(AgentDirectory, { snapshot: directorySnapshot, config, onNavigate: vi.fn() }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect Reviewer" }));
    const inspector = within(screen.getByRole("complementary"));
    expect(
      inspector.getByText("Read-only role restrictions take precedence over autonomous grants."),
    ).toBeVisible();
    expect(inspector.getByText("agent-model")).toBeVisible();
    expect(inspector.getByText("Unrestricted")).toBeVisible();
    fireEvent.click(inspector.getByRole("button", { name: "Prompt layers" }));
    const composition = inspector.getByRole("region", { name: "Prompt composition" });
    expect(within(composition).getByText("6 sources")).toBeInTheDocument();
    expect(composition.querySelectorAll("ol > li")).toHaveLength(5);
    expect(within(composition).getByText("frontend.md")).toBeVisible();
    expect(inspector.getByRole("region", { name: "Provider MCP files" })).toHaveTextContent(
      "Disabled",
    );
    expect(inspector.getByRole("region", { name: "Provider MCP files" })).toHaveTextContent(
      "providers/mcp.json",
    );
  });

  it("displays configured shared credentials without claiming login or autonomy", () => {
    const config = structuredClone(directoryConfig);
    config.integrations.pi!.providerState = { scope: "integration" };
    config.integrations.pi!.credentials = { kind: "broker-profile", profileId: "shared-pi" };
    delete config.integrations.pi!.executionProfile;
    render(
      createElement(AgentDirectory, { snapshot: directorySnapshot, config, onNavigate: vi.fn() }),
    );
    const stateSection = screen.getByRole("region", { name: "Provider state and credentials" });
    expect(stateSection).toHaveTextContent("Shared by agents using this integration");
    expect(stateSection).toHaveTextContent("Broker profile: shared-pi");
    expect(stateSection).toHaveTextContent(".nanasa/integrations/state/integrations/pi");
    const execution = screen.getByRole("region", { name: "Execution configuration" });
    expect(execution).toHaveTextContent("None configured");
    expect(execution).not.toHaveTextContent("Autonomous");
  });

  it("clears an inspector for a removed agent and handles an empty directory", () => {
    const onNavigate = vi.fn();
    const view = render(
      createElement(AgentDirectory, {
        snapshot: directorySnapshot,
        config: directoryConfig,
        onNavigate,
      }),
    );
    const snapshot = structuredClone(directorySnapshot);
    snapshot.memberships = [];
    view.rerender(createElement(AgentDirectory, { snapshot, config: directoryConfig, onNavigate }));
    expect(screen.getByText("No agents configured")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});
