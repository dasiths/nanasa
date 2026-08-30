import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type ActivationManifest,
  ActivationManifestSchema,
  type BuildIdentity,
} from "@nanasa/contracts";

export interface ActivationArtifact {
  readonly id: "packagePointer" | "database" | "config" | "extensionLock" | `overlay:${string}`;
  readonly activePath: string;
  readonly candidatePath?: string;
  readonly remove?: boolean;
}

export interface ActivationHooks {
  afterStage?(): void;
  afterArtifact?(artifact: ActivationArtifact): void;
  beforeCommit?(): void;
  readiness?(): Promise<void> | void;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function description(path: string) {
  return { path, sha256: sha256(path), bytes: statSync(path).size };
}

export class ActivationService {
  public async activate(options: {
    runtimeDirectory: string;
    from: BuildIdentity;
    to: BuildIdentity;
    artifacts: readonly ActivationArtifact[];
    hooks?: ActivationHooks;
  }): Promise<ActivationManifest> {
    const activationId = randomUUID();
    const root = resolve(options.runtimeDirectory, "activations", activationId);
    const stagedRoot = join(root, "staged");
    const rollbackRoot = join(root, "rollback");
    mkdirSync(stagedRoot, { recursive: true, mode: 0o700 });
    mkdirSync(rollbackRoot, { recursive: true, mode: 0o700 });
    const staged = options.artifacts.map((item, index) => {
      if (item.remove === true && item.candidatePath !== undefined) {
        throw new Error(`Removal artifact cannot have a candidate: ${item.id}`);
      }
      if (
        item.remove !== true &&
        (item.candidatePath === undefined || !existsSync(item.candidatePath))
      )
        throw new Error(`Activation candidate is missing: ${item.id}`);
      const stagedPath =
        item.remove === true
          ? undefined
          : join(stagedRoot, `${index}-${basename(item.activePath)}`);
      if (stagedPath !== undefined && item.candidatePath !== undefined) {
        copyFileSync(item.candidatePath, stagedPath);
        if (sha256(stagedPath) !== sha256(item.candidatePath))
          throw new Error(`Activation staging hash mismatch: ${item.id}`);
      }
      const rollbackPath = join(rollbackRoot, `${index}-${basename(item.activePath)}`);
      if (existsSync(item.activePath)) copyFileSync(item.activePath, rollbackPath);
      return { ...item, stagedPath, rollbackPath, existed: existsSync(item.activePath) };
    });
    options.hooks?.afterStage?.();
    const byId = (id: ActivationArtifact["id"]) => staged.find((item) => item.id === id);
    const required = ["packagePointer", "database", "config", "extensionLock"] as const;
    for (const id of required) {
      const item = byId(id);
      if (item === undefined || item.remove === true || item.stagedPath === undefined) {
        throw new Error(`Activation requires ${id}`);
      }
    }
    const manifestPath = join(root, "manifest.json");
    const createManifest = (state: ActivationManifest["state"]): ActivationManifest =>
      ActivationManifestSchema.parse({
        formatVersion: 1,
        activationId,
        createdAt: new Date().toISOString(),
        from: { packageVersion: options.from.packageVersion, commit: options.from.commit },
        to: { packageVersion: options.to.packageVersion, commit: options.to.commit },
        packagePointer: description(byId("packagePointer")!.stagedPath!),
        database: description(byId("database")!.stagedPath!),
        config: description(byId("config")!.stagedPath!),
        extensionLock: description(byId("extensionLock")!.stagedPath!),
        overlays: staged
          .filter(
            (item): item is typeof item & { stagedPath: string } =>
              item.id.startsWith("overlay:") && item.stagedPath !== undefined,
          )
          .map((item) => description(item.stagedPath)),
        state,
      });
    const writeManifest = (state: ActivationManifest["state"]) => {
      const value = createManifest(state);
      writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      return value;
    };
    writeManifest("staged");
    const replaced: typeof staged = [];
    try {
      writeManifest("activating");
      for (const item of staged.filter((candidate) => candidate.id !== "packagePointer")) {
        if (item.remove === true) {
          rmSync(item.activePath, { force: true });
          replaced.push(item);
          options.hooks?.afterArtifact?.(item);
          continue;
        }
        mkdirSync(dirname(item.activePath), { recursive: true });
        const replacement = `${item.activePath}.${activationId}.next`;
        copyFileSync(item.stagedPath!, replacement);
        if (sha256(replacement) !== sha256(item.stagedPath!))
          throw new Error(`Activation hash mismatch: ${item.id}`);
        if (item.id === "database") {
          rmSync(`${item.activePath}-wal`, { force: true });
          rmSync(`${item.activePath}-shm`, { force: true });
        }
        renameSync(replacement, item.activePath);
        replaced.push(item);
        options.hooks?.afterArtifact?.(item);
      }
      options.hooks?.beforeCommit?.();
      const pointer = byId("packagePointer")!;
      mkdirSync(dirname(pointer.activePath), { recursive: true });
      const nextPointer = `${pointer.activePath}.${activationId}.next`;
      copyFileSync(pointer.stagedPath!, nextPointer);
      renameSync(nextPointer, pointer.activePath);
      replaced.push(pointer);
      await options.hooks?.readiness?.();
      return writeManifest("ready");
    } catch (error) {
      writeManifest("rolling-back");
      try {
        for (const item of replaced.reverse()) {
          if (item.existed) {
            if (item.id === "database") {
              rmSync(`${item.activePath}-wal`, { force: true });
              rmSync(`${item.activePath}-shm`, { force: true });
            }
            copyFileSync(item.rollbackPath, item.activePath);
            if (sha256(item.activePath) !== sha256(item.rollbackPath))
              throw new Error(`Rollback hash mismatch: ${item.id}`, { cause: error });
          } else {
            rmSync(item.activePath, { force: true });
          }
        }
        writeManifest("rolled-back");
      } catch (rollbackError) {
        writeManifest("failed");
        throw new AggregateError(
          [error, rollbackError],
          "Activation and exact rollback both failed",
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }
}
