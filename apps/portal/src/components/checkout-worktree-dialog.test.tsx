import { PortalSnapshotSchema } from "@nanasa/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type PortalClient } from "../api.js";
import { CheckoutWorkspace } from "./checkout-workspace.js";

const timestamp = "2026-08-29T12:00:00.000Z";
const repository = {
  id: "repo_one",
  commonDirectory: "/repos/one/.git",
  displayName: "one",
  objectFormat: "sha1" as const,
  refStorage: "files" as const,
  primaryCheckoutId: "checkout_main",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const checkout = {
  id: "checkout_main",
  repositoryId: repository.id,
  checkoutKey: "a".repeat(64),
  path: "/repos/one",
  gitDirectory: "/repos/one/.git",
  kind: "primary" as const,
  head: "b".repeat(40),
  branch: "main",
  dirty: false,
  observedAt: timestamp,
};
const managedCheckout = {
  ...checkout,
  id: "checkout_feature",
  checkoutKey: "c".repeat(64),
  path: "/repos/worktrees/feature",
  gitDirectory: "/repos/one/.git/worktrees/feature",
  kind: "linked" as const,
  branch: "feature/one",
  dirty: true,
};
const worktree = {
  id: "worktree_one",
  repositoryId: repository.id,
  checkoutId: managedCheckout.id,
  sourceCheckoutId: checkout.id,
  path: managedCheckout.path,
  branch: "feature/one",
  base: "HEAD",
  provenanceToken: "d".repeat(64),
  operationGeneration: 2,
  state: "ready" as const,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const snapshot = PortalSnapshotSchema.parse({
  instanceId: "daemon_one",
  daemonEpoch: 1,
  sequence: 1,
  generatedAt: timestamp,
  orderRevision: 0,
  groups: [],
  agentProfiles: [],
  memberships: [],
  runs: [],
  repositories: [repository],
  checkouts: [checkout, managedCheckout],
  worktrees: [worktree],
  messages: [],
  deliveryOutcomes: [],
});
const teamSnapshot = PortalSnapshotSchema.parse({
  ...snapshot,
  groups: [
    {
      id: "team_one",
      name: "Team One",
      order: 0,
      membershipRevision: 1,
      checkoutRevision: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  memberships: [
    {
      id: "agent_one",
      groupId: "team_one",
      memberId: "member_one",
      agentProfileId: "profile_one",
      alias: "Agent One",
      order: 0,
      state: "active",
      joinedAt: timestamp,
    },
  ],
  runs: [
    {
      id: "run_old",
      groupId: "team_one",
      memberId: "member_one",
      agentProfileId: "profile_one",
      checkoutId: checkout.id,
      generation: 1,
      status: "stopped",
      desiredState: "running",
      recoveryPhase: "idle",
      startedAt: timestamp,
      stoppedAt: timestamp,
    },
    {
      id: "run_one",
      groupId: "team_one",
      memberId: "member_one",
      agentProfileId: "profile_one",
      checkoutId: checkout.id,
      generation: 2,
      status: "running",
      desiredState: "running",
      recoveryPhase: "idle",
      startedAt: timestamp,
    },
  ],
});
function client(overrides: Partial<PortalClient> = {}): PortalClient {
  return {
    createWorktree: vi.fn(),
    openCheckout: vi.fn(),
    removeWorktree: vi.fn(),
    assignCheckout: vi.fn(),
    refreshCheckout: vi.fn(),
    listCheckoutReferences: vi.fn().mockResolvedValue([]),
    fetchCheckout: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as PortalClient;
}

describe("CheckoutWorkspace", () => {
  it("fetches explicitly and loads refreshed base suggestions without fetching on dialog open", async () => {
    const user = userEvent.setup();
    const portal = client({
      listCheckoutReferences: vi.fn().mockResolvedValue([
        { name: "main", kind: "branch" },
        { name: "origin/frontend", kind: "remote" },
        { name: "v1.0", kind: "tag" },
      ]),
      fetchCheckout: vi.fn().mockResolvedValue([
        {
          checkoutId: checkout.id,
          head: checkout.head,
          branch: "main",
          detached: false,
          staged: 0,
          modified: 0,
          untracked: 0,
          ahead: 1,
          behind: 2,
          observedAt: timestamp,
        },
      ]),
      createWorktree: vi.fn().mockResolvedValue({}),
    });
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<CheckoutWorkspace client={portal} snapshot={snapshot} onChanged={changed} />);
    expect(portal.fetchCheckout).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Fetch updates" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(portal.fetchCheckout).toHaveBeenCalledWith(checkout.id);
    expect(screen.getByText(/1 ahead.*2 behind/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add workspace" }));
    await waitFor(() => expect(portal.listCheckoutReferences).toHaveBeenCalledWith(checkout.id));
    const input = screen.getByLabelText("Start from");
    const list = document.getElementById(input.getAttribute("list")!);
    expect(list?.querySelector('option[value="HEAD"]')).not.toBeNull();
    expect(list?.querySelector('option[value="origin/frontend"]')).not.toBeNull();
    expect(list?.querySelector('option[value="v1.0"]')).not.toBeNull();
    await user.type(screen.getByLabelText("New branch"), "feature/ui");
    await user.clear(input);
    await user.type(input, "origin/frontend");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() =>
      expect(portal.createWorktree).toHaveBeenCalledWith({
        sourceCheckoutId: checkout.id,
        branch: "feature/ui",
        base: "origin/frontend",
      }),
    );
    expect(portal.fetchCheckout).toHaveBeenCalledOnce();
  });

  it("keeps manual revisions usable after fetch and suggestion failures", async () => {
    const user = userEvent.setup();
    const portal = client({
      listCheckoutReferences: vi.fn().mockRejectedValue(new Error("refs unavailable")),
      fetchCheckout: vi
        .fn()
        .mockRejectedValue(new ApiError("Remote authentication failed", 502, "git_command_failed")),
      createWorktree: vi.fn().mockResolvedValue({}),
    });
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<CheckoutWorkspace client={portal} snapshot={snapshot} onChanged={changed} />);
    await user.click(screen.getByRole("button", { name: "Fetch updates" }));
    expect(await screen.findByText("Remote authentication failed")).toBeVisible();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Fetch updates" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Add workspace" }));
    expect(await screen.findByText("Revision suggestions unavailable")).toBeVisible();
    const input = screen.getByLabelText("Start from");
    await user.clear(input);
    await user.type(input, "HEAD~2");
    await user.type(screen.getByLabelText("New branch"), "feature/manual");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() =>
      expect(portal.createWorktree).toHaveBeenCalledWith({
        sourceCheckoutId: checkout.id,
        branch: "feature/manual",
        base: "HEAD~2",
      }),
    );
  });

  it("submits branch and base through the managed-worktree route", async () => {
    const user = userEvent.setup();
    const portal = client({ createWorktree: vi.fn().mockResolvedValue({}) });
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<CheckoutWorkspace client={portal} snapshot={snapshot} onChanged={changed} />);
    expect(screen.queryByRole("dialog", { name: "Add workspace" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add workspace" }));
    expect(screen.getByRole("dialog", { name: "Add workspace" })).toBeVisible();
    await user.type(screen.getByLabelText("New branch"), "feature/new");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() =>
      expect(portal.createWorktree).toHaveBeenCalledWith({
        sourceCheckoutId: checkout.id,
        branch: "feature/new",
        base: "HEAD",
      }),
    );
    expect(changed).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Add workspace" })).not.toBeInTheDocument();
  });

  it("requires a second explicit action after a dirty removal response", async () => {
    const user = userEvent.setup();
    const removeWorktree = vi
      .fn()
      .mockRejectedValueOnce(new Error("dirty worktree requires force"))
      .mockResolvedValueOnce({});
    const portal = client({ removeWorktree });
    render(
      <CheckoutWorkspace
        client={portal}
        snapshot={snapshot}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove worktree feature/one" }));
    const confirmation = await screen.findByRole("button", { name: "Confirm force remove" });
    expect(removeWorktree).toHaveBeenLastCalledWith(worktree.id, {
      force: false,
      expectedOperationGeneration: worktree.operationGeneration,
    });
    await user.click(confirmation);
    await waitFor(() =>
      expect(removeWorktree).toHaveBeenLastCalledWith(worktree.id, {
        force: true,
        expectedOperationGeneration: worktree.operationGeneration,
      }),
    );
  });

  it("reviews and restarts a running team when its workspace changes", async () => {
    const user = userEvent.setup();
    const assignCheckout = vi.fn().mockResolvedValue({});
    const portal = client({ assignCheckout });
    render(
      <CheckoutWorkspace
        client={portal}
        snapshot={teamSnapshot}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const primaryFact = screen.getByText("Primary").closest(".workspace-fact");
    const tooltipId = primaryFact?.getAttribute("aria-describedby");
    expect(tooltipId).toBeTruthy();
    expect(document.getElementById(tooltipId!)).toHaveTextContent(
      "The repository's main working tree. Multiple teams may use it.",
    );
    expect(screen.getByText("1 active agent")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Workspace for Team One"), managedCheckout.id);
    const dialog = screen.getByRole("dialog", { name: "Change Team One workspace" });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveTextContent("1 active agent");
    await user.click(screen.getByRole("button", { name: "Stop, switch, and restart" }));

    await waitFor(() =>
      expect(assignCheckout).toHaveBeenCalledWith("team_one", {
        checkoutId: managedCheckout.id,
        expectedCheckoutRevision: 3,
        switchPolicy: "stop-switch-restart",
      }),
    );
  });
});
