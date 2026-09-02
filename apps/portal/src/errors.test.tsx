import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorNotice, portalErrorFromCode } from "./errors.js";

describe("ErrorNotice", () => {
  it("shows friendly runtime copy and keeps diagnostics in a closed disclosure", () => {
    render(
      <ErrorNotice
        error={{
          ...portalErrorFromCode("provider_command_unrecognized", "The agent runtime failed."),
          details: {
            snapshotDigest: "f4f70f6142ce9598ce625c0ab66ad08f833d32a7696875160ce689df642e46",
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        "The agent could not start because its configured command is not supported by the active provider.",
      ),
    ).toBeInTheDocument();
    const code = screen.getByText("provider_command_unrecognized");
    expect(code.closest("details")).not.toHaveAttribute("open");
    expect(code.closest("details")).toHaveTextContent(
      "f4f70f6142ce9598ce625c0ab66ad08f833d32a7696875160ce689df642e46",
    );
  });
});
