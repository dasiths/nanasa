import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { SystemStatusDialog } from "./system-status-dialog.js";

describe("SystemStatusDialog", () => {
  it("presents reconnecting as an amber warning rather than an issue", async () => {
    const client = {
      loadConfigStatus: vi.fn().mockResolvedValue({
        state: "ready",
        repoRoot: "/repo",
        configPath: "/repo/.nanasa/config.yaml",
        revision: "a".repeat(64),
        diagnostics: [],
      }),
      loadServiceStatus: vi.fn().mockResolvedValue({
        state: "not-installed",
        detail: "Project-local service is not installed",
        unitName: "nanasa-aaaaaaaaaaaaaaaaaaaa.service",
      }),
      loadRemoteStatus: vi.fn().mockResolvedValue({
        build: { packageVersion: "0.1.0" },
        loopbackHost: "127.0.0.1",
        port: 3210,
      }),
    } as unknown as PortalClient;

    render(
      <SystemStatusDialog
        open
        client={client}
        snapshot={{ daemonEpoch: 3, sequence: 42 } as never}
        config={{ terminal: { checkpoints: { enabled: false } } } as never}
        connectionStatus="reconnecting"
        onClose={vi.fn()}
      />,
    );

    const summary = (await screen.findByText("Reconnecting")).closest(".system-status-clear");
    expect(summary).toHaveClass("system-status-reconnecting");
    expect(screen.getByText("The portal is restoring its event connection.")).toBeInTheDocument();
    expect(screen.getByText("Retrying")).toHaveClass("system-status-warning");
    expect(screen.queryByText("Review required")).not.toBeInTheDocument();
  });
});
