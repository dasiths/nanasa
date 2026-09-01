import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type BrowserRestartFrame,
  BrowserRestartFrameSchema,
  type BuildIdentity,
} from "@nanasa/contracts";
import { openNanasaDatabase } from "../persistence/database.js";
import { repositoryIdentity } from "../protocol-metadata.js";
import { SystemdUserService } from "../service/systemd-user-service.js";
import { type ActivationArtifact, ActivationService } from "./activation-service.js";
import { BackupService } from "./backup-service.js";
import { loadBuildIdentity } from "./build-identity.js";

function ensureFile(path: string, contents: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
}

function overlayFiles(repositoryRoot: string): Record<string, string> {
  const integrations = join(repositoryRoot, ".nanasa", "integrations");
  const result: Record<string, string> = {};
  const visit = (current: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const status = lstatSync(path);
      if (status.isSymbolicLink())
        throw new Error(`Generated overlay cannot contain a symlink: ${path}`);
      if (status.isDirectory()) visit(path);
      else if (status.isFile()) {
        const id = relative(integrations, path).split(sep).join("/");
        if (id.startsWith("..")) throw new Error("Generated overlay escaped its integrations root");
        result[id] = path;
      } else throw new Error(`Generated overlay contains an unsupported device: ${path}`);
    }
  };
  for (const directory of ["generated", "ledger"]) {
    const path = join(integrations, directory);
    visit(path);
  }
  return result;
}

function removeCandidateOverlayFiles(repositoryRoot: string, retained: ReadonlySet<string>): void {
  const integrations = join(repositoryRoot, ".nanasa", "integrations");
  const visit = (current: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const id = relative(integrations, path).split(sep).join("/");
      const status = lstatSync(path);
      if (status.isDirectory() && !status.isSymbolicLink()) {
        visit(path);
        if (readdirSync(path).length === 0) rmSync(path, { recursive: false, force: true });
      } else if (!retained.has(id)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  };
  visit(join(integrations, "generated"));
  visit(join(integrations, "ledger"));
}

export class ReleaseManager {
  readonly #repositoryRoot: string;
  readonly #activePackageRoot: string;
  readonly #service: ReleaseService;
  readonly #serviceFactory: (packageRoot: string) => ReleaseService;
  readonly #backup: BackupService;
  readonly #activation: ActivationService;
  readonly #onPlannedRestart: (frame: BrowserRestartFrame) => void;
  readonly #readinessTimeoutMs: number;

  public constructor(
    repositoryRoot: string,
    activePackageRoot: string,
    options: ReleaseManagerOptions = {},
  ) {
    this.#repositoryRoot = resolve(repositoryRoot);
    this.#activePackageRoot = resolve(activePackageRoot);
    this.#serviceFactory =
      options.serviceFactory ??
      ((packageRoot) => new SystemdUserService({ repositoryRoot, packageRoot }));
    this.#service = this.#serviceFactory(this.#activePackageRoot);
    this.#backup = options.backup ?? new BackupService();
    this.#activation = options.activation ?? new ActivationService();
    this.#onPlannedRestart = options.onPlannedRestart ?? (() => undefined);
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
  }

  public preflight(candidatePackageRoot: string): { from: BuildIdentity; to: BuildIdentity } {
    const from = loadBuildIdentity(this.#activePackageRoot);
    const to = loadBuildIdentity(candidatePackageRoot);
    if (from.commit === to.commit) throw new Error("Candidate build is already active");
    if (to.databaseSchema.minimum !== to.databaseSchema.maximum)
      throw new Error("Candidate schema range must be exact during prerelease");
    const database = join(this.#repositoryRoot, ".nanasa", "state", "nanasa.sqlite");
    if (!existsSync(database)) throw new Error("A clean current database is required for release");
    const current = openNanasaDatabase(database);
    current.close();
    if (from.databaseSchema.maximum !== to.databaseSchema.maximum) {
      throw new Error("Release activation does not transform database schemas");
    }
    return { from, to };
  }

  public async upgrade(
    candidatePackageRoot: string,
  ): Promise<{ activationId: string; backupId: string }> {
    const candidateRoot = resolve(candidatePackageRoot);
    const { from, to } = this.preflight(candidateRoot);
    const stateRoot = join(this.#repositoryRoot, ".nanasa", "state");
    const runtimeRoot = join(this.#repositoryRoot, ".nanasa", "runtime");
    const databasePath = join(stateRoot, "nanasa.sqlite");
    const configPath = join(this.#repositoryRoot, ".nanasa", "config.yaml");
    const lockPath = join(this.#repositoryRoot, ".nanasa", "extensions.lock.yaml");
    ensureFile(lockPath, "version: 1\nrevision: 0\nextensions: {}\n");
    mkdirSync(join(stateRoot, "release"), { recursive: true, mode: 0o700 });
    const retainedOverlays = overlayFiles(this.#repositoryRoot);
    const backup = this.#backup.create(join(stateRoot, "backups"), {
      databasePath,
      configPath,
      extensionLockPath: lockPath,
      overlays: retainedOverlays,
      build: from,
      packageRoot: this.#activePackageRoot,
    });
    const candidateRootState = join(runtimeRoot, "candidate-release");
    mkdirSync(candidateRootState, { recursive: true, mode: 0o700 });
    const candidateDatabase = join(candidateRootState, "nanasa.sqlite");
    const candidateConfig = join(candidateRootState, "config.yaml");
    const candidateLock = join(candidateRootState, "extensions.lock.yaml");
    const candidatePointer = join(candidateRootState, "active-package.json");
    copyFileSync(join(backup.directory, "nanasa.sqlite"), candidateDatabase);
    copyFileSync(configPath, candidateConfig);
    copyFileSync(lockPath, candidateLock);
    writeFileSync(
      candidatePointer,
      `${JSON.stringify({ packageRoot: candidateRoot, build: to }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const pointerPath = join(stateRoot, "release", "active-package.json");
    ensureFile(
      pointerPath,
      `${JSON.stringify({ packageRoot: this.#activePackageRoot, build: from }, null, 2)}\n`,
    );
    const artifacts: ActivationArtifact[] = [
      { id: "packagePointer", activePath: pointerPath, candidatePath: candidatePointer },
      { id: "database", activePath: databasePath, candidatePath: candidateDatabase },
      { id: "config", activePath: configPath, candidatePath: candidateConfig },
      { id: "extensionLock", activePath: lockPath, candidatePath: candidateLock },
    ];
    for (const [id, activePath] of Object.entries(retainedOverlays)) {
      const candidatePath = join(candidateRootState, "overlays", id);
      mkdirSync(dirname(candidatePath), { recursive: true, mode: 0o700 });
      copyFileSync(activePath, candidatePath);
      artifacts.push({ id: `overlay:${id}`, activePath, candidatePath });
    }
    this.#onPlannedRestart(this.#restartFrame("upgrade"));
    this.#service.stop();
    const candidateService = this.#serviceFactory(candidateRoot);
    try {
      const activation = await this.#activation.activate({
        runtimeDirectory: runtimeRoot,
        from,
        to,
        artifacts,
        hooks: {
          readiness: async () => {
            candidateService.install();
            candidateService.start();
            try {
              await candidateService.waitReady(this.#readinessTimeoutMs);
            } catch (error) {
              try {
                candidateService.stop();
              } catch {
                // Preserve the readiness failure; the activation rollback restores exact state.
              }
              throw error;
            }
          },
        },
      });
      return { activationId: activation.activationId, backupId: backup.manifest.backupId };
    } catch (error) {
      let cleanupError: unknown;
      try {
        removeCandidateOverlayFiles(this.#repositoryRoot, new Set(Object.keys(retainedOverlays)));
      } catch (cause) {
        cleanupError = cause;
      }
      this.#service.install();
      this.#service.start();
      await this.#service.waitReady(this.#readinessTimeoutMs);
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [error, cleanupError],
          "Candidate activation failed and candidate overlay cleanup was incomplete",
          { cause: error },
        );
      }
      throw error;
    }
  }

  public async restoreBackup(backupId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(backupId)) throw new Error("Backup ID is invalid");
    const root = join(this.#repositoryRoot, ".nanasa", "state");
    const directory = join(root, "backups", backupId);
    const manifest = this.#backup.verify(directory);
    const from = loadBuildIdentity(this.#activePackageRoot);
    const to = loadBuildIdentity(manifest.package.packageRoot);
    if (
      to.packageVersion !== manifest.package.packageVersion ||
      to.commit !== manifest.package.commit ||
      to.channel !== manifest.package.channel
    ) {
      throw new Error("Backup package identity does not match the retained package");
    }
    if (
      manifest.databaseSchema < to.databaseSchema.minimum ||
      manifest.databaseSchema > to.databaseSchema.maximum
    ) {
      throw new Error(
        `Backup schema ${manifest.databaseSchema} is incompatible with retained package ${to.packageVersion}`,
      );
    }
    const runtimeRoot = join(this.#repositoryRoot, ".nanasa", "runtime");
    const candidateRoot = join(runtimeRoot, `restore-${backupId}`);
    mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
    const candidatePointer = join(candidateRoot, "active-package.json");
    writeFileSync(
      candidatePointer,
      `${JSON.stringify({ packageRoot: manifest.package.packageRoot, build: to }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const backupArtifact = (path: string): string => {
      if (!manifest.artifacts.some((item) => item.path === path)) {
        throw new Error(`Backup manifest is missing ${path}`);
      }
      return join(directory, path);
    };
    const pointerPath = join(root, "release", "active-package.json");
    const artifacts: ActivationArtifact[] = [
      { id: "packagePointer", activePath: pointerPath, candidatePath: candidatePointer },
      {
        id: "database",
        activePath: join(root, "nanasa.sqlite"),
        candidatePath: backupArtifact("nanasa.sqlite"),
      },
      {
        id: "config",
        activePath: join(this.#repositoryRoot, ".nanasa", "config.yaml"),
        candidatePath: backupArtifact("config.yaml"),
      },
      {
        id: "extensionLock",
        activePath: join(this.#repositoryRoot, ".nanasa", "extensions.lock.yaml"),
        candidatePath: backupArtifact("extensions.lock.yaml"),
      },
      ...manifest.artifacts
        .filter((item) => item.path.startsWith("overlays/"))
        .map(
          (item, index): ActivationArtifact => ({
            id: `overlay:restore-${index}`,
            activePath: join(
              this.#repositoryRoot,
              ".nanasa",
              "integrations",
              item.path.slice("overlays/".length),
            ),
            candidatePath: join(directory, item.path),
          }),
        ),
    ];
    const restoredOverlayIds = new Set(
      manifest.artifacts
        .filter((item) => item.path.startsWith("overlays/"))
        .map((item) => item.path.slice("overlays/".length)),
    );
    for (const [id, activePath] of Object.entries(overlayFiles(this.#repositoryRoot))) {
      if (!restoredOverlayIds.has(id)) {
        artifacts.push({ id: `overlay:remove-${artifacts.length}`, activePath, remove: true });
      }
    }
    this.#onPlannedRestart(this.#restartFrame("rollback"));
    this.#service.stop();
    const retainedService = this.#serviceFactory(manifest.package.packageRoot);
    try {
      await this.#activation.activate({
        runtimeDirectory: runtimeRoot,
        from,
        to,
        artifacts,
        hooks: {
          readiness: async () => {
            retainedService.install();
            retainedService.start();
            try {
              await retainedService.waitReady(this.#readinessTimeoutMs);
            } catch (error) {
              try {
                retainedService.stop();
              } catch {
                // Preserve readiness failure for exact activation rollback.
              }
              throw error;
            }
          },
        },
      });
    } catch (error) {
      this.#service.install();
      this.#service.start();
      await this.#service.waitReady(this.#readinessTimeoutMs);
      throw error;
    }
  }

  public activePointer(): unknown {
    const path = join(this.#repositoryRoot, ".nanasa", "state", "release", "active-package.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  }

  #restartFrame(reason: BrowserRestartFrame["reason"]): BrowserRestartFrame {
    return BrowserRestartFrameSchema.parse({
      version: 1,
      type: "service.restart",
      reason,
      instanceId: repositoryIdentity(this.#repositoryRoot),
      retryAfterMs: 1_000,
      resnapshotRequired: true,
      terminalHandoff: false,
    });
  }
}

export interface ReleaseService {
  install(): unknown;
  start(): unknown;
  stop(): unknown;
  waitReady(timeoutMs?: number): Promise<unknown>;
}

export interface ReleaseManagerOptions {
  serviceFactory?(packageRoot: string): ReleaseService;
  backup?: BackupService;
  activation?: ActivationService;
  onPlannedRestart?(frame: BrowserRestartFrame): void;
  readinessTimeoutMs?: number;
}
