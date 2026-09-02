import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NanasaConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchoredDirectory } from "../src/anchored-directory.js";
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
    config,
    directory,
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

  it("reopens an on-disk checkpoint after runtime loss without replaying bytes into a PTY", async () => {
    const { config, directory, service, store, run } = setup(true);
    const checkpoint = await service.captureCheckpoint("owner-one", run.id, run.generation);
    store.close();

    const reopenedStore = new NanasaStore(join(directory, "state.sqlite"), { config });
    const unavailableRuntime = {
      readTerminal: vi.fn(async () => {
        throw new Error("tmux unavailable");
      }),
      pasteToRun: vi.fn(async () => {
        throw new Error("PTY replay forbidden");
      }),
    };
    const reopened = new TerminalReadService(
      reopenedStore,
      unavailableRuntime as never,
      join(directory, "checkpoints"),
      config.terminal.checkpoints,
      () => new Date("2026-08-29T00:00:30.000Z"),
    );

    expect(reopened.retrieve("owner-one", checkpoint.id)).toMatchObject({
      checkpoint: {
        runId: run.id,
        generation: run.generation,
        ownerPrincipalId: "owner-one",
      },
      text: "line-two",
    });
    expect(() => reopened.retrieve("owner-two", checkpoint.id)).toThrow(/not found/i);
    expect(reopened.list("owner-one")).toEqual([
      expect.objectContaining({ id: checkpoint.id, generation: run.generation }),
    ]);
    expect(unavailableRuntime.readTerminal).not.toHaveBeenCalled();
    expect(unavailableRuntime.pasteToRun).not.toHaveBeenCalled();
    reopenedStore.close();
  });

  it("rejects tampered, over-permissive, symlinked, and non-regular checkpoint storage", async () => {
    const { directory, service, store, run } = setup(true);
    const checkpoint = await service.captureCheckpoint("owner-one", run.id, run.generation);
    const original = readFileSync(checkpoint.storageReference);

    writeFileSync(checkpoint.storageReference, "tampered", { mode: 0o600 });
    expect(() => service.retrieve("owner-one", checkpoint.id)).toThrow(/content identity/i);

    writeFileSync(checkpoint.storageReference, original, { mode: 0o600 });
    chmodSync(checkpoint.storageReference, 0o640);
    expect(() => service.retrieve("owner-one", checkpoint.id)).toThrow(/unavailable or unsafe/i);

    chmodSync(checkpoint.storageReference, 0o600);
    const target = join(directory, "attacker-controlled.txt");
    writeFileSync(target, original, { mode: 0o600 });
    unlinkSync(checkpoint.storageReference);
    symlinkSync(target, checkpoint.storageReference);
    expect(() => service.retrieve("owner-one", checkpoint.id)).toThrow(/unavailable or unsafe/i);

    unlinkSync(checkpoint.storageReference);
    mkdirSync(checkpoint.storageReference, { mode: 0o700 });
    expect(() => service.retrieve("owner-one", checkpoint.id)).toThrow(/unavailable or unsafe/i);
    store.close();
  });

  it("rejects a symlink root and a checkpoint-root replacement attack", async () => {
    const root = mkdtempSync(join(tmpdir(), "nanasa-checkpoint-root-"));
    directories.push(root);
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    const link = join(root, "link");
    symlinkSync(target, link);
    const { store, run, config } = setup(true);
    expect(
      () => new TerminalReadService(store, {} as never, link, config.terminal.checkpoints),
    ).toThrow(/non-symlink directory/);

    const owned = join(root, "owned");
    const service = new TerminalReadService(
      store,
      {
        readTerminal: vi.fn(async () => ({
          runId: run.id,
          generation: run.generation,
          binding: run.terminal!,
          source: "history" as const,
          text: "safe",
          lineCount: 1,
          byteCount: 4,
          truncated: false,
          alternateScreen: false,
          capturedAt: "2026-08-29T00:00:00.000Z",
        })),
      } as never,
      owned,
      config.terminal.checkpoints,
    );
    const checkpoint = await service.captureCheckpoint("owner-one", run.id, run.generation);
    renameSync(owned, `${owned}-original`);
    mkdirSync(owned, { mode: 0o700 });
    expect(() => service.retrieve("owner-one", checkpoint.id)).toThrow(/unavailable or unsafe/i);
    store.close();
  });

  it("retains an owner-only zero-byte tombstone when checkpoint persistence fails", async () => {
    const { directory, service, store, run } = setup(true);
    vi.spyOn(store, "saveTerminalCheckpoint").mockImplementation(() => {
      throw new Error("injected persistence failure");
    });

    await expect(service.captureCheckpoint("owner-one", run.id, run.generation)).rejects.toThrow(
      /injected persistence failure/,
    );
    expect(store.listTerminalCheckpoints("owner-one")).toEqual([]);
    const checkpointRoot = join(directory, "checkpoints");
    const tombstones = readdirSync(checkpointRoot);
    expect(tombstones).toHaveLength(1);
    const tombstone = statSync(join(checkpointRoot, tombstones[0]!), { bigint: true });
    expect(tombstone.size).toBe(0n);
    expect(tombstone.mode & 0o777n).toBe(0o600n);
    store.close();
  });

  it("destroys the verified inode when its original basename is replaced", async () => {
    const { config, directory, store, run, runtime } = setup(true);
    const checkpointRoot = join(directory, "race-checkpoints");
    let checkpointPath = "";
    let displacedPath = "";
    const service = new TerminalReadService(
      store,
      runtime as never,
      checkpointRoot,
      config.terminal.checkpoints,
      () => new Date("2026-08-29T00:00:00.000Z"),
      (path) =>
        new AnchoredDirectory(path, 0o700, {
          afterFinalValidation: () => {
            displacedPath = `${checkpointPath}.displaced`;
            renameSync(checkpointPath, displacedPath);
            writeFileSync(checkpointPath, "substitute", { mode: 0o600 });
          },
        }),
    );
    const checkpoint = await service.captureCheckpoint("owner-one", run.id, run.generation);
    checkpointPath = checkpoint.storageReference;

    expect(service.delete("owner-one", checkpoint.id)).toBe(true);
    expect(store.listTerminalCheckpoints("owner-one")).toEqual([]);
    expect(existsSync(checkpointPath)).toBe(false);
    expect(readFileSync(displacedPath, "utf8")).toBe("");
    const quarantine = readdirSync(checkpointRoot).find((name) =>
      name.startsWith(".nanasa-quarantine-"),
    );
    expect(quarantine).toBeDefined();
    expect(readFileSync(join(checkpointRoot, quarantine!), "utf8")).toBe("substitute");
    store.close();
  });

  it("never follows a symlink substituted after final validation", async () => {
    const { config, directory, store, run, runtime } = setup(true);
    const checkpointRoot = join(directory, "symlink-race-checkpoints");
    const attackerTarget = join(directory, "attacker-target.txt");
    writeFileSync(attackerTarget, "attacker-owned", { mode: 0o600 });
    let checkpointPath = "";
    const service = new TerminalReadService(
      store,
      runtime as never,
      checkpointRoot,
      config.terminal.checkpoints,
      () => new Date("2026-08-29T00:00:00.000Z"),
      (path) =>
        new AnchoredDirectory(path, 0o700, {
          afterFinalValidation: () => {
            renameSync(checkpointPath, `${checkpointPath}.displaced`);
            symlinkSync(attackerTarget, checkpointPath);
          },
        }),
    );
    const checkpoint = await service.captureCheckpoint("owner-one", run.id, run.generation);
    checkpointPath = checkpoint.storageReference;

    expect(service.delete("owner-one", checkpoint.id)).toBe(true);
    expect(readFileSync(attackerTarget, "utf8")).toBe("attacker-owned");
    expect(readFileSync(`${checkpointPath}.displaced`, "utf8")).toBe("");
    expect(store.listTerminalCheckpoints("owner-one")).toEqual([]);
    const quarantine = readdirSync(checkpointRoot).find((name) =>
      name.startsWith(".nanasa-quarantine-"),
    );
    expect(quarantine).toBeDefined();
    expect(readlinkSync(join(checkpointRoot, quarantine!))).toBe(attackerTarget);
    store.close();
  });

  it("never unlinks a substituted quarantine entry and audits verified-fd destruction", async () => {
    const { config, directory, store, run, runtime } = setup(true);
    const checkpointRoot = join(directory, "quarantine-race-checkpoints");
    let quarantinePath = "";
    let displacedPath = "";
    let quarantineMoved = false;
    const service = new TerminalReadService(
      store,
      runtime as never,
      checkpointRoot,
      config.terminal.checkpoints,
      () => new Date("2026-08-29T00:00:00.000Z"),
      (path) =>
        new AnchoredDirectory(path, 0o700, {
          afterQuarantineMove: (name, moved) => {
            quarantineMoved = moved;
            quarantinePath = join(checkpointRoot, name);
            displacedPath = `${quarantinePath}.verified-inode`;
            renameSync(quarantinePath, displacedPath);
            writeFileSync(quarantinePath, "replacement-must-survive", { mode: 0o600 });
          },
        }),
    );
    const checkpoint = await service.captureCheckpoint("owner-one", run.id, run.generation);
    const originalIdentity = statSync(checkpoint.storageReference, { bigint: true });

    expect(service.delete("owner-one", checkpoint.id)).toBe(true);
    expect(quarantineMoved).toBe(true);
    expect(readFileSync(quarantinePath, "utf8")).toBe("replacement-must-survive");
    const destroyed = statSync(displacedPath, { bigint: true });
    expect({ dev: destroyed.dev, ino: destroyed.ino, size: destroyed.size }).toEqual({
      dev: originalIdentity.dev,
      ino: originalIdentity.ino,
      size: 0n,
    });
    expect(
      readdirSync(checkpointRoot).some((name) =>
        readFileSync(join(checkpointRoot, name)).includes(Buffer.from("line-two")),
      ),
    ).toBe(false);
    expect(store.listTerminalCheckpoints("owner-one")).toEqual([]);
    store.close();

    const database = new DatabaseSync(join(directory, "state.sqlite"), { readOnly: true });
    const deletion = database
      .prepare(
        `SELECT checkpoint.deleted_at, checkpoint.deletion_audit_id,
                audit.action, audit.resource_id, audit.metadata_json
         FROM terminal_checkpoints AS checkpoint
         JOIN audits AS audit ON audit.id = checkpoint.deletion_audit_id
         WHERE checkpoint.id = ?`,
      )
      .get(checkpoint.id) as Record<string, unknown>;
    expect(deletion).toMatchObject({
      action: "terminal-checkpoint.delete",
      resource_id: checkpoint.id,
    });
    expect(deletion.deleted_at).toEqual(expect.any(String));
    expect(deletion.deletion_audit_id).toEqual(expect.any(String));
    expect(JSON.parse(String(deletion.metadata_json))).toEqual({
      contentDestroyed: true,
      reconciled: false,
    });
    database.close();

    const implementation = readFileSync(
      resolve(import.meta.dirname, "../src/anchored-directory.ts"),
      "utf8",
    );
    expect(implementation).not.toMatch(/\bunlink(?:Sync)?\b/);
  });

  it("reconciles deleted metadata and audit state after initial database failure", async () => {
    const { directory, service, store, run } = setup(true);
    const checkpoint = await service.captureCheckpoint("owner-one", run.id, run.generation);
    vi.spyOn(store, "deleteTerminalCheckpoint").mockImplementation(() => {
      throw new Error("injected database failure");
    });

    expect(service.delete("owner-one", checkpoint.id)).toBe(true);
    expect(store.listTerminalCheckpoints("owner-one")).toEqual([]);
    const checkpointRoot = join(directory, "checkpoints");
    const quarantine = readdirSync(checkpointRoot).find((name) =>
      name.startsWith(".nanasa-quarantine-"),
    );
    expect(quarantine).toBeDefined();
    expect(readFileSync(join(checkpointRoot, quarantine!), "utf8")).toBe("");
    store.close();

    const database = new DatabaseSync(join(directory, "state.sqlite"), { readOnly: true });
    const deletion = database
      .prepare(
        `SELECT checkpoint.deleted_at, audit.metadata_json
         FROM terminal_checkpoints AS checkpoint
         JOIN audits AS audit ON audit.id = checkpoint.deletion_audit_id
         WHERE checkpoint.id = ?`,
      )
      .get(checkpoint.id) as Record<string, unknown>;
    expect(deletion.deleted_at).toEqual(expect.any(String));
    expect(JSON.parse(String(deletion.metadata_json))).toEqual({
      contentDestroyed: true,
      reconciled: true,
    });
    database.close();
  });
});
it("anchors interleaved reads when the directory path is replaced", () => {
  const parent = mkdtempSync(join(tmpdir(), "nanasa-anchor-race-"));
  directories.push(parent);
  const root = join(parent, "checkpoints");
  const displaced = join(parent, "displaced");
  const name = "checkpoint.txt";
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, name), "anchored", { mode: 0o600 });
  const anchored = new AnchoredDirectory(root);

  anchored.withHandle((directory) => {
    renameSync(root, displaced);
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, name), "replacement", { mode: 0o600 });
    expect(directory.readFile(name).toString("utf8")).toBe("anchored");
  });

  expect(readFileSync(join(displaced, name), "utf8")).toBe("anchored");
  expect(readFileSync(join(root, name), "utf8")).toBe("replacement");
  expect(() => anchored.withHandle((directory) => directory.readFile(name))).toThrow(
    /identity changed/,
  );
});
