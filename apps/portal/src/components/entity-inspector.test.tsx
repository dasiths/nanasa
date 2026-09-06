import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { EntityInspector, EntitySection, EntityTabs } from "./entity-inspector.js";

function Example() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("Configuration");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Inspect Engineer
      </button>
      {open && (
        <EntityInspector title="Engineer" context="Backend" onClose={() => setOpen(false)}>
          <EntityTabs
            label="Engineer views"
            tabs={["Configuration", "Session"]}
            selected={tab}
            onSelect={setTab}
          />
          <EntitySection title={tab}>
            <p>Current {tab}</p>
          </EntitySection>
        </EntityInspector>
      )}
    </>
  );
}
describe("entity inspector", () => {
  it("focuses the entity, preserves context, switches views, and returns focus on close", async () => {
    const user = userEvent.setup();
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Inspect Engineer" });
    await user.click(trigger);
    expect(screen.getByRole("heading", { name: "Engineer" })).toHaveFocus();
    expect(screen.getByRole("complementary", { name: "Engineer" })).toHaveTextContent("Backend");
    await user.click(screen.getByRole("button", { name: "Session" }));
    expect(screen.getByText("Current Session")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});
