import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NanasaConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NanasaStore } from "../src/store.js";
import { TerminalReadService } from "../src/terminal/terminal-read-service.js";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function setup(enabled: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-checkpoints-"));
  directories.push(directory);
  const config = NanasaConfigSchema.parse({
    version: 2,
    repository: { path: ".", checkout: { kind: "current" } },
    terminal: {
      checkpoints: {
        enabled,
        maxLines: 2,
        maxBytes: 8,
        retentionSeconds: 60,
        sensitivity: "repository-private",
      },
    },
    integrations: {},
    extensions: {},
    roles: {},
    groups: {},
    messages: { retentionPerGroup: 1000 },
    instructions: [],
  });
  const store = new NanasaStore(join(directory, "state.sqlite"), { config });
  const group = store.createGroup({ name: "Checkpoint" });
  const profile = store.createInternalAgentProfile({
    name: "Fixture",
    agentType: "pi",
    kind: "pi",
    command: "cat",
    args: [],
    environment: {},
  });
  store.addMembership(group.id, {
    memberId: "fixture",
    agentProfileId: profile.id,
    alias: "Fixture",
  });
  const run = store.createRun({
    id: "run-checkpoint",
    groupId: group.id,
    memberId: "fixture",
    agentProfileId: profile.id,
    generation: 1,
    status: "running",
    terminal: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
    startedAt: "2026-08-29T00:00:00.000Z",
  });
  let now = new Date("2026-08-29T00:00:00.000Z");
  const runtime = {
    readTerminal: vi.fn(async () => ({
      runId: run.id,
      generation: 1,
      binding: run.terminal!,
      source: "history" as const,
      text: "line-two",
      lineCount: 1,
      byteCount: 8,
      truncated: true,
      alternateScreen: false,
      capturedAt: now.toISOString(),
    })),
  };
  const service = new TerminalReadService(
    store,
    runtime as never,
    join(directory, "checkpoints"),
    config.terminal.checkpoints,
    () => now,
  );
  return {
    store,
    run,
    service,
    runtime,
    setNow: (value: Date) => {
      now = value;
    },
  };
}

describe("TerminalReadService checkpoints", () => {
  it("is disabled by default policy", async () => {
    const { service, store, run } = setup(false);
    await expect(service.captureCheckpoint("owner-one", run.id, 1)).rejects.toThrow(/disabled/i);
    store.close();
  });

  it("enforces owner-only retrieval, exact generation, bounds, expiry, deletion, and no PTY replay", async () => {
    const { service, store, run, runtime, setNow } = setup(true);
    await expect(service.captureCheckpoint("owner-one", run.id, 2)).rejects.toThrow(/generation/i);
    const checkpoint = await service.captureCheckpoint("owner-one", run.id, 1);
    expect(checkpoint).toMatchObject({
      ownerPrincipalId: "owner-one",
      lineCount: 1,
      byteCount: 8,
      truncated: true,
    });
    expect(service.retrieve("owner-one", checkpoint.id).text).toBe("line-two");
    expect(() => service.retrieve("owner-two", checkpoint.id)).toThrow(/not found/i);
    expect(runtime.readTerminal).toHaveBeenCalledTimes(1);
    expect(runtime).not.toHaveProperty("write");
    setNow(new Date("2026-08-29T00:02:00.000Z"));
    expect(() => service.retrieve("owner-one", checkpoint.id)).toThrow(/expired/i);
    expect(service.expire()).toBe(1);
    expect(service.list("owner-one")).toEqual([]);
    store.close();
  });
});
