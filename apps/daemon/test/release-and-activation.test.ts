import { type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BuildIdentity, RemoteDescriptor } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNanasaDatabase } from "../src/persistence/database.js";
import { DATABASE_SCHEMA_VERSION } from "../src/persistence/schema.js";
import { type ActivationArtifact, ActivationService } from "../src/release/activation-service.js";
import { BackupService } from "../src/release/backup-service.js";
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
  const path = join(tmpdir(), `nanasa-release-${name}-${crypto.randomUUID()}`);
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
    databaseSchema: {
      minimum: DATABASE_SCHEMA_VERSION,
      maximum: DATABASE_SCHEMA_VERSION,
    },
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

function createCurrentDatabase(path: string): void {
  const database = openNanasaDatabase(path);
  database.close();
}

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WAL-safe backup and verified restore", () => {
  it("captures package, schema, config, lock, overlays, hashes, and restores verified bytes", () => {
    const root = fixtureDirectory("backup");
    const database = join(root, "state.sqlite");
    createCurrentDatabase(database);
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
    expect(backup.manifest.databaseSchema).toBe(DATABASE_SCHEMA_VERSION);
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
    createCurrentDatabase(database);
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

  it("durably creates a missing package-pointer parent", async () => {
    const fixture = activationFixture();
    const pointer = fixture.artifacts.find((item) => item.id === "packagePointer")!;
    const nestedPointer = join(fixture.root, "missing", "release", "active-pointer");
    const artifacts = fixture.artifacts.map((item) =>
      item.id === "packagePointer" ? { ...pointer, activePath: nestedPointer } : item,
    );
    const manifest = await new ActivationService().activate({
      runtimeDirectory: fixture.root,
      from: build("a".repeat(40)),
      to: build("b".repeat(40)),
      artifacts,
    });
    expect(manifest.state).toBe("ready");
    expect(readFileSync(nestedPointer, "utf8")).toBe("new-packagePointer\n");
  });

  it("rejects a symlinked activation staging root", async () => {
    const root = fixtureDirectory("activation-root-symlink");
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "activations"));
    await expect(
      new ActivationService().activate({
        runtimeDirectory: root,
        from: build("a".repeat(40)),
        to: build("b".repeat(40)),
        artifacts: [],
      }),
    ).rejects.toThrow(/cannot traverse a symlink/);
    expect(existsSync(join(outside, "manifest.json"))).toBe(false);
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

  it("recovers replaced and pending artifacts from a durable startup journal", () => {
    const fixture = activationFixture();
    const activationId = "crash-recovery";
    const activationRoot = join(fixture.root, "activations", activationId);
    const rollbackRoot = join(activationRoot, "rollback");
    mkdirSync(rollbackRoot, { recursive: true });
    const artifacts = fixture.artifacts.map((item, index) => {
      const rollbackPath = join(rollbackRoot, `${index}.txt`);
      writeFileSync(rollbackPath, `old-${item.id}\n`);
      return { ...item, rollbackPath, existed: true };
    });
    const database = artifacts.find((item) => item.id === "database")!;
    const config = artifacts.find((item) => item.id === "config")!;
    writeFileSync(database.activePath, "new-database\n");
    writeFileSync(config.activePath, "new-config\n");
    writeFileSync(
      join(activationRoot, "journal.json"),
      `${JSON.stringify(
        {
          formatVersion: 1,
          activationId,
          state: "activating",
          artifacts,
          replacedIds: ["database"],
          pendingId: "config",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    expect(new ActivationService().recoverIncomplete(fixture.root)).toEqual([activationId]);
    expect(readFileSync(database.activePath, "utf8")).toBe("old-database\n");
    expect(readFileSync(config.activePath, "utf8")).toBe("old-config\n");
    expect(JSON.parse(readFileSync(join(activationRoot, "journal.json"), "utf8"))).toMatchObject({
      state: "rolled-back",
    });
  });

  it("rejects a startup journal that traverses an active-path symlink", () => {
    const root = fixtureDirectory("activation-symlink");
    const activationId = "symlink-recovery";
    const activationRoot = join(root, "activations", activationId);
    const rollbackRoot = join(activationRoot, "rollback");
    const outside = join(root, "outside");
    mkdirSync(rollbackRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(rollbackRoot, "database"), "old\n");
    symlinkSync(outside, join(root, "active-link"));
    writeFileSync(
      join(activationRoot, "journal.json"),
      `${JSON.stringify({
        formatVersion: 1,
        activationId,
        state: "activating",
        artifacts: [
          {
            id: "database",
            activePath: join(root, "active-link", "database"),
            rollbackPath: join(rollbackRoot, "database"),
            existed: true,
          },
        ],
        replacedIds: ["database"],
      })}\n`,
      { mode: 0o600 },
    );

    expect(() => new ActivationService().recoverIncomplete(root)).toThrow(/traverse a symlink/);
    expect(existsSync(join(outside, "database"))).toBe(false);
  });

  it("rejects a symlinked activation entry during startup recovery", () => {
    const root = fixtureDirectory("activation-entry-symlink");
    const activationsRoot = join(root, "activations");
    const outside = join(root, "outside-entry");
    mkdirSync(activationsRoot);
    mkdirSync(outside);
    symlinkSync(outside, join(activationsRoot, "redirected-entry"));

    expect(() => new ActivationService().recoverIncomplete(root)).toThrow(
      /entry cannot be a symlink/,
    );
  });
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
    let enabled = false;
    let loaded = true;
    let installedUnitPath = "";
    const runner: ServiceCommandRunner = {
      run: (command, args) => {
        calls.push([command, ...args]);
        if (args.includes("show")) return result(0, loaded ? "loaded\n" : "not-found\n");
        if (args.includes("is-enabled"))
          return loaded
            ? result(enabled ? 0 : 1, enabled ? "enabled\n" : "disabled\n")
            : result(4, "not-found\n");
        if (args.includes("is-active"))
          return loaded ? result(active === "active\n" ? 0 : 3, active) : result(4);
        if (args.includes("is-failed"))
          return loaded
            ? result(active === "failed\n" ? 0 : 1, active === "failed\n" ? active : "inactive\n")
            : result(4, "not-found\n");
        if (args.includes("enable")) enabled = true;
        if (args.includes("disable")) {
          enabled = false;
          active = "inactive\n";
        }
        if (args.includes("start") || args.includes("restart")) active = "active\n";
        if (args.includes("stop")) active = "inactive\n";
        if (args.includes("daemon-reload") && !existsSync(installedUnitPath)) loaded = false;
        return result(0, command === "systemctl" && args[0] === "--version" ? "systemd 257\n" : "");
      },
    };
    const service = new SystemdUserService({
      repositoryRoot: repository,
      packageRoot,
      home,
      runner,
    });
    installedUnitPath = service.unitPath;
    expect(service.install().killMode).toBe("process");
    expect(readFileSync(service.unitPath, "utf8")).toContain("KillMode=process");
    expect(service.start().state).toBe("ready");
    expect(service.restart().state).toBe("ready");
    expect(service.stop().state).toBe("inactive");
    expect(service.remove().state).toBe("not-installed");
    expect(calls.some((call) => call.includes("daemon-reload"))).toBe(true);
    expect(calls.filter((call) => call.includes("is-enabled"))).toHaveLength(4);
    expect(calls.filter((call) => call.includes("is-active"))).toHaveLength(8);
    expect(calls.filter((call) => call.includes("is-failed"))).toHaveLength(4);
  });

  it("fails systemd removal on disable errors or unsafe state, except an absent unit", () => {
    const createService = (mode: "failure" | "active" | "absent") => {
      const root = fixtureDirectory(`systemd-remove-${mode}`);
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
      let reloaded = false;
      const runner: ServiceCommandRunner = {
        run: (command, args) => {
          if (args[0] === "--version") return result(0, "systemd 257\n");
          if (args.includes("show"))
            return result(0, mode === "absent" || reloaded ? "not-found\n" : "loaded\n");
          if (args.includes("disable")) {
            if (mode === "failure") return result(1, "", "Access denied");
            if (mode === "absent") return result(1, "", "Unit does not exist");
            return result(0);
          }
          if (args.includes("is-enabled")) {
            if (mode === "absent" || reloaded) return result(4, "not-found\n");
            return mode === "failure" ? result(0, "enabled\n") : result(1, "disabled\n");
          }
          if (args.includes("is-active")) {
            if (mode === "absent" || reloaded) return result(4);
            return result(mode === "active" ? 0 : 3, mode === "active" ? "active\n" : "inactive\n");
          }
          if (args.includes("is-failed"))
            return mode === "absent" || reloaded
              ? result(4, "not-found\n")
              : result(1, "inactive\n");
          if (args.includes("stop") && mode !== "active") return result(0);
          if (args.includes("daemon-reload")) reloaded = true;
          return result(0, command === "systemctl" ? "" : command);
        },
      };
      const service = new SystemdUserService({
        repositoryRoot: repository,
        packageRoot,
        home,
        runner,
      });
      mkdirSync(dirname(service.unitPath), { recursive: true });
      writeFileSync(service.unitPath, "fixture\n");
      writeFileSync(service.environmentPath, "fixture\n");
      return service;
    };

    const failure = createService("failure");
    expect(() => failure.remove()).toThrow(/disable failed/);
    expect(existsSync(failure.unitPath)).toBe(true);

    const active = createService("active");
    expect(() => active.remove()).toThrow(/active=active/);
    expect(existsSync(active.unitPath)).toBe(true);

    const absent = createService("absent");
    expect(absent.remove().state).toBe("not-installed");
    expect(existsSync(absent.unitPath)).toBe(false);
  });

  it("removes a manager-loaded active unit when its unit file is already missing", () => {
    const root = fixtureDirectory("systemd-remove-manager-only");
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
    let loaded = true;
    let active = true;
    const calls: string[][] = [];
    const runner: ServiceCommandRunner = {
      run: (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "--version") return result(0, "systemd 257\n");
        if (args.includes("show")) return result(0, loaded ? "loaded\n" : "not-found\n");
        if (args.includes("is-enabled")) return result(4, "not-found\n");
        if (args.includes("is-active"))
          return loaded ? result(active ? 0 : 3, active ? "active\n" : "inactive\n") : result(4);
        if (args.includes("is-failed"))
          return loaded ? result(1, "inactive\n") : result(4, "not-found\n");
        if (args.includes("stop")) active = false;
        if (args.includes("daemon-reload")) loaded = false;
        return result(0);
      },
    };
    const service = new SystemdUserService({
      repositoryRoot: repository,
      packageRoot,
      home,
      runner,
    });
    writeFileSync(service.environmentPath, "fixture\n");

    expect(existsSync(service.unitPath)).toBe(false);
    expect(service.remove().state).toBe("not-installed");
    expect(existsSync(service.environmentPath)).toBe(false);
    expect(calls.some((call) => call.includes("disable"))).toBe(false);
    expect(calls.some((call) => call.includes("stop"))).toBe(true);
    expect(calls.some((call) => call.includes("daemon-reload"))).toBe(true);
    expect(calls.findIndex((call) => call.includes("stop"))).toBeLessThan(
      calls.findIndex((call) => call.includes("daemon-reload")),
    );
  });

  it("retains service files when stopping an active loaded unit fails", () => {
    const root = fixtureDirectory("systemd-remove-stop-failure");
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
    const runner: ServiceCommandRunner = {
      run: (_command, args) => {
        if (args[0] === "--version") return result(0, "systemd 257\n");
        if (args.includes("show")) return result(0, "loaded\n");
        if (args.includes("is-enabled")) return result(0, "enabled\n");
        if (args.includes("is-active")) return result(0, "active\n");
        if (args.includes("is-failed")) return result(1, "inactive\n");
        if (args.includes("stop")) return result(1, "", "Access denied");
        return result(0);
      },
    };
    const service = new SystemdUserService({
      repositoryRoot: repository,
      packageRoot,
      home,
      runner,
    });
    mkdirSync(dirname(service.unitPath), { recursive: true });
    writeFileSync(service.unitPath, "fixture\n");
    writeFileSync(service.environmentPath, "fixture\n");

    expect(() => service.remove()).toThrow(/stop failed.*Access denied/);
    expect(existsSync(service.unitPath)).toBe(true);
    expect(existsSync(service.environmentPath)).toBe(true);
  });

  it("resets a failed unit before asserting final inactive removal state", () => {
    const root = fixtureDirectory("systemd-remove-failed-state");
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
    let loaded = true;
    let failed = true;
    let enabled = true;
    const calls: string[][] = [];
    const runner: ServiceCommandRunner = {
      run: (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "--version") return result(0, "systemd 257\n");
        if (args.includes("show")) return result(0, loaded ? "loaded\n" : "not-found\n");
        if (args.includes("is-enabled"))
          return loaded
            ? result(enabled ? 0 : 1, enabled ? "enabled\n" : "disabled\n")
            : result(4, "not-found\n");
        if (args.includes("is-active"))
          return loaded ? result(3, failed ? "failed\n" : "inactive\n") : result(4, "not-found\n");
        if (args.includes("is-failed"))
          return loaded
            ? result(failed ? 0 : 1, failed ? "failed\n" : "inactive\n")
            : result(4, "not-found\n");
        if (args.includes("reset-failed")) failed = false;
        if (args.includes("disable")) enabled = false;
        if (args.includes("daemon-reload")) loaded = false;
        return result(0);
      },
    };
    const service = new SystemdUserService({
      repositoryRoot: repository,
      packageRoot,
      home,
      runner,
    });
    mkdirSync(dirname(service.unitPath), { recursive: true });
    writeFileSync(service.unitPath, "fixture\n");
    writeFileSync(service.environmentPath, "fixture\n");

    expect(service.remove().state).toBe("not-installed");
    expect(calls.some((call) => call.includes("reset-failed"))).toBe(true);
    expect(calls.findIndex((call) => call.includes("reset-failed"))).toBeLessThan(
      calls.findIndex((call) => call.includes("disable")),
    );
  });

  it("retains service files when manager disable fails", () => {
    const root = fixtureDirectory("systemd-remove-disable-failure");
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
    let active = true;
    const runner: ServiceCommandRunner = {
      run: (_command, args) => {
        if (args[0] === "--version") return result(0, "systemd 257\n");
        if (args.includes("show")) return result(0, "loaded\n");
        if (args.includes("is-enabled")) return result(0, "enabled\n");
        if (args.includes("is-active"))
          return result(active ? 0 : 3, active ? "active\n" : "inactive\n");
        if (args.includes("is-failed")) return result(1, "inactive\n");
        if (args.includes("stop")) {
          active = false;
          return result(0);
        }
        if (args.includes("disable")) return result(1, "", "Access denied");
        return result(0);
      },
    };
    const service = new SystemdUserService({
      repositoryRoot: repository,
      packageRoot,
      home,
      runner,
    });
    mkdirSync(dirname(service.unitPath), { recursive: true });
    writeFileSync(service.unitPath, "fixture\n");
    writeFileSync(service.environmentPath, "fixture\n");

    expect(() => service.remove()).toThrow(/disable failed.*Access denied/);
    expect(existsSync(service.unitPath)).toBe(true);
    expect(existsSync(service.environmentPath)).toBe(true);
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
