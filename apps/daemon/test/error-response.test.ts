import { describe, expect, it } from "vitest";
import { toPublicErrorResponse } from "../src/http/error-response.js";
import { DomainError } from "../src/store.js";

describe("public error responses", () => {
  it("preserves provider diagnostics behind a user-facing launch error", () => {
    const response = toPublicErrorResponse(
      new DomainError(
        "provider_command_unrecognized",
        "The configured command is not supported by the active provider",
        409,
        {
          configuredCommand: ["unsupported-agent"],
          snapshotDigest: "f4f70f6142ce9598ce625c0ab66ad08f833d32a7696875160ce689df642e46",
        },
      ),
    );

    expect(response).toEqual({
      statusCode: 409,
      payload: {
        message: "The configured command is not supported by the active provider",
        details: {
          configuredCommand: ["unsupported-agent"],
          snapshotDigest: "f4f70f6142ce9598ce625c0ab66ad08f833d32a7696875160ce689df642e46",
        },
        code: "provider_command_unrecognized",
      },
    });
  });
});
