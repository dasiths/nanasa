import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { PortalRoutePanel } from "./portal-route-panels.js";

const service = {
  formatVersion: 1,
  repositoryId: "repo-fixture",
  instanceName: "nanasa-aaaaaaaaaaaaaaaaaaaa",
  unitName: "nanasa-aaaaaaaaaaaaaaaaaaaa.service",
  repositoryRoot: "/repo",
  packageRoot: "/package",
  nodePath: "/usr/bin/node",
  cliPath: "/package/bin/nanasa.js",
  portalUrl: "http://127.0.0.1:3210",
  state: "ready",
  detail: "Service is ready",
  killMode: "process",
} as const;

function props(destination: "service" | "remote", client: PortalClient) {
  return {
    route: { kind: "global", destination } as const,
    snapshot: { groups: [] },
    config: {},
    members: [],
    client,
    preferences: {},
    commands: [],
    onNavigate: vi.fn(),
    onOpenCheckouts: vi.fn(),
    onRefresh: vi.fn(),
    onPatchPreferences: vi.fn(),
  } as unknown as Parameters<typeof PortalRoutePanel>[0];
}

describe("service and remote route panels", () => {
  it("loads shared lifecycle descriptors and renders continuity boundaries", async () => {
    const client = {
      loadServiceStatus: vi.fn().mockResolvedValue(service),
      planServiceRestart: vi.fn().mockResolvedValue({
        version: 1,
        type: "service.restart",
        reason: "operator-restart",
        instanceId: "instance-fixture",
        retryAfterMs: 1_000,
        resnapshotRequired: true,
        terminalHandoff: false,
      }),
      loadRemoteStatus: vi.fn().mockResolvedValue({
        formatVersion: 1,
        repositoryId: "repo-fixture",
        instanceId: "instance-fixture",
        build: { packageVersion: "0.1.0-next.11.0", commit: "a".repeat(40) },
        apiVersion: 1,
        eventProtocolVersion: 1,
        terminalProtocolVersion: 1,
        service: {
          instanceName: service.instanceName,
          unitName: service.unitName,
          state: "ready",
        },
        loopbackHost: "127.0.0.1",
        port: 3210,
      }),
    } as unknown as PortalClient;

    const view = render(<PortalRoutePanel {...props("service", client)} />);
    expect(await screen.findByText("Service is ready")).toBeInTheDocument();
    expect(
      screen.getByText("tmux processes survive; terminal WebSockets reconnect"),
    ).toBeInTheDocument();
    screen.getByRole("button", { name: "Preview planned restart" }).click();
    expect(
      await screen.findByText(/resnapshot required, PTY handoff disabled/),
    ).toBeInTheDocument();

    view.rerender(<PortalRoutePanel {...props("remote", client)} />);
    await waitFor(() => expect(client.loadRemoteStatus).toHaveBeenCalled());
    expect(await screen.findByText("0.1.0-next.11.0")).toBeInTheDocument();
    expect(screen.getByText(/Direct portal exposure/)).toBeInTheDocument();
  });
});
