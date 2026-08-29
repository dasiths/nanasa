import { describe, expect, it } from "vitest";

import { validateMcpStartupConfiguration } from "../src/index.js";
import { assertLoopbackControlHost } from "../src/authority-policy.js";

const operatorToken = "configured-remote-operator-token-1234567890";

describe("MCP startup configuration", () => {
  it("rejects non-loopback control-plane listeners in every mode", () => {
    expect(() => assertLoopbackControlHost("0.0.0.0")).toThrow("must remain loopback");
    expect(() => assertLoopbackControlHost("::")).toThrow("must remain loopback");
    expect(() => assertLoopbackControlHost("127.0.0.1")).not.toThrow();
    expect(() => assertLoopbackControlHost("::1")).not.toThrow();
  });

  it("requires Nanasa itself to listen on loopback whenever MCP is enabled", () => {
    expect(() =>
      validateMcpStartupConfiguration({
        enabled: true,
        listenHost: "0.0.0.0",
        endpointUrl: "https://nanasa.example/mcp",
        operatorToken,
      }),
    ).toThrow("NANASA_HOST must remain loopback");
  });

  it("allows local HTTP and external HTTPS advertised through a loopback proxy target", () => {
    expect(() =>
      validateMcpStartupConfiguration({
        enabled: true,
        listenHost: "127.0.0.1",
        endpointUrl: "http://127.0.0.1:3210/mcp",
      }),
    ).not.toThrow();
    expect(() =>
      validateMcpStartupConfiguration({
        enabled: true,
        listenHost: "::1",
        endpointUrl: "https://nanasa.example/mcp",
        operatorToken,
      }),
    ).not.toThrow();
  });

  it("rejects insecure external URLs and weak or missing external operator tokens", () => {
    expect(() =>
      validateMcpStartupConfiguration({
        enabled: true,
        listenHost: "127.0.0.1",
        endpointUrl: "http://nanasa.example/mcp",
        operatorToken,
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      validateMcpStartupConfiguration({
        enabled: true,
        listenHost: "127.0.0.1",
        endpointUrl: "https://nanasa.example/mcp",
      }),
    ).toThrow("NANASA_MCP_OPERATOR_TOKEN is required");
    expect(() =>
      validateMcpStartupConfiguration({
        enabled: true,
        listenHost: "127.0.0.1",
        endpointUrl: "https://nanasa.example/mcp",
        operatorToken: "too-short",
      }),
    ).toThrow("at least 32 characters");
  });
});
