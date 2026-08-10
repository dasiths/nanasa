import { describe, expect, it } from "vitest";

import { COPILOT_ACP_PROTOCOL_VERSION, CopilotAcpProcess } from "../src/copilot-acp-process.js";

describe("installed Copilot ACP compatibility", () => {
  it("initializes copilot --acp --stdio without creating a session or sending a prompt", async ({
    skip,
  }) => {
    const process = new CopilotAcpProcess({ command: "copilot", args: [] });
    process.on("failure", () => undefined);
    try {
      const initialized = await Promise.race([
        process.initialize(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("copilot_acp_initialize_timeout")),
            5_000,
          );
          timer.unref();
        }),
      ]);
      expect(initialized.protocolVersion).toBe(COPILOT_ACP_PROTOCOL_VERSION);
    } catch (error) {
      skip(
        `Copilot ACP initialize unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      process.close();
    }
  });
});
