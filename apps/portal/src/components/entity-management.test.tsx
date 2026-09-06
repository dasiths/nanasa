import { AgentRunSchema, NanasaConfigSchema, PortalSnapshotSchema } from "@nanasa/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { agentDirectoryEntries } from "./agent-directory-model.js";
import {
  AgentSessionActions,
  EntityEditor,
  type EntityManagement,
  EntityManagementContext,
  entityRunAction,
} from "./entity-management.js";

const timestamp = "2026-09-05T12:00:00.000Z";
const config = NanasaConfigSchema.parse({
  version: 2,
  integrations: {
    pi: { id: "pi", name: "Pi", kind: "pi", command: ["pi"], commandSource: "builtin" },
  },
  groups: {
    team: {
      name: "Team",
      agents: { engineer: { memberId: "stable-engineer", name: "Engineer", integrationId: "pi" } },
    },
  },
});
const snapshot = PortalSnapshotSchema.parse({
  instanceId: "test",
  daemonEpoch: 1,
  sequence: 1,
  generatedAt: timestamp,
  groups: [
    { id: "team", name: "Team", membershipRevision: 1, createdAt: timestamp, updatedAt: timestamp },
  ],
  memberships: [
    {
      id: "membership-record",
      groupId: "team",
      memberId: "stable-engineer",
      agentProfileId: "engineer",
      alias: "Engineer",
      state: "active",
      joinedAt: timestamp,
    },
  ],
  repositories: [],
  checkouts: [],
  worktrees: [],
  agentProfiles: [],
  runs: [],
  messages: [],
  deliveryOutcomes: [],
});

function management(): EntityManagement {
  return {
    client: { updateAgent: vi.fn().mockResolvedValue({}) } as unknown as PortalClient,
    snapshot,
    config,
    refresh: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    recover: vi.fn(),
    setSubscription: vi.fn(),
    resetSubscriptions: vi.fn(),
    createTeam: vi.fn(),
    deleteTeam: vi.fn(),
  };
}

describe("entity management safeguards", () => {
  it("stops an active run with exhausted recovery before allowing a fresh start", async () => {
    const user = userEvent.setup();
    const context = management();
    const run = AgentRunSchema.parse({
      id: "failed-resume",
      groupId: "team",
      memberId: "stable-engineer",
      agentProfileId: "engineer",
      generation: 12,
      status: "running",
      desiredState: "running",
      recoveryPhase: "failed",
      recoveryAttempts: 3,
      recoveryReason: "recovery_attempts_exhausted",
      startedAt: timestamp,
    });
    const entry = agentDirectoryEntries({ ...snapshot, runs: [run] }, config)[0]!;
    expect(entityRunAction(run)).toBe("stop");
    const view = render(
      <EntityManagementContext.Provider value={context}>
        <AgentSessionActions entry={entry} />
      </EntityManagementContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Start agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move to another team" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop run" }));
    expect(context.stop).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("dialog", { name: "Stop Engineer?" })).getByRole("button", {
        name: "Stop run",
      }),
    );
    await waitFor(() => expect(context.stop).toHaveBeenCalledExactlyOnceWith("team", "engineer"));
    expect(context.start).not.toHaveBeenCalled();
    const stopped = agentDirectoryEntries(
      { ...snapshot, runs: [{ ...run, status: "stopped", desiredState: "stopped" }] },
      config,
    )[0]!;
    view.rerender(
      <EntityManagementContext.Provider value={context}>
        <AgentSessionActions entry={stopped} />
      </EntityManagementContext.Provider>,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Start agent" }));
    expect(context.start).toHaveBeenCalledExactlyOnceWith("team", "engineer");
    expect(context.recover).not.toHaveBeenCalled();
  });

  it("resolves distinct membership IDs and submits only changed configuration fields", async () => {
    const user = userEvent.setup();
    const context = management();
    const entry = agentDirectoryEntries(snapshot, config)[0]!;
    expect(entry.agentId).toBe("engineer");
    expect(entry.integration?.name).toBe("Pi");
    const close = vi.fn();
    render(
      <EntityManagementContext.Provider value={context}>
        <EntityEditor kind="agent" entry={entry} onClose={close} />
      </EntityManagementContext.Provider>,
    );
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Lead engineer");
    await user.click(screen.getByRole("button", { name: "Save agent" }));
    expect(context.client.updateAgent).toHaveBeenCalledWith("team", "engineer", {
      name: "Lead engineer",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("requires explicit discard before an outside navigation command", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(
      <EntityManagementContext.Provider value={management()}>
        <button type="button" onClick={navigate}>
          Open another team
        </button>
        <EntityEditor
          kind="agent"
          entry={agentDirectoryEntries(snapshot, config)[0]!}
          onClose={vi.fn()}
        />
      </EntityManagementContext.Provider>,
    );
    await user.type(screen.getByRole("textbox", { name: "Name" }), " draft");
    await user.click(screen.getByRole("button", { name: "Open another team" }));
    expect(navigate).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Engineer draft");
    await user.click(screen.getByRole("button", { name: "Open another team" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  });

  it.each(["reconciling", "resuming", "restarting"] as const)(
    "retains Stop while recovery is %s",
    (recoveryPhase) => {
      const run = AgentRunSchema.parse({
        id: "run",
        groupId: "team",
        memberId: "stable-engineer",
        agentProfileId: "engineer",
        generation: 1,
        status: "stopped",
        desiredState: "running",
        recoveryPhase,
        startedAt: timestamp,
      });
      expect(entityRunAction(run)).toBe("stop");
    },
  );

  it("offers retry after failed recovery", () => {
    const run = AgentRunSchema.parse({
      id: "run",
      groupId: "team",
      memberId: "stable-engineer",
      agentProfileId: "engineer",
      generation: 1,
      status: "failed",
      desiredState: "running",
      recoveryPhase: "failed",
      startedAt: timestamp,
    });
    expect(entityRunAction(run)).toBe("retry");
  });
});
