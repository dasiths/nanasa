import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { ExtensionsWorkspace } from "./extensions-workspace.js";

const permissions = [
  "provider-home:read-managed",
  "provider-home:write-owned",
  "runtime:launch-provider",
  "prompt:append",
  "mcp:register-nanasa",
  "reporter:status",
  "native-session:resume",
] as const;

const descriptor = {
  apiVersion: "nanasa.dev/provider-extension/v1" as const,
  kind: "ProviderExtension" as const,
  metadata: {
    id: "nanasa.copilot",
    name: "GitHub Copilot",
    version: "1.0.0",
    publisher: "Nanasa",
    description: "Built-in declarative provider package",
  },
  compatibility: { minNanasaVersion: "0.0.0", reporterProtocol: 2 as const },
  providers: [
    {
      id: "copilot",
      displayName: "GitHub Copilot",
      commandNames: ["copilot"],
      strategies: {
        adapter: "copilot-adapter-v1" as const,
        home: "copilot-home-v1" as const,
        prompt: "copilot-agent-v1" as const,
        mcp: "copilot-mcp-v1" as const,
        reporter: "copilot-hooks-v2" as const,
        control: "copilot-terminal-v1" as const,
        nativeResume: "copilot-resume-v1" as const,
        provisioning: ["owned-file-v1" as const],
      },
    },
  ],
  permissions: [...permissions],
  assets: [],
};

const health = {
  extensionId: "nanasa.copilot",
  version: "1.0.0",
  state: "drifted" as const,
  checkedAt: "2026-08-30T00:00:00.000Z",
  diagnostics: [{ code: "extension_package_drift", message: "Owned asset digest changed" }],
  repairable: true,
  rollbackAvailable: true,
};

const catalog = {
  descriptor,
  source: { kind: "builtin" as const, name: "nanasa.copilot" },
  descriptorDigest: "a".repeat(64),
  packageDigest: "b".repeat(64),
  signatureState: "builtin" as const,
  installed: true,
  enabled: true,
  health,
};

const inspect = {
  catalog,
  plan: {
    extensionId: "nanasa.copilot",
    version: "1.0.0",
    planDigest: "c".repeat(64),
    configRevision: "d".repeat(64),
    lockRevision: 3,
    permissions: [...permissions],
    mutations: [
      {
        kind: "owned-file" as const,
        target: "provider-home:copilot",
        ownershipKey: "copilot:owned",
      },
    ],
    commands: [
      {
        integrationId: "copilot",
        executable: "copilot",
        argv: ["--model", "gpt"],
        cwd: "/repo",
        environmentNames: ["COPILOT_HOME", "NANASA_STATUS_URL"],
      },
    ],
    impactedAgents: ["builder"],
    requiresStoppedRuns: true,
  },
};

function client(): PortalClient {
  return {
    listProviderExtensions: vi.fn().mockResolvedValue([catalog]),
    inspectProviderExtension: vi.fn().mockResolvedValue(inspect),
    trustProviderExtension: vi.fn().mockResolvedValue({}),
    repairProviderExtension: vi.fn().mockResolvedValue(inspect),
    rollbackProviderExtension: vi.fn().mockResolvedValue(inspect),
    disableProviderExtension: vi.fn().mockResolvedValue(inspect),
    removeProviderExtension: vi.fn().mockResolvedValue(catalog),
  } as unknown as PortalClient;
}

describe("ExtensionsWorkspace", () => {
  const alternate = {
    ...catalog,
    descriptor: {
      ...descriptor,
      metadata: { ...descriptor.metadata, id: "nanasa.alternate", name: "Alternate Provider" },
    },
  };
  const alternateInspect = {
    ...inspect,
    catalog: alternate,
    plan: { ...inspect.plan, extensionId: "nanasa.alternate", planDigest: "e".repeat(64) },
  };

  it.each(["resolve", "reject"] as const)(
    "ignores an older inspection that later %ss",
    async (outcome) => {
      const portal = client();
      const user = userEvent.setup();
      let resolveOld!: (value: typeof inspect) => void;
      let rejectOld!: (reason: Error) => void;
      const older = new Promise<typeof inspect>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      vi.mocked(portal.listProviderExtensions).mockResolvedValue([catalog, alternate]);
      vi.mocked(portal.inspectProviderExtension).mockImplementation((id) =>
        id === "nanasa.copilot" ? older : Promise.resolve(alternateInspect),
      );
      render(<ExtensionsWorkspace client={portal} revision={1} onChanged={vi.fn()} />);
      await waitFor(() =>
        expect(portal.inspectProviderExtension).toHaveBeenCalledWith("nanasa.copilot"),
      );
      await user.click(screen.getByRole("button", { name: /Alternate Provider/ }));
      await screen.findByRole("heading", { name: "Alternate Provider" });
      await act(async () => {
        if (outcome === "resolve") resolveOld(inspect);
        else rejectOld(new Error("stale inspection failure"));
      });
      expect(screen.getByRole("heading", { name: "Alternate Provider" })).toBeVisible();
      expect(screen.queryByText("stale inspection failure")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Approve exact plan" }));
      expect(portal.trustProviderExtension).toHaveBeenCalledWith("nanasa.alternate", {
        planDigest: alternateInspect.plan.planDigest,
        configRevision: alternateInspect.plan.configRevision,
      });
    },
  );

  it("removes the old actionable plan while the next inspection fails", async () => {
    const portal = client();
    const user = userEvent.setup();
    let rejectNext!: (reason: Error) => void;
    vi.mocked(portal.listProviderExtensions).mockResolvedValue([catalog, alternate]);
    vi.mocked(portal.inspectProviderExtension).mockImplementation((id) =>
      id === "nanasa.copilot"
        ? Promise.resolve(inspect)
        : new Promise((resolve, reject) => {
            rejectNext = reject;
          }),
    );
    render(<ExtensionsWorkspace client={portal} revision={1} onChanged={vi.fn()} />);
    await screen.findByRole("heading", { name: "GitHub Copilot" });
    await user.click(screen.getByRole("button", { name: /Alternate Provider/ }));
    expect(screen.queryByRole("button", { name: "Approve exact plan" })).not.toBeInTheDocument();
    await act(async () => rejectNext(new Error("inspection unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("inspection unavailable");
    expect(screen.queryByRole("button", { name: "Approve exact plan" })).not.toBeInTheDocument();
    expect(portal.trustProviderExtension).not.toHaveBeenCalled();
  });

  it("does not replace a newer selection when an older catalog refresh completes", async () => {
    const portal = client();
    const user = userEvent.setup();
    let resolveRefresh!: (items: (typeof catalog)[]) => void;
    vi.mocked(portal.listProviderExtensions)
      .mockResolvedValueOnce([catalog, alternate])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    vi.mocked(portal.inspectProviderExtension).mockImplementation(async (id) =>
      id === "nanasa.copilot" ? inspect : alternateInspect,
    );
    const view = render(<ExtensionsWorkspace client={portal} revision={1} onChanged={vi.fn()} />);
    await screen.findByRole("heading", { name: "GitHub Copilot" });
    view.rerender(<ExtensionsWorkspace client={portal} revision={2} onChanged={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Alternate Provider/ }));
    await screen.findByRole("heading", { name: "Alternate Provider" });
    await act(async () => resolveRefresh([catalog]));
    expect(screen.getByRole("heading", { name: "Alternate Provider" })).toBeVisible();
    expect(portal.inspectProviderExtension).toHaveBeenCalledTimes(2);
  });

  it("previews permissions and drift and exposes trust, repair, rollback, and confirmed removal", async () => {
    const portal = client();
    const user = userEvent.setup();
    render(<ExtensionsWorkspace client={portal} revision={1} onChanged={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "GitHub Copilot" })).toBeVisible();
    expect(screen.getByText("extension_package_drift")).toBeVisible();
    expect(screen.getByText("runtime:launch-provider")).toBeVisible();
    expect(screen.getByText("copilot --model gpt")).toBeVisible();
    expect(screen.getByText(/environment names COPILOT_HOME, NANASA_STATUS_URL/)).toBeVisible();

    const approve = screen.getByRole("button", { name: "Approve exact plan" });
    expect(approve).toHaveAccessibleDescription(
      /Approve the displayed package, permissions, commands, and managed changes/,
    );
    await user.click(approve);
    await waitFor(() => expect(portal.trustProviderExtension).toHaveBeenCalled());
    const repair = screen.getByRole("button", { name: "Repair owned state" });
    expect(repair).toHaveAccessibleDescription(/without changing authentication, sessions/);
    await user.click(repair);
    await waitFor(() => expect(portal.repairProviderExtension).toHaveBeenCalled());
    const rollback = screen.getByRole("button", { name: "Rollback" });
    expect(rollback).toHaveAccessibleDescription(
      "Restore the previous verified extension generation.",
    );
    await user.click(rollback);
    await waitFor(() => expect(portal.rollbackProviderExtension).toHaveBeenCalled());

    const remove = screen.getByRole("button", { name: "Remove from Nanasa" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription("Type nanasa.copilot above to enable removal.");
    await user.type(screen.getByLabelText(/Type nanasa.copilot to confirm/), "nanasa.copilot");
    expect(remove).toBeEnabled();
    expect(remove).toHaveAccessibleDescription(
      /retaining provider state, authentication, sessions/,
    );
  });
});
