import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectContext, snapshotFreshness } from "./project-context.js";

afterEach(cleanup);

describe("project context", () => {
  it("keeps project identity separate from connection and opens the existing status view", async () => {
    const open = vi.fn();
    render(
      <ProjectContext
        name="nanasa"
        source="multi-coding-agents"
        connectionStatus="connected"
        receivedAt={Date.now()}
        onOpenStatus={open}
      />,
    );
    expect(screen.getByText("Project: nanasa")).toBeVisible();
    expect(screen.getByText("multi-coding-agents")).toBeVisible();
    expect(screen.getByText("Updated just now")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "System connected, open System status" }),
    );
    expect(open).toHaveBeenCalledOnce();
  });
  it("does not equate a healthy event stream with fresh snapshot data", () => {
    render(
      <ProjectContext
        name="nanasa"
        connectionStatus="connected"
        receivedAt={Date.now() - 45000}
        onOpenStatus={() => undefined}
      />,
    );
    expect(screen.getByText("Updates stale")).toBeVisible();
    expect(screen.getByText("Updated 45s ago")).toBeVisible();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });
  it("shows snapshot failures without claiming the event connection is lost", () => {
    render(
      <ProjectContext
        name="nanasa"
        connectionStatus="connected"
        snapshotFailed
        receivedAt={Date.now()}
        onOpenStatus={() => undefined}
      />,
    );
    expect(screen.getByText("Updates stale")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "System connected, open System status" }),
    ).toBeEnabled();
  });
  it("retains freshness information while reconnecting", () => {
    render(
      <ProjectContext
        name="nanasa"
        connectionStatus="reconnecting"
        receivedAt={Date.now() - 60000}
        onOpenStatus={() => undefined}
      />,
    );
    expect(screen.getByText("Reconnecting")).toBeVisible();
    expect(screen.getByText("Updated 1m ago")).toBeVisible();
  });
  it("handles missing and future timestamps", () => {
    expect(snapshotFreshness(undefined, 1000)).toBe("Awaiting snapshot");
    expect(snapshotFreshness(2000, 1000)).toBe("Updated just now");
  });
});
