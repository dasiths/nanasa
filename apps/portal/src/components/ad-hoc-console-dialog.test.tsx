import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PortalClient } from "../api.js";
import { AdHocConsoleDialog } from "./ad-hoc-console-dialog.js";

vi.mock("../terminal/terminal-console.js", () => ({
  TerminalConsole: ({ label }: { label: string }) => <div data-testid="console-xterm">{label}</div>,
}));

it("opens the ad hoc console in the shared owned terminal and cleans it up", async () => {
  const closeConsole = vi.fn().mockResolvedValue(undefined);
  const client = {
    createConsole: vi
      .fn()
      .mockResolvedValue({ id: "console-one", runId: "console-one", generation: 1 }),
    closeConsole,
    getTerminalEndpointStatus: vi.fn().mockResolvedValue({
      runId: "console-one",
      provider: "nanasa-terminal.v1",
      state: "ready",
      streamUrl: "/api/v1/terminal-stream/console-one",
      protocol: "nanasa-terminal.v1",
      limits: {
        maxFrameBytes: 262144,
        maxInputBytes: 65536,
        maxPasteBytes: 196608,
        maxOutputQueueBytes: 1048576,
        maxViewers: 4,
        maxObservers: 3,
        maxReadLines: 5000,
        maxReadBytes: 1048576,
        heartbeatMs: 5000,
        leaseMs: 15000,
        reconnectHistoryFrames: 256,
      },
      observers: 0,
    }),
  } as unknown as PortalClient;
  const { unmount } = render(<AdHocConsoleDialog client={client} onClose={vi.fn()} />);
  expect(await screen.findByTestId("console-xterm")).toHaveTextContent("Ad hoc console terminal");
  unmount();
  await waitFor(() => expect(closeConsole).toHaveBeenCalledWith("console-one"));
});
