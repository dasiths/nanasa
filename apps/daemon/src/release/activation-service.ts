import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

interface DurableActivationArtifact extends ActivationArtifact {
  readonly stagedPath?: string | undefined;
  readonly rollbackPath: string;
  readonly existed: boolean;
}

interface DurableActivationJournal {
  readonly formatVersion: 1;
  readonly activationId: string;
  readonly state: "staged" | "activating" | "ready" | "rolling-back" | "rolled-back" | "failed";
  readonly artifacts: readonly DurableActivationArtifact[];
  readonly replacedIds: readonly string[];
  readonly pendingId?: string | undefined;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function description(path: string) {
  return { path, sha256: sha256(path), bytes: statSync(path).size };
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function copySynced(source: string, destination: string): void {
  copyFileSync(source, destination);
  syncFile(destination);
  syncDirectory(dirname(destination));
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function assertNoSymlinkComponents(root: string, path: string): void {
  if (!isWithin(root, path)) throw new Error(`Activation path escaped its approved root: ${path}`);
  let current = resolve(root);
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
    throw new Error(`Activation approved root cannot be a symlink: ${root}`);
  }
  for (const segment of relative(current, resolve(path)).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Activation path cannot traverse a symlink: ${path}`);
    }
  }
}

function ensureSyncedDirectory(path: string): void {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const created of missing.reverse()) {
    syncDirectory(created);
    syncDirectory(dirname(created));
  }
}

function writeJournal(path: string, journal: DurableActivationJournal): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  syncFile(temporary);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function restoreArtifact(item: DurableActivationArtifact): void {
  if (item.existed) {
    if (!existsSync(item.rollbackPath)) {
      throw new Error(`Activation rollback artifact is missing: ${item.id}`);
    }
    if (item.id === "database") {
      rmSync(`${item.activePath}-wal`, { force: true });
      rmSync(`${item.activePath}-shm`, { force: true });
    }
    copySynced(item.rollbackPath, item.activePath);
    if (sha256(item.activePath) !== sha256(item.rollbackPath)) {
      throw new Error(`Rollback hash mismatch: ${item.id}`);
    }
  } else {
    rmSync(item.activePath, { force: true });
    if (existsSync(dirname(item.activePath))) syncDirectory(dirname(item.activePath));
  }
}

export class ActivationService {
  public recoverIncomplete(
    runtimeDirectory: string,
    allowedActiveRoots: readonly string[] = [runtimeDirectory],
  ): readonly string[] {
    const activationsRoot = resolve(runtimeDirectory, "activations");
    if (!existsSync(activationsRoot)) return Object.freeze([]);
    assertNoSymlinkComponents(resolve(runtimeDirectory), activationsRoot);
    const recovered: string[] = [];
    for (const entry of readdirSync(activationsRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Activation entry cannot be a symlink: ${entry.name}`);
      }
      if (!entry.isDirectory()) continue;
      const journalPath = join(activationsRoot, entry.name, "journal.json");
      if (!existsSync(journalPath)) continue;
      if (!lstatSync(journalPath).isFile() || lstatSync(journalPath).isSymbolicLink()) {
        throw new Error(`Activation journal is not a regular file: ${entry.name}`);
      }
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as DurableActivationJournal;
      if (journal.formatVersion !== 1 || journal.activationId !== entry.name) {
        throw new Error(`Activation journal is malformed: ${entry.name}`);
      }
      const activationRoot = join(activationsRoot, entry.name);
      const rollbackRoot = join(activationRoot, "rollback");
      for (const artifact of journal.artifacts) {
        if (!isWithin(rollbackRoot, artifact.rollbackPath)) {
          throw new Error(`Activation journal path is outside its approved roots: ${artifact.id}`);
        }
        assertNoSymlinkComponents(rollbackRoot, artifact.rollbackPath);
        const activeRoot = allowedActiveRoots.find((root) => isWithin(root, artifact.activePath));
        if (activeRoot === undefined) {
          throw new Error(`Activation journal path is outside its approved roots: ${artifact.id}`);
        }
        assertNoSymlinkComponents(activeRoot, artifact.activePath);
      }
      if (!["activating", "rolling-back", "failed"].includes(journal.state)) continue;
      const restoreIds = new Set([
        ...journal.replacedIds,
        ...(journal.pendingId === undefined ? [] : [journal.pendingId]),
      ]);
      const artifacts = [...journal.artifacts].reverse().filter((item) => restoreIds.has(item.id));
      const rollingBack: DurableActivationJournal = {
        ...journal,
        state: "rolling-back",
      };
      writeJournal(journalPath, rollingBack);
      try {
        for (const item of artifacts) restoreArtifact(item);
        writeJournal(journalPath, {
          ...rollingBack,
          state: "rolled-back",
          pendingId: undefined,
        });
        recovered.push(journal.activationId);
      } catch (error) {
        writeJournal(journalPath, { ...rollingBack, state: "failed" });
        throw error;
      }
    }
    return Object.freeze(recovered);
  }

  public async activate(options: {
    runtimeDirectory: string;
    from: BuildIdentity;
    to: BuildIdentity;
    artifacts: readonly ActivationArtifact[];
    hooks?: ActivationHooks;
  }): Promise<ActivationManifest> {
    const activationId = randomUUID();
    const runtimeDirectory = resolve(options.runtimeDirectory);
    ensureSyncedDirectory(runtimeDirectory);
    const activationsRoot = resolve(runtimeDirectory, "activations");
    if (existsSync(activationsRoot)) {
      assertNoSymlinkComponents(runtimeDirectory, activationsRoot);
    } else {
      ensureSyncedDirectory(activationsRoot);
    }
    const root = resolve(activationsRoot, activationId);
    const stagedRoot = join(root, "staged");
    const rollbackRoot = join(root, "rollback");
    ensureSyncedDirectory(stagedRoot);
    ensureSyncedDirectory(rollbackRoot);
    const staged = options.artifacts.map((item, index) => {
      if (item.remove === true && item.candidatePath !== undefined) {
        throw new Error(`Removal artifact cannot have a candidate: ${item.id}`);
      }
      if (
        item.remove !== true &&
        (item.candidatePath === undefined || !existsSync(item.candidatePath))
      )
        throw new Error(`Activation candidate is missing: ${item.id}`);
      assertNoSymlinkComponents("/", item.activePath);
      if (item.candidatePath !== undefined) {
        assertNoSymlinkComponents("/", item.candidatePath);
        if (!lstatSync(item.candidatePath).isFile()) {
          throw new Error(`Activation candidate is not a regular file: ${item.id}`);
        }
      }
      const stagedPath =
        item.remove === true
          ? undefined
          : join(stagedRoot, `${index}-${basename(item.activePath)}`);
      if (stagedPath !== undefined && item.candidatePath !== undefined) {
        copySynced(item.candidatePath, stagedPath);
        if (sha256(stagedPath) !== sha256(item.candidatePath))
          throw new Error(`Activation staging hash mismatch: ${item.id}`);
      }
      const rollbackPath = join(rollbackRoot, `${index}-${basename(item.activePath)}`);
      if (existsSync(item.activePath)) copySynced(item.activePath, rollbackPath);
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
    const journalPath = join(root, "journal.json");
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
      syncFile(manifestPath);
      syncDirectory(dirname(manifestPath));
      return value;
    };
    writeManifest("staged");
    let journal: DurableActivationJournal = {
      formatVersion: 1,
      activationId,
      state: "staged",
      artifacts: staged,
      replacedIds: [],
    };
    writeJournal(journalPath, journal);
    const replaced: typeof staged = [];
    try {
      writeManifest("activating");
      journal = { ...journal, state: "activating" };
      writeJournal(journalPath, journal);
      for (const item of staged.filter((candidate) => candidate.id !== "packagePointer")) {
        journal = { ...journal, pendingId: item.id };
        writeJournal(journalPath, journal);
        if (item.remove === true) {
          rmSync(item.activePath, { force: true });
          syncDirectory(dirname(item.activePath));
          replaced.push(item);
          journal = {
            ...journal,
            replacedIds: [...journal.replacedIds, item.id],
            pendingId: undefined,
          };
          writeJournal(journalPath, journal);
          options.hooks?.afterArtifact?.(item);
          continue;
        }
        ensureSyncedDirectory(dirname(item.activePath));
        const replacement = `${item.activePath}.${activationId}.next`;
        copySynced(item.stagedPath!, replacement);
        if (sha256(replacement) !== sha256(item.stagedPath!))
          throw new Error(`Activation hash mismatch: ${item.id}`);
        if (item.id === "database") {
          rmSync(`${item.activePath}-wal`, { force: true });
          rmSync(`${item.activePath}-shm`, { force: true });
        }
        renameSync(replacement, item.activePath);
        syncDirectory(dirname(item.activePath));
        replaced.push(item);
        journal = {
          ...journal,
          replacedIds: [...journal.replacedIds, item.id],
          pendingId: undefined,
        };
        writeJournal(journalPath, journal);
        options.hooks?.afterArtifact?.(item);
      }
      options.hooks?.beforeCommit?.();
      const pointer = byId("packagePointer")!;
      journal = { ...journal, pendingId: pointer.id };
      writeJournal(journalPath, journal);
      ensureSyncedDirectory(dirname(pointer.activePath));
      const nextPointer = `${pointer.activePath}.${activationId}.next`;
      copySynced(pointer.stagedPath!, nextPointer);
      renameSync(nextPointer, pointer.activePath);
      syncDirectory(dirname(pointer.activePath));
      replaced.push(pointer);
      journal = {
        ...journal,
        replacedIds: [...journal.replacedIds, pointer.id],
        pendingId: undefined,
      };
      writeJournal(journalPath, journal);
      await options.hooks?.readiness?.();
      journal = { ...journal, state: "ready" };
      writeJournal(journalPath, journal);
      return writeManifest("ready");
    } catch (error) {
      writeManifest("rolling-back");
      journal = { ...journal, state: "rolling-back" };
      writeJournal(journalPath, journal);
      try {
        for (const item of replaced.reverse()) {
          restoreArtifact(item);
        }
        journal = { ...journal, state: "rolled-back", pendingId: undefined };
        writeJournal(journalPath, journal);
        writeManifest("rolled-back");
      } catch (rollbackError) {
        journal = { ...journal, state: "failed" };
        writeJournal(journalPath, journal);
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
