import { type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BuildIdentity, RemoteDescriptor } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ActivationArtifact, ActivationService } from "../src/release/activation-service.js";
import { BackupService } from "../src/release/backup-service.js";
import { MigrationCompatibilityError, MigrationRunner } from "../src/release/migration-runner.js";
import { assertCompatibleRemote } from "../src/remote/remote-descriptor.js";
import { buildRemoteSshPlan } from "../src/remote/remote-ssh.js";
import {
  type ServiceCommandRunner,
  SystemdUserService,
} from "../src/service/systemd-user-service.js";

const directories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function fixtureDirectory(name: string): string {
  const path = join(tmpdir(), `nanasa-phase11-${name}-${crypto.randomUUID()}`);
  mkdirSync(path, { recursive: true });
  directories.push(path);
  return path;
}

function build(commit = "a".repeat(40)): BuildIdentity {
  return {
    packageName: "nanasa",
    packageVersion: "0.1.0-next.11.0",
    channel: "next",
    commit,
    builtAt: "2026-08-30T00:00:00.000Z",
    databaseSchema: { minimum: 2, maximum: 2 },
    configVersion: 2,
    apiVersion: 1,
    eventProtocolVersion: 1,
    terminalProtocolVersion: 1,
    node: ">=22 <23 || >=24 <25",
    hosts: ["linux-x64", "linux-arm64"],
    tmux: ">=3.2",
    terminalHelper: { name: "node-pty", version: "1.1.0" },
    xterm: { name: "@xterm/xterm", version: "6.0.0" },
    browsers: ["chromium", "firefox", "webkit"],
    portalAssetDigest: digest("portal"),
  };
}

function createVersionOneDatabase(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL);
    INSERT INTO schema_metadata VALUES (1, 1);
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    PRAGMA user_version = 1;
  `);
  database.close();
}

function migration(path: string): MigrationRunner {
  return new MigrationRunner(path, 2, [
    {
      from: 1,
      to: 2,
      name: "add-value",
      apply(database) {
        database.exec("ALTER TABLE parent ADD COLUMN value TEXT");
      },
    },
  ]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("generic migration runner", () => {
  it("probes, preflights, applies, verifies, and reopens idempotently", () => {
    const path = join(fixtureDirectory("migration"), "state.sqlite");
    createVersionOneDatabase(path);
    expect(migration(path).probe().compatibility).toBe("upgrade-available");
    expect(migration(path).apply().compatibility).toBe("current");
    expect(migration(path).apply().integrity).toBe("ok");
    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(2);
    expect(
      (
        database.prepare("SELECT schema_version FROM schema_metadata").get() as {
          schema_version: number;
        }
      ).schema_version,
    ).toBe(2);
    database.close();
  });

  it("rolls back an interrupted migration without changing the schema", () => {
    const path = join(fixtureDirectory("interrupted-migration"), "state.sqlite");
    createVersionOneDatabase(path);
    const runner = new MigrationRunner(path, 2, [
      {
        from: 1,
        to: 2,
        name: "interrupted",
        apply(database) {
          database.exec("ALTER TABLE parent ADD COLUMN interrupted TEXT");
          throw new Error("fault injection");
        },
      },
    ]);
    expect(() => runner.apply()).toThrow("fault injection");
    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(1);
    expect(
      database
        .prepare("PRAGMA table_info(parent)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).not.toContain("interrupted");
    database.close();
  });

  it("refuses future schemas, missing paths, downgrades, and foreign-key corruption", () => {
    const root = fixtureDirectory("migration-refusal");
    const future = join(root, "future.sqlite");
    createVersionOneDatabase(future);
    const futureDatabase = new DatabaseSync(future);
    futureDatabase.exec("PRAGMA user_version = 3");
    futureDatabase.close();
    expect(() => migration(future).preflight()).toThrowError(MigrationCompatibilityError);

    const old = join(root, "old.sqlite");
    createVersionOneDatabase(old);
    expect(() => new MigrationRunner(old, 3, []).preflight()).toThrow(/No complete migration path/);
    expect(() => migration(future).assertRollbackCompatible(1)).toThrow(
      /restore a verified backup/,
    );

    const broken = join(root, "broken.sqlite");
    createVersionOneDatabase(broken);
    const brokenDatabase = new DatabaseSync(broken);
    brokenDatabase.exec("PRAGMA foreign_keys = OFF; INSERT INTO child VALUES (1, 999)");
    brokenDatabase.close();
    expect(() => migration(broken).preflight()).toThrow(/foreign-key verification failed/);
  });
});

describe("WAL-safe backup and verified restore", () => {
  it("captures package, schema, config, lock, overlays, hashes, and restores verified bytes", () => {
    const root = fixtureDirectory("backup");
    const database = join(root, "state.sqlite");
    createVersionOneDatabase(database);
    migration(database).apply();
    const config = join(root, "config.yaml");
    const lock = join(root, "extensions.lock.yaml");
    const overlay = join(root, "overlay.json");
    writeFileSync(config, "version: 2\n");
    writeFileSync(lock, "version: 1\nrevision: 0\nextensions: {}\n");
    writeFileSync(overlay, '{"revision":1}\n');
    const service = new BackupService();
    const backup = service.create(join(root, "backups"), {
      databasePath: database,
      configPath: config,
      extensionLockPath: lock,
      overlays: { fixture: overlay },
      build: build(),
      packageRoot: root,
    });
    expect(backup.manifest.databaseSchema).toBe(2);
    expect(backup.manifest.providerOverlayRevisions.fixture).toBe(
      digest(readFileSync(overlay, "utf8")),
    );
    writeFileSync(database, "corrupt");
    service.restore(backup.directory, database);
    expect(service.verify(backup.directory).backupId).toBe(backup.manifest.backupId);
  });

  it("refuses hash mismatch and leaves an existing destination unchanged", () => {
    const root = fixtureDirectory("backup-hash");
    const database = join(root, "state.sqlite");
    createVersionOneDatabase(database);
    migration(database).apply();
    const config = join(root, "config.yaml");
    const lock = join(root, "extensions.lock.yaml");
    writeFileSync(config, "version: 2\n");
    writeFileSync(lock, "version: 1\nrevision: 0\nextensions: {}\n");
    const service = new BackupService();
    const backup = service.create(join(root, "backups"), {
      databasePath: database,
      configPath: config,
      extensionLockPath: lock,
      overlays: {},
      build: build(),
      packageRoot: root,
    });
    writeFileSync(join(backup.directory, "config.yaml"), "tampered\n");
    expect(() => service.restore(backup.directory, database)).toThrow(/verification failed/);
    expect(existsSync(database)).toBe(true);
  });
});

describe("staged atomic activation", () => {
  function activationFixture() {
    const root = fixtureDirectory("activation");
    const ids: ActivationArtifact["id"][] = [
      "packagePointer",
      "database",
      "config",
      "extensionLock",
      "overlay:one",
    ];
    const artifacts = ids.map((id, index): ActivationArtifact => {
      const activePath = join(root, "active", `${index}.txt`);
      const candidatePath = join(root, "candidate", `${index}.txt`);
      mkdirSync(join(root, "active"), { recursive: true });
      mkdirSync(join(root, "candidate"), { recursive: true });
      writeFileSync(activePath, `old-${id}\n`);
      writeFileSync(candidatePath, `new-${id}\n`);
      return { id, activePath, candidatePath };
    });
    return { root, artifacts };
  }

  it("commits the package pointer last and marks readiness", async () => {
    const fixture = activationFixture();
    const order: string[] = [];
    const manifest = await new ActivationService().activate({
      runtimeDirectory: fixture.root,
      from: build("a".repeat(40)),
      to: build("b".repeat(40)),
      artifacts: fixture.artifacts,
      hooks: {
        afterArtifact: (item) => order.push(item.id),
        beforeCommit: () => order.push("before-pointer"),
        readiness: () => order.push("ready"),
      },
    });
    expect(order).toEqual([
      "database",
      "config",
      "extensionLock",
      "overlay:one",
      "before-pointer",
      "ready",
    ]);
    expect(manifest.state).toBe("ready");
    expect(
      fixture.artifacts.every((item) => readFileSync(item.activePath, "utf8").startsWith("new-")),
    ).toBe(true);
  });

  it("removes absent overlay files and restores them when readiness fails", async () => {
    const successful = activationFixture();
    const removedPath = join(successful.root, "active", "obsolete.txt");
    writeFileSync(removedPath, "obsolete\n");
    await new ActivationService().activate({
      runtimeDirectory: successful.root,
      from: build("a".repeat(40)),
      to: build("b".repeat(40)),
      artifacts: [
        ...successful.artifacts,
        { id: "overlay:obsolete", activePath: removedPath, remove: true },
      ],
    });
    expect(existsSync(removedPath)).toBe(false);

    const failed = activationFixture();
    const restoredPath = join(failed.root, "active", "obsolete.txt");
    writeFileSync(restoredPath, "restore-me\n");
    await expect(
      new ActivationService().activate({
        runtimeDirectory: failed.root,
        from: build("a".repeat(40)),
        to: build("b".repeat(40)),
        artifacts: [
          ...failed.artifacts,
          { id: "overlay:obsolete", activePath: restoredPath, remove: true },
        ],
        hooks: {
          readiness: () => {
            throw new Error("readiness failed");
          },
        },
      }),
    ).rejects.toThrow("readiness failed");
    expect(readFileSync(restoredPath, "utf8")).toBe("restore-me\n");
  });

  it.each(["after-stage", "database", "config", "extensionLock", "overlay:one", "readiness"])(
    "restores every exact old artifact after %s interruption",
    async (failure) => {
      const fixture = activationFixture();
      const original = new Map(
        fixture.artifacts.map((item) => [item.id, readFileSync(item.activePath, "utf8")]),
      );
      await expect(
        new ActivationService().activate({
          runtimeDirectory: fixture.root,
          from: build("a".repeat(40)),
          to: build("b".repeat(40)),
          artifacts: fixture.artifacts,
          hooks: {
            afterStage: () => {
              if (failure === "after-stage") throw new Error("injected interruption");
            },
            afterArtifact: (item) => {
              if (failure === item.id) throw new Error("injected interruption");
            },
            readiness: () => {
              if (failure === "readiness") throw new Error("injected interruption");
            },
          },
        }),
      ).rejects.toThrow("injected interruption");
      for (const item of fixture.artifacts)
        expect(readFileSync(item.activePath, "utf8")).toBe(original.get(item.id));
    },
  );
});

describe("systemd and OpenSSH plans", () => {
  function result(status: number, stdout = "", stderr = ""): SpawnSyncReturns<string> {
    return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null };
  }

  it("generates and executes the exact user lifecycle without cgroup-killing tmux", async () => {
    const root = fixtureDirectory("systemd");
    const home = join(root, "home");
    const repository = join(root, "repo");
    const packageRoot = join(root, "package");
    mkdirSync(join(repository, ".nanasa", "runtime"), { recursive: true });
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    mkdirSync(join(packageRoot, "templates", "systemd"), { recursive: true });
    writeFileSync(join(packageRoot, "bin", "nanasa.js"), "#!/usr/bin/env node\n");
    writeFileSync(
      join(packageRoot, "templates", "systemd", "nanasa.service"),
      readFileSync(join(repositoryRoot, "templates", "systemd", "nanasa.service")),
    );
    const calls: string[][] = [];
    let active = "inactive\n";
    const runner: ServiceCommandRunner = {
      run: (command, args) => {
        calls.push([command, ...args]);
        if (args.includes("is-active")) return result(active === "active\n" ? 0 : 3, active);
        if (args.includes("start") || args.includes("restart")) active = "active\n";
        if (args.includes("stop")) active = "inactive\n";
        return result(0, command === "systemctl" && args[0] === "--version" ? "systemd 257\n" : "");
      },
    };
    const service = new SystemdUserService({
      repositoryRoot: repository,
      packageRoot,
      home,
      runner,
    });
    expect(service.install().killMode).toBe("process");
    expect(readFileSync(service.unitPath, "utf8")).toContain("KillMode=process");
    expect(service.start().state).toBe("ready");
    expect(service.restart().state).toBe("ready");
    expect(service.stop().state).toBe("inactive");
    expect(service.remove().state).toBe("not-installed");
    expect(calls.some((call) => call.includes("daemon-reload"))).toBe(true);
  });

  it("rejects SSH option injection and builds loopback-only keepalive forwarding", () => {
    expect(() => buildRemoteSshPlan("-oProxyCommand=bad", "/repo")).toThrow(/SSH target/);
    expect(() => buildRemoteSshPlan("host", "relative")).toThrow(/absolute/);
    const plan = buildRemoteSshPlan("operator@example.test", "/srv/repo's name");
    const remote = {
      formatVersion: 1,
      repositoryId: "repo_fixture",
      instanceId: "instance_fixture",
      build: { packageVersion: build().packageVersion, commit: build().commit },
      apiVersion: 1,
      eventProtocolVersion: 1,
      terminalProtocolVersion: 1,
      service: {
        instanceName: "nanasa-aaaaaaaaaaaaaaaaaaaa",
        unitName: "nanasa-aaaaaaaaaaaaaaaaaaaa.service",
        state: "ready",
      },
      loopbackHost: "127.0.0.1",
      port: 3210,
    } satisfies RemoteDescriptor;
    const args = plan.tunnelArgs(40000, remote);
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ServerAliveInterval=15");
    expect(args).toContain("127.0.0.1:40000:127.0.0.1:3210");
    expect(args).not.toContain("0.0.0.0");
    expect(plan.lifecycleArgs("restart").at(-1)).toContain("nanasa service restart --repo");
    expect(() => assertCompatibleRemote({ ...build(), apiVersion: 2 as 1 }, remote)).toThrow(
      /incompatible/,
    );
  });
});
