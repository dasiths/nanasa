import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { TeamRecoveryResults } from "./team-recovery-results.js";

const recoveryResult = {
  groupId: "group-backend",
  dryRun: true,
  outcomes: [
    {
      runId: "run-builder",
      generation: 1,
      memberId: "builder",
      providerId: "copilot",
      previousSnapshotDigest: "a".repeat(64),
      currentSnapshotDigest: "b".repeat(64),
      status: "restarted" as const,
    },
  ],
};

it("opens accessible recovery details, runs actions, and returns focus on Escape", async () => {
  const user = userEvent.setup();
  const onRecover = vi.fn();
  const onApproveAndRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <TeamRecoveryResults
      recoveryResult={recoveryResult}
      counts={{ kept: 0, restarted: 1, approval: 1, failed: 0 }}
      agentNames={new Map([["builder", "Builder"]])}
      pendingApprovalCount={1}
      recovering={false}
      approving={false}
      onRecover={onRecover}
      onApproveAndRetry={onApproveAndRetry}
      onReview={vi.fn()}
      onDismiss={onDismiss}
    />,
  );

  const trigger = screen.getByRole("button", { name: "View results" });
  expect(
    screen.getByText("2 agents checked. 1 agent would restart and 1 agent needs review."),
  ).toBeVisible();
  await user.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "Team recovery preview" });
  expect(within(dialog).getByRole("heading", { name: "Agent outcomes" })).toBeVisible();
  expect(within(dialog).getByText("Builder")).toBeVisible();
  expect(within(dialog).getByText("a".repeat(64))).not.toBeVisible();
  await user.click(within(dialog).getByText("Technical details"));
  expect(within(dialog).getByText("a".repeat(64))).toBeVisible();

  await user.click(within(dialog).getByRole("button", { name: "Approve and retry 1 agent" }));
  await user.click(within(dialog).getByRole("button", { name: "Recover team" }));
  expect(onApproveAndRetry).toHaveBeenCalledOnce();
  expect(onRecover).toHaveBeenCalledOnce();

  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();

  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Close team recovery preview" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();

  await user.click(trigger);
  fireEvent.click(screen.getByRole("dialog", { name: "Team recovery preview" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "Dismiss recovery results" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});
