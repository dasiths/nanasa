import { NanasaConfigSchema, PortalSnapshotSchema } from "@nanasa/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
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
const config = NanasaConfigSchema.parse({ version: 2, integrations: {} });

function client(overrides: Partial<PortalClient> = {}): PortalClient {
  return {
    createWorktree: vi.fn(),
    openCheckout: vi.fn(),
    removeWorktree: vi.fn(),
    assignCheckout: vi.fn(),
    ...overrides,
  } as PortalClient;
}

describe("CheckoutWorkspace", () => {
  it("submits branch and base through the managed-worktree route", async () => {
    const user = userEvent.setup();
    const portal = client({ createWorktree: vi.fn().mockResolvedValue({}) });
    const changed = vi.fn().mockResolvedValue(undefined);
    render(
      <CheckoutWorkspace client={portal} snapshot={snapshot} config={config} onChanged={changed} />,
    );
    await user.type(screen.getByLabelText("New branch"), "feature/new");
    await user.click(screen.getByRole("button", { name: "Create managed worktree" }));
    await waitFor(() =>
      expect(portal.createWorktree).toHaveBeenCalledWith({
        sourceCheckoutId: checkout.id,
        branch: "feature/new",
        base: "HEAD",
        assignAgentIds: [],
      }),
    );
    expect(changed).toHaveBeenCalledOnce();
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
        config={config}
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
});
