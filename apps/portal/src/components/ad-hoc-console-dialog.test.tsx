import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { PortalClient } from "../api.js";
import { AdHocConsoleDialog } from "./ad-hoc-console-dialog.js";

describe("AdHocConsoleDialog", () => {
  it("opens a ready terminal and deletes the console when closed", async () => {
    const client = {
      createConsole: vi.fn().mockResolvedValue({ id: "console-one", runId: "console-run" }),
      closeConsole: vi.fn().mockResolvedValue(undefined),
      getTerminalEndpointStatus: vi.fn().mockResolvedValue({
        runId: "console-run",
        provider: "ttyd",
        state: "ready",
        url: "/terminals/0123456789abcdef0123456789abcdef/",
      }),
    } as unknown as PortalClient;

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? <AdHocConsoleDialog client={client} onClose={() => setOpen(false)} /> : null;
    }

    const user = userEvent.setup();
    render(<Harness />);

    expect(await screen.findByTitle("Ad hoc console terminal")).toHaveAttribute(
      "src",
      "/terminals/0123456789abcdef0123456789abcdef/",
    );
    expect(client.createConsole).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Close console" }));
    await waitFor(() => expect(client.closeConsole).toHaveBeenCalledWith("console-one"));
    expect(screen.queryByRole("dialog", { name: "Console" })).not.toBeInTheDocument();
  });

  it("replaces a console session when its route is lost", async () => {
    const client = {
      createConsole: vi
        .fn()
        .mockResolvedValueOnce({ id: "console-stale", runId: "console-stale" })
        .mockResolvedValueOnce({ id: "console-fresh", runId: "console-fresh" }),
      closeConsole: vi.fn().mockResolvedValue(undefined),
      getTerminalEndpointStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error("Route not found"))
        .mockResolvedValue({
          runId: "console-fresh",
          provider: "ttyd",
          state: "ready",
          url: "/terminals/0123456789abcdef0123456789abcdef/",
        }),
    } as unknown as PortalClient;
    const user = userEvent.setup();
    render(<AdHocConsoleDialog client={client} onClose={vi.fn()} />);

    expect(await screen.findByText("Route not found")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByTitle("Ad hoc console terminal")).toBeVisible();
    expect(client.createConsole).toHaveBeenCalledTimes(2);
    expect(client.closeConsole).toHaveBeenCalledWith("console-stale");
  });
});
