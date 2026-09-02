import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type BackupManifest,
  BackupManifestSchema,
  type BuildIdentity,
  BuildIdentitySchema,
} from "@nanasa/contracts";
import { verifyDatabaseIntegrity } from "../persistence/database.js";

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifact(path: string, relativePath: string) {
  return { path: relativePath, sha256: digest(path), bytes: statSync(path).size };
}

function revision(path: string): string {
  return existsSync(path) ? digest(path) : createHash("sha256").update("").digest("hex");
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export interface BackupInputs {
  databasePath: string;
  configPath: string;
  extensionLockPath: string;
  overlays: Readonly<Record<string, string>>;
  build: BuildIdentity;
  packageRoot: string;
}

export class BackupService {
  public create(
    destinationRoot: string,
    inputs: BackupInputs,
  ): { directory: string; manifest: BackupManifest } {
    const build = BuildIdentitySchema.parse(inputs.build);
    const backupId = randomUUID();
    mkdirSync(resolve(destinationRoot), { recursive: true, mode: 0o700 });
    const directory = resolve(destinationRoot, backupId);
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    const databaseDestination = join(directory, "nanasa.sqlite");
    const configDestination = join(directory, "config.yaml");
    const lockDestination = join(directory, "extensions.lock.yaml");
    try {
      const database = new DatabaseSync(resolve(inputs.databasePath));
      try {
        database.exec("PRAGMA wal_checkpoint(FULL)");
        database.exec(`VACUUM INTO ${sqliteString(databaseDestination)}`);
      } finally {
        database.close();
      }
      verifyDatabaseIntegrity(databaseDestination);
      copyFileSync(inputs.configPath, configDestination);
      copyFileSync(inputs.extensionLockPath, lockDestination);
      chmodSync(databaseDestination, 0o600);
      chmodSync(configDestination, 0o600);
      chmodSync(lockDestination, 0o600);
      const overlayArtifacts = Object.entries(inputs.overlays)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, path]) => {
          if (
            id.length === 0 ||
            id.includes("\0") ||
            isAbsolute(id) ||
            id.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
          ) {
            throw new Error(`Backup overlay ID is unsafe: ${id}`);
          }
          const target = join(directory, "overlays", ...id.split("/"));
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          copyFileSync(path, target);
          chmodSync(target, 0o600);
          return { id, source: path, target };
        });
      const probe = new DatabaseSync(databaseDestination, { readOnly: true });
      const databaseSchema = (
        probe.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      probe.close();
      const artifacts = [
        artifact(databaseDestination, basename(databaseDestination)),
        artifact(configDestination, basename(configDestination)),
        artifact(lockDestination, basename(lockDestination)),
        ...overlayArtifacts.map(({ target }) => artifact(target, relative(directory, target))),
      ];
      const manifest = BackupManifestSchema.parse({
        formatVersion: 1,
        backupId,
        createdAt: new Date().toISOString(),
        package: {
          packageVersion: build.packageVersion,
          commit: build.commit,
          channel: build.channel,
          packageRoot: resolve(inputs.packageRoot),
        },
        databaseSchema,
        configRevision: revision(configDestination),
        extensionLockRevision: revision(lockDestination),
        providerOverlayRevisions: Object.fromEntries(
          overlayArtifacts.map(({ id, target }) => [id, revision(target)]),
        ),
        artifacts,
      });
      writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      this.verify(directory);
      return { directory, manifest };
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  public verify(directory: string): BackupManifest {
    const manifest = BackupManifestSchema.parse(
      JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
    );
    for (const item of manifest.artifacts) {
      const path = resolve(directory, item.path);
      const relativePath = relative(resolve(directory), path);
      if (
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new Error(`Backup artifact escaped its directory: ${item.path}`);
      }
      if (!existsSync(path) || statSync(path).size !== item.bytes || digest(path) !== item.sha256) {
        throw new Error(`Backup artifact verification failed: ${item.path}`);
      }
    }
    verifyDatabaseIntegrity(join(directory, "nanasa.sqlite"));
    return manifest;
  }

  public restore(directory: string, destinationDatabase: string): BackupManifest {
    const manifest = this.verify(directory);
    const target = resolve(destinationDatabase);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const staged = `${target}.${process.pid}.restore`;
    const displaced = `${target}.${process.pid}.displaced`;
    const displacedWal = `${displaced}-wal`;
    const displacedShm = `${displaced}-shm`;
    rmSync(staged, { force: true });
    rmSync(displaced, { force: true });
    rmSync(displacedWal, { force: true });
    rmSync(displacedShm, { force: true });
    try {
      copyFileSync(join(directory, "nanasa.sqlite"), staged);
      chmodSync(staged, 0o600);
      verifyDatabaseIntegrity(staged);
      if (existsSync(target)) renameSync(target, displaced);
      if (existsSync(`${target}-wal`)) renameSync(`${target}-wal`, displacedWal);
      if (existsSync(`${target}-shm`)) renameSync(`${target}-shm`, displacedShm);
      renameSync(staged, target);
      verifyDatabaseIntegrity(target);
      rmSync(displaced, { force: true });
      rmSync(displacedWal, { force: true });
      rmSync(displacedShm, { force: true });
      return manifest;
    } catch (error) {
      rmSync(staged, { force: true });
      if (existsSync(displaced)) {
        rmSync(target, { force: true });
        renameSync(displaced, target);
      }
      if (existsSync(displacedWal)) renameSync(displacedWal, `${target}-wal`);
      if (existsSync(displacedShm)) renameSync(displacedShm, `${target}-shm`);
      throw error;
    }
  }
}
