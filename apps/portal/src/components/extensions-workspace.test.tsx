import { render, screen, waitFor } from "@testing-library/react";
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
