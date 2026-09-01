import { describe, expect, it } from "vitest";
import { ProviderCompilerSupervisor } from "../src/providers/provider-compiler-supervisor.js";

describe("provider compiler sandbox supervision", () => {
  it("fails closed when required Linux namespaces are unavailable", async () => {
    const supervisor = new ProviderCompilerSupervisor({ mode: "sandboxed" });
    const status = supervisor.probe();
    expect(["available", "namespace-unavailable", "binary-unavailable"]).toContain(status.code);
    if (status.available) return;
    await expect(
      supervisor.compile({ executable: "/bin/cat", args: [], input: { value: true } }),
    ).rejects.toThrow(/sandbox is unavailable/);
  });

  it("validates direct-exec and bounded request inputs before spawning", async () => {
    const supervisor = new ProviderCompilerSupervisor({
      mode: "sandboxed",
      probe: () => ({ available: true, code: "available" }),
      sandboxPath: "/missing/bwrap",
    });
    await expect(
      supervisor.compile({ executable: "relative-compiler", args: [], input: {} }),
    ).rejects.toThrow(/absolute read-only system path/);
    await expect(
      supervisor.compile({ executable: "/bin/cat", args: [], input: "x".repeat(1_048_577) }),
    ).rejects.toThrow(/frame limit/);
    await expect(
      supervisor.compile({ executable: "/bin/cat", args: [], input: {}, timeoutMs: 10 }),
    ).rejects.toThrow(/timeout/);
  });

  it("defaults to manual compilation without spawning a sandbox", async () => {
    const supervisor = new ProviderCompilerSupervisor();
    expect(supervisor.probe()).toEqual({
      available: false,
      code: "manual-compilation-required",
    });
    await expect(
      supervisor.compile({ executable: "/bin/cat", args: [], input: { value: true } }),
    ).rejects.toThrow(/compile outside Nanasa/);
  });

  it("accepts sandboxed mode from the process environment", () => {
    const supervisor = new ProviderCompilerSupervisor({
      environment: { NANASA_PROVIDER_COMPILER_MODE: "sandboxed" },
      probe: () => ({ available: true, code: "available" }),
    });
    expect(supervisor.probe()).toEqual({ available: true, code: "available" });
  });
});
