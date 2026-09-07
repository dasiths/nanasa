import { expect, type Page } from "@playwright/test";
import type { PackageAcceptanceService } from "../test/acceptance/fixtures/package-fixture.js";

export async function captureComparisonWorkflows({
  page,
  version,
  service,
  navigate,
  capture,
}: {
  page: Page;
  version: "old" | "new";
  service: PackageAcceptanceService;
  navigate(path: string): Promise<void>;
  capture(state: string): Promise<void>;
}) {
  const gaps: Array<{ version: string; state: string; error: string }> = [];
  const rowAction = async (entity: "group" | "agent", name: string, action: string) => {
    await page.getByRole("button", { name: `Actions for ${entity} ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
  };
  const team = async () => {
    await navigate(version === "old" ? "/groups/backend/terminals" : "/teams");
    if (version === "new")
      await page.getByRole("button", { name: "Inspect team Backend Team", exact: true }).click();
  };
  const agent = async () => {
    await navigate(version === "old" ? "/groups/backend/terminals" : "/groups/backend/members");
    if (version === "new")
      await page.getByRole("button", { name: "Inspect Backend Engineer", exact: true }).click();
  };
  const workspace = async () => {
    await navigate("/checkouts");
    if (version === "new")
      await page.getByRole("button", { name: "Inspect workspace main", exact: true }).click();
  };
  const provider = async () => {
    await navigate("/extensions");
    await page
      .getByRole("button", { name: /OpenCode/ })
      .first()
      .click();
    await expect(page.locator(".extension-detail")).toBeVisible();
  };
  const terminal = async () => {
    await navigate("/groups/backend/terminals");
    await page
      .getByRole("button", { name: "Focus Backend Engineer terminal", exact: true })
      .click();
    const pane = page.locator(".terminal-pane-slot:not([hidden])");
    await expect(pane.locator(".terminal-lease-status")).toContainText("connected");
    return pane;
  };
  const workflows: Array<[string, () => Promise<void>]> = [
    [
      "team-members",
      async () => {
        await navigate(version === "old" ? "/groups/backend/terminals" : "/groups/backend/members");
      },
    ],
    [
      "team-edit",
      async () => {
        await team();
        if (version === "old")
          await rowAction("group", "Backend Team", "Edit group settings Backend Team");
        else
          await page
            .getByRole("button", { name: "Edit group settings Backend Team", exact: true })
            .click();
      },
    ],
    [
      "team-create",
      async () => {
        await navigate(version === "old" ? "/groups/backend/terminals" : "/teams");
        await page.getByRole("button", { name: "Create group", exact: true }).click();
        await page.getByLabel("Group name", { exact: true }).fill("Data Team");
      },
    ],
    [
      "team-delete",
      async () => {
        await team();
        if (version === "old")
          await rowAction("group", "Backend Team", "Delete group Backend Team");
        else await page.getByRole("button", { name: "Delete group", exact: true }).click();
        await expect(
          page.getByRole("dialog", { name: "Delete Backend Team?", exact: true }),
        ).toBeVisible();
      },
    ],
    [
      "agent-create",
      async () => {
        await navigate("/groups/backend/terminals");
        await page.getByRole("button", { name: "Add agent to Backend Team", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Add agent", exact: true })
          .getByLabel("Name", { exact: true })
          .fill("Backend Security Reviewer");
      },
    ],
    [
      "agent-edit",
      async () => {
        await agent();
        if (version === "old")
          await rowAction("agent", "Backend Engineer", "Edit agent settings Backend Engineer");
        else
          await page
            .getByRole("button", { name: "Edit agent settings Backend Engineer", exact: true })
            .click();
      },
    ],
    [
      "agent-organize",
      async () => {
        await agent();
        if (version === "old")
          await page
            .getByRole("button", { name: "Actions for agent Backend Engineer", exact: true })
            .click();
        else {
          await page.getByRole("button", { name: "Close inspector", exact: true }).click();
          await page.getByRole("button", { name: "Organize agents", exact: true }).click();
        }
      },
    ],
    [
      "agent-remove",
      async () => {
        await agent();
        if (version === "old")
          await rowAction("agent", "Backend Engineer", "Remove agent Backend Engineer");
        else {
          await page.getByRole("button", { name: "Session", exact: true }).click();
          await page.getByRole("button", { name: "Remove agent", exact: true }).click();
        }
        await expect(
          page.getByRole("dialog", { name: "Remove Backend Engineer?", exact: true }),
        ).toBeVisible();
      },
    ],
    [
      "message-compose",
      async () => {
        await navigate("/groups/backend/messages");
        if (version === "old")
          await page.getByRole("button", { name: "Open message composer", exact: true }).click();
        await page
          .getByRole("textbox", { name: "Message body", exact: true })
          .fill("Review the API contract before the next implementation pass.");
      },
    ],
    [
      "message-delivery",
      async () => {
        await navigate("/groups/backend/messages");
        await expect(page.locator(".message-history-list > li")).toHaveCount(3);
        await page
          .locator(".message-history-list > li")
          .last()
          .getByRole("button", { name: /Sent to 1/ })
          .click();
      },
    ],
    [
      "message-clear",
      async () => {
        await navigate("/groups/backend/messages");
        await page.getByRole("button", { name: "Clear all message history", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
      },
    ],
    [
      "attention-url",
      async () => {
        await navigate("/attention");
        if (version === "old") await page.getByText("Full URL", { exact: true }).click();
        else
          await page
            .getByRole("button", {
              name: "Inspect Backend Manager wants to open a URL",
              exact: true,
            })
            .click();
        await expect(
          page.getByText("https://example.invalid/review?team=backend", { exact: true }),
        ).toBeVisible();
      },
    ],
    [
      "attention-selected",
      async () => {
        await navigate("/attention");
        await page
          .getByRole("checkbox", {
            name: "Select Backend Manager wants to open a URL",
            exact: true,
          })
          .check();
      },
    ],
    [
      "workspace-assignment",
      async () => {
        await workspace();
      },
    ],
    [
      "workspace-create",
      async () => {
        await navigate("/checkouts");
        await page.getByRole("button", { name: "Add workspace", exact: true }).click();
        await page.getByLabel("New branch", { exact: true }).fill("feature/platform");
        await page
          .getByRole("combobox", { name: "Assign to team", exact: true })
          .selectOption("platform");
      },
    ],
    [
      "workspace-error",
      async () => {
        await navigate("/checkouts");
        await page.getByRole("button", { name: "Add workspace", exact: true }).click();
        await page.getByLabel("New branch", { exact: true }).fill("invalid branch name");
        await page.getByRole("button", { name: "Create workspace", exact: true }).click();
        await expect(page.getByRole("alert")).toBeVisible();
      },
    ],
    [
      "workspace-maintenance",
      async () => {
        await navigate("/checkouts");
        if (version === "new") {
          await page
            .getByRole("button", { name: "Inspect workspace feature/frontend", exact: true })
            .click();
          await page.getByRole("button", { name: "Maintenance", exact: true }).click();
        }
        await expect(
          page.getByRole("button", { name: "Remove worktree feature/frontend", exact: true }),
        ).toBeDisabled();
      },
    ],
    [
      "workspace-attach",
      async () => {
        await navigate("/checkouts");
        await page.getByRole("button", { name: "Add workspace", exact: true }).click();
        await page.getByRole("button", { name: "Attach existing", exact: true }).click();
      },
    ],
    [
      "workspace-switch",
      async () => {
        await workspace();
        const linked = (await service.snapshot()).checkouts.find(
          (checkout) => checkout.branch === "feature/frontend",
        )!;
        await page
          .getByLabel("Workspace for Backend Team", { exact: true })
          .selectOption(linked.id);
        await expect(
          page.getByRole("dialog", { name: "Change Backend Team workspace", exact: true }),
        ).toBeVisible();
      },
    ],
    [
      "provider-plan",
      async () => {
        await provider();
        if (version === "new")
          await page.getByRole("button", { name: "Plan", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "Permission preview", exact: true }),
        ).toBeVisible();
      },
    ],
    [
      "provider-lifecycle",
      async () => {
        await provider();
        if (version === "new")
          await page.getByRole("button", { name: "Lifecycle", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Repair owned state", exact: true }),
        ).toBeVisible();
      },
    ],
    [
      "provider-removal",
      async () => {
        await provider();
        if (version === "new") {
          await page.getByRole("button", { name: "Lifecycle", exact: true }).click();
          await page.getByText("Remove provider", { exact: true }).click();
        }
        await page
          .getByLabel("Type nanasa.opencode to confirm", { exact: true })
          .fill("nanasa.opencode");
      },
    ],
    [
      "roles",
      async () => {
        await navigate("/settings");
        await page.getByRole("button", { name: "Edit role presentation", exact: true }).click();
        await expect(
          page.getByRole("dialog", { name: "Role presentation", exact: true }),
        ).toBeVisible();
      },
    ],
    [
      "more",
      async () => {
        await navigate("/groups/backend/terminals");
        await page.locator('summary[aria-label="Portal utilities"]').click();
      },
    ],
    [
      "commands",
      async () => {
        await navigate("/groups/backend/terminals");
        await page.getByRole("button", { name: "Open command palette", exact: true }).click();
        await expect(
          page.getByRole("dialog", { name: "Command palette", exact: true }),
        ).toBeVisible();
      },
    ],
    [
      "system-status",
      async () => {
        await navigate("/groups/backend/terminals");
        await page
          .getByRole("button", { name: "System connected, open System status", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", { name: "System status", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("dialog", { name: "System status", exact: true }),
        ).not.toContainText("Loading");
      },
    ],
    [
      "terminal-subscriptions",
      async () => {
        const pane = await terminal();
        await pane
          .getByRole("button", { name: /Configure Attention for Backend Engineer/ })
          .click();
        await expect(
          page.getByRole("dialog", {
            name: "Backend Engineer Attention subscriptions",
            exact: true,
          }),
        ).toBeVisible();
      },
    ],
    [
      "terminal-search",
      async () => {
        const pane = await terminal();
        await pane.getByRole("button", { name: "Search", exact: true }).click();
      },
    ],
    [
      "terminal-transcript",
      async () => {
        const pane = await terminal();
        await pane.getByRole("button", { name: "Transcript", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Terminal transcript", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("SAFE_ECHO:");
      },
    ],
    [
      "terminal-tools",
      async () => {
        const pane = await terminal();
        await pane.getByRole("button", { name: "More terminal actions", exact: true }).click();
      },
    ],
  ];
  for (const [state, open] of workflows) {
    try {
      await open();
      await capture(state);
      if (state === "agent-edit") {
        await page
          .getByRole("button", { name: "Save agent", exact: true })
          .scrollIntoViewIfNeeded();
        await capture("agent-edit-actions");
      }
      if (state === "provider-plan") {
        await page
          .getByRole("button", { name: "Approve exact plan", exact: true })
          .scrollIntoViewIfNeeded();
        await capture("provider-plan-approval");
      }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error)
        .split("Call log:")[0]!
        .slice(0, 600);
      gaps.push({ version, state, error: message });
      console.error(`${version}: workflow gap ${state}: ${message}`);
    }
  }
  return gaps;
}
