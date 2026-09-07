import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { parse, stringify } from "yaml";
import type { PackageAcceptanceService } from "../test/acceptance/fixtures/package-fixture.js";
import { captureComparisonWorkflows } from "./portal-comparison-workflows.js";

const [oldSource, newSource, outputArgument] = process.argv.slice(2);
if (!oldSource || !newSource || !outputArgument)
  throw new Error(
    "Usage: node --import tsx scripts/capture-portal-comparison.ts OLD_SOURCE NEW_SOURCE OUTPUT",
  );
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const captures: Array<{ version: string; state: string; theme: string; file: string }> = [];
const browserErrors: Array<{ version: string; message: string }> = [];
const gaps: Array<{ version: string; state: string; error: string }> = [];
const versions: Array<{ version: string; commit: string; teams: number; agents: number }> = [];
const browser = await chromium.launch({ headless: true });

async function seed(service: PackageAcceptanceService) {
  await service.stopDaemon();
  const configPath = join(service.configRoot, ".nanasa/config.yaml");
  const config = parse(readFileSync(configPath, "utf8"));
  config.instructions = [".nanasa/instructions/global.md"];
  config.roles = {
    manager: {
      name: "Manager",
      permissionPolicy: "inherit",
      instructions: [".nanasa/instructions/manager.md"],
      presentation: { icon: "clipboard-list", color: "teal" },
    },
    engineer: {
      name: "Engineer",
      permissionPolicy: "inherit",
      instructions: [".nanasa/instructions/engineer.md"],
      presentation: { icon: "hammer", color: "blue" },
    },
    reviewer: {
      name: "Reviewer",
      permissionPolicy: "inherit",
      instructions: [".nanasa/instructions/reviewer.md"],
      presentation: { icon: "shield-check", color: "amber" },
    },
  };
  mkdirSync(join(service.configRoot, ".nanasa/instructions"), { recursive: true });
  for (const name of [
    "global",
    "manager",
    "engineer",
    "reviewer",
    "backend",
    "frontend",
    "platform",
  ]) {
    writeFileSync(
      join(service.configRoot, `.nanasa/instructions/${name}.md`),
      `# ${name}\nUse the assigned workspace. Coordinate changes with the team and report results.\n`,
    );
  }
  config.groups = Object.fromEntries(
    ["backend", "frontend", "platform"].map((team, order) => [
      team,
      {
        name: `${team[0]!.toUpperCase()}${team.slice(1)} Team`,
        order,
        instructions: [`.nanasa/instructions/${team}.md`],
        agents: Object.fromEntries(
          ["manager", "engineer", "reviewer"].map((role, index) => [
            `${team}-${role}`,
            {
              memberId: `${team}-${role}`,
              name: `${team[0]!.toUpperCase()}${team.slice(1)} ${role[0]!.toUpperCase()}${role.slice(1)}`,
              integrationId: "echo",
              roleId: role,
              instructions: [],
              order: index,
            },
          ]),
        ),
      },
    ]),
  );
  writeFileSync(configPath, stringify(config));
  execFileSync("git", [
    "-C",
    service.repository,
    "add",
    ".nanasa/config.yaml",
    ".nanasa/instructions",
  ]);
  execFileSync("git", [
    "-C",
    service.repository,
    "-c",
    "user.name=Nanasa Comparison",
    "-c",
    "user.email=comparison@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Seed three matching comparison teams",
  ]);
  await service.startDaemon();
  const primary = (await service.snapshot()).checkouts.find(
    (checkout) => checkout.kind === "primary",
  )!;
  const worktree = await service.request<{ checkout: { id: string } }>("/api/v1/worktrees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceCheckoutId: primary.id,
      branch: "feature/frontend",
      base: "HEAD",
    }),
  });
  await service.request("/api/v1/groups/frontend/checkout", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkoutId: worktree.checkout.id,
      expectedCheckoutRevision: 0,
      switchPolicy: "require-stopped",
    }),
  });
  await service.startAll("backend");
  await service.startAll("frontend");
  const snapshot = await service.snapshot();
  expect(snapshot.groups).toHaveLength(3);
  expect(snapshot.memberships).toHaveLength(9);
  for (const run of snapshot.runs.filter((run) => run.status === "running"))
    await service.waitForTerminalReady(run.id);
  await expect
    .poll(
      async () => {
        const current = await service.request<{ agentStatuses: Array<{ state: string }> }>(
          "/api/v1/snapshot",
        );
        return current.agentStatuses.some((status) => status.state === "starting");
      },
      { timeout: 20_000 },
    )
    .toBe(false);
  for (const [intent, text] of [
    [
      "inform",
      "Backend scope: implement the account API and keep compatibility with the frontend contract.",
    ],
    ["request", "Review the account API change, run the focused tests, and report any blockers."],
    ["inform", "The test fixture is ready. Keep the current workspace binding for this review."],
  ]) {
    await service.request("/api/v1/groups/backend/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent,
        sender: { kind: "operator", operatorId: "comparison" },
        audience: { kind: "dm", memberId: "backend-engineer" },
        body: { contentType: "text/markdown", text },
        delivery: {},
      }),
    });
  }
  await expect
    .poll(
      async () => {
        const messages = await service.request<{ deliveryOutcomes: Array<{ status: string }> }>(
          "/api/v1/groups/backend/messages",
        );
        return messages.deliveryOutcomes.filter((item) => item.status === "terminal_injected")
          .length;
      },
      { timeout: 20_000 },
    )
    .toBe(3);
  const manager = snapshot.runs.find((run) => run.memberId === "backend-manager")!;
  const pid = execFileSync(
    "tmux",
    [
      "-L",
      service.tmuxServer,
      "display-message",
      "-p",
      "-t",
      manager.terminal!.paneId,
      "#{pane_pid}",
    ],
    { encoding: "utf8" },
  ).trim();
  const environment = Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf("=");
        return [item.slice(0, separator), item.slice(separator + 1)];
      }),
  );
  execFileSync(environment.BROWSER!, ["https://example.invalid/review?team=backend"], {
    env: { ...process.env, ...environment },
  });
}

try {
  for (const [version, source] of [
    ["old", oldSource],
    ["new", newSource],
  ] as const) {
    const { PackageAcceptanceService: Service } = (await import(
      pathToFileURL(resolve(source, "test/acceptance/fixtures/package-fixture.ts")).href
    )) as { PackageAcceptanceService: typeof PackageAcceptanceService };
    const service = await Service.create(`comparison-${version}`);
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      locale: "en-GB",
      timezoneId: "UTC",
      colorScheme: "dark",
    });
    try {
      await seed(service);
      const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      versions.push({ version, commit, teams: 3, agents: 9 });
      await context.addInitScript(() => {
        if (localStorage.getItem("nanasa.portal.preferences.v2") === null)
          localStorage.setItem(
            "nanasa.portal.preferences.v2",
            JSON.stringify({ version: 2, theme: "dark" }),
          );
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => browserErrors.push({ version, message: error.message }));
      await page.goto(`${service.baseUrl}/agents${new URL(service.portalUrl).hash}`);
      await expect(
        page.getByRole("article").getByRole("heading", { name: "All agents", exact: true }),
      ).toBeVisible();
      const navigate = async (path: string) => {
        await page.goto(`${service.baseUrl}${path}`);
        await expect(page.locator(".workspace h1")).toBeVisible();
        await expect(
          page
            .locator(
              ":is(.route-surface, .terminal-workspace, .message-route, .terminal-empty):visible",
            )
            .first(),
        ).toBeVisible();
        await expect(page.locator(".workspace")).not.toContainText("Loading workspace...");
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        const advisory = page
          .locator(".restart-advisory-banner")
          .getByRole("button", { name: "Dismiss", exact: true });
        if (await advisory.isVisible()) await advisory.click();
        if (path === "/groups/backend/terminals") {
          const panes = page.locator(".terminal-pane-slot:not([hidden])");
          await expect(panes).toHaveCount(3);
          for (const pane of await panes.all()) {
            await expect(pane.locator(".terminal-lease-status")).toContainText("connected");
            await expect(pane.locator(".xterm-screen")).toContainText(/SAFE_ECHO(?:_READY)?:/);
          }
        }
      };
      for (const theme of ["dark", "light"] as const) {
        await navigate("/settings");
        if (version === "old")
          await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(theme);
        else
          await page
            .getByRole("group", { name: "Theme", exact: true })
            .getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true })
            .click();
        await expect
          .poll(() =>
            page.evaluate(
              () => JSON.parse(localStorage.getItem("nanasa.portal.preferences.v2") ?? "{}").theme,
            ),
          )
          .toBe(theme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const capture = async (state: string) => {
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise<void>((resolveFrame) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
            );
          });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${version} ${state} overflow`,
          ).toBe(true);
          const file = `${version}-${state}-${theme}.png`;
          await page.screenshot({ path: join(output, file), fullPage: false });
          captures.push({ version, state, theme, file });
          console.log(`${version}: captured ${file}`);
        };
        await navigate("/agents");
        await expect(
          page.getByRole("button", { name: "Inspect Backend Engineer", exact: true }),
        ).toBeVisible();
        if (version === "old")
          await page.getByRole("button", { name: "Close inspector", exact: true }).click();
        await capture("agents");
        await page.getByRole("button", { name: "Inspect Backend Engineer", exact: true }).click();
        await capture("agent-configuration");
        if (theme === "dark") {
          await page
            .getByRole("complementary", { name: "Agent configuration" })
            .getByRole("button", { name: "Prompt layers", exact: true })
            .click();
          await capture("agent-prompts");
        }
        if (version === "new") {
          await navigate("/teams");
          await expect(
            page.getByRole("button", { name: "Inspect team Backend Team", exact: true }),
          ).toBeVisible();
          await capture("teams-directory");
        }
        await navigate("/groups/backend/terminals");
        await expect(page.locator(".terminal-lease-status")).toHaveCount(3);
        for (const status of await page.locator(".terminal-lease-status").all())
          await expect(status).toContainText("connected");
        await expect(page.locator(".xterm-screen").first()).toContainText("SAFE_ECHO_READY:");
        await capture("terminal-grid");
        await page
          .getByRole("button", { name: "Focus Backend Engineer terminal", exact: true })
          .click();
        await capture("terminal-focused");
        await navigate("/groups/backend/messages");
        await expect(page.getByRole("region", { name: "Message history" })).toContainText(
          "The test fixture is ready.",
        );
        await capture("messages");
        await navigate("/attention");
        await expect(
          page.getByText("Backend Manager wants to open a URL", { exact: true }),
        ).toBeVisible();
        await capture("attention");
        await navigate("/checkouts");
        await expect(
          page.getByRole("button", { name: "Add workspace", exact: true }),
        ).toBeVisible();
        await expect(page.locator(".checkout-workspace")).toContainText("feature/frontend");
        await capture("workspaces");
        await navigate("/extensions");
        await expect(page.getByRole("button", { name: /OpenCode/ }).first()).toBeVisible();
        await page
          .getByRole("button", { name: /OpenCode/ })
          .first()
          .click();
        await expect(page.getByRole("heading", { name: "OpenCode", exact: true })).toBeVisible();
        await expect(page.locator(".extension-detail")).toBeVisible();
        await capture("provider-overview");
        for (const route of ["settings", "diagnostics", "service", "remote", "help", "release"]) {
          await navigate(`/${route}`);
          await expect(page.getByRole("article")).not.toContainText("loading");
          await capture(route);
          if (route === "diagnostics") {
            await page
              .getByRole("heading", { name: "Terminal checkpoints", exact: true })
              .scrollIntoViewIfNeeded();
            await capture("diagnostics-checkpoints");
          }
        }
        if (theme === "dark")
          gaps.push(
            ...(await captureComparisonWorkflows({ page, version, service, navigate, capture })),
          );
      }
    } finally {
      await context.close();
      await service.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        versions,
        captures,
        browserErrors,
        gaps,
      },
      null,
      2,
    ) + "\n",
  );
}
