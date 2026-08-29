import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GeneratedOverlayFile } from "./providers/provider-adapter.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OVERLAY_BYTES = 8 * 1024 * 1024;

export interface OverlayLedgerEntry {
  readonly relativePath: string;
  readonly ownerKind: GeneratedOverlayFile["ownerKind"];
  readonly adapterVersion: string;
  readonly contentHash: string;
  readonly mode: number;
}

export interface OverlayLedger {
  readonly version: 1;
  readonly bindingId: string;
  readonly revision: number;
  readonly overlayPath: string;
  readonly entries: readonly OverlayLedgerEntry[];
  readonly committedAt: string;
}

export interface OverlayCommitResult {
  readonly root: string;
  readonly ledger: OverlayLedger;
  readonly digest: string;
}

export interface GeneratedOverlayTransactionOptions {
  beforeLedgerCommit?: (stagedRoot: string) => void;
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error(`Overlay path must be a regular directory: ${path}`);
  if (typeof process.getuid === "function" && status.uid !== process.getuid())
    throw new Error(`Overlay path must be owned by the current user: ${path}`);
  chmodSync(path, DIRECTORY_MODE);
}

function ensureTree(root: string, path: string): void {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    throw new Error("Overlay path escaped its managed root");
  ensureDirectory(root);
  let current = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    ensureDirectory(current);
  }
}

function validateRelativePath(path: string): void {
  if (path.length === 0 || path.includes("\0") || path.includes("\\") || isAbsolute(path))
    throw new Error("Overlay file path must be a nonempty portable relative path");
  if (
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    throw new Error("Overlay file path may not contain empty or traversal segments");
}

function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeSynced(path: string, content: string, mode: number): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES)
    throw new Error(`Generated overlay file exceeds ${MAX_FILE_BYTES} bytes`);
  ensureTree(dirname(dirname(path)), dirname(path));
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
}

function inventoryFiles(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      files.push(relative(root, path).split(sep).join("/"));
    } else if (status.isDirectory()) {
      files.push(...inventoryFiles(root, path));
    } else {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files;
}

export class GeneratedOverlayTransaction {
  readonly #root: string;
  readonly #generatedRoot: string;
  readonly #ledgerRoot: string;
  readonly #stagingRoot: string;
  readonly #options: GeneratedOverlayTransactionOptions;

  public constructor(root: string, options: GeneratedOverlayTransactionOptions = {}) {
    this.#root = resolve(root);
    this.#generatedRoot = join(this.#root, "generated");
    this.#ledgerRoot = join(this.#root, "ledger");
    this.#stagingRoot = join(this.#root, ".staging");
    this.#options = options;
    for (const directory of [this.#root, this.#generatedRoot, this.#ledgerRoot, this.#stagingRoot])
      ensureTree(this.#root, directory);
  }

  public overlayRoot(bindingId: string, revision: number): string {
    this.#validateBinding(bindingId);
    if (!Number.isInteger(revision) || revision < 1)
      throw new Error("Overlay revision must be positive");
    return join(this.#generatedRoot, bindingId, String(revision));
  }

  public ledgerPath(bindingId: string): string {
    this.#validateBinding(bindingId);
    return join(this.#ledgerRoot, `${bindingId}.json`);
  }

  public readLedger(bindingId: string): OverlayLedger | undefined {
    const path = this.ledgerPath(bindingId);
    if (!existsSync(path)) return undefined;
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_FILE_BYTES)
      throw new Error("Overlay ledger is not a safe regular file");
    const value = JSON.parse(readFileSync(path, "utf8")) as OverlayLedger;
    if (value.version !== 1 || value.bindingId !== bindingId || !Array.isArray(value.entries))
      throw new Error("Overlay ledger is malformed");
    return Object.freeze({
      ...value,
      entries: Object.freeze(value.entries.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  public detectDrift(bindingId: string): readonly string[] {
    const ledger = this.readLedger(bindingId);
    if (ledger === undefined) return Object.freeze([]);
    const drift: string[] = [];
    for (const entry of ledger.entries) {
      const path = join(ledger.overlayPath, entry.relativePath);
      if (!existsSync(path)) {
        drift.push(entry.relativePath);
        continue;
      }
      const status = lstatSync(path);
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        hash(readFileSync(path)) !== entry.contentHash ||
        (status.mode & 0o777) !== entry.mode
      )
        drift.push(entry.relativePath);
    }
    const expected = new Set([
      ...ledger.entries.map((entry) => entry.relativePath),
      "ownership.json",
    ]);
    for (const relativePath of inventoryFiles(ledger.overlayPath)) {
      if (!expected.has(relativePath)) drift.push(relativePath);
    }
    return Object.freeze(drift);
  }

  public commit(
    bindingId: string,
    revision: number,
    adapterVersion: string,
    files: readonly GeneratedOverlayFile[],
  ): OverlayCommitResult {
    this.#validateBinding(bindingId);
    if (files.length === 0) throw new Error("Generated overlay must contain at least one file");
    const duplicate = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      validateRelativePath(file.relativePath);
      if (duplicate.has(file.relativePath))
        throw new Error(`Duplicate generated path ${file.relativePath}`);
      duplicate.add(file.relativePath);
      totalBytes += Buffer.byteLength(file.content, "utf8");
    }
    if (totalBytes > MAX_OVERLAY_BYTES)
      throw new Error(`Generated overlay exceeds ${MAX_OVERLAY_BYTES} bytes`);
    const drift = this.detectDrift(bindingId);
    if (drift.length > 0) throw new Error(`Generated overlay drift detected: ${drift.join(", ")}`);

    const finalRoot = this.overlayRoot(bindingId, revision);
    if (existsSync(finalRoot)) {
      const existing = this.readLedger(bindingId);
      if (existing?.revision === revision && this.detectDrift(bindingId).length === 0) {
        return Object.freeze({
          root: finalRoot,
          ledger: existing,
          digest: this.#ledgerDigest(existing.entries),
        });
      }
      throw new Error(`Overlay revision ${revision} already exists`);
    }
    const stagedRoot = join(this.#stagingRoot, `${bindingId}-${revision}-${randomUUID()}`);
    let finalMoved = false;
    let ledgerCommitted = false;
    ensureTree(this.#stagingRoot, stagedRoot);
    try {
      const entries: OverlayLedgerEntry[] = [];
      for (const file of files) {
        const mode = file.mode ?? FILE_MODE;
        if (mode !== FILE_MODE && mode !== 0o700)
          throw new Error("Generated files must use mode 0600 or 0700");
        const path = join(stagedRoot, file.relativePath);
        ensureTree(stagedRoot, dirname(path));
        writeSynced(path, file.content, mode);
        entries.push(
          Object.freeze({
            relativePath: file.relativePath,
            ownerKind: file.ownerKind,
            adapterVersion,
            contentHash: hash(file.content),
            mode,
          }),
        );
      }
      const manifest = `${JSON.stringify({ version: 1, bindingId, revision, entries }, null, 2)}\n`;
      writeSynced(join(stagedRoot, "ownership.json"), manifest, FILE_MODE);
      syncDirectory(stagedRoot);
      this.#options.beforeLedgerCommit?.(stagedRoot);
      ensureTree(this.#generatedRoot, dirname(finalRoot));
      renameSync(stagedRoot, finalRoot);
      finalMoved = true;
      syncDirectory(dirname(finalRoot));
      const ledger: OverlayLedger = Object.freeze({
        version: 1,
        bindingId,
        revision,
        overlayPath: finalRoot,
        entries: Object.freeze(entries),
        committedAt: new Date().toISOString(),
      });
      const ledgerPath = this.ledgerPath(bindingId);
      const temporaryLedger = `${ledgerPath}.${randomUUID()}.tmp`;
      writeSynced(temporaryLedger, `${JSON.stringify(ledger, null, 2)}\n`, FILE_MODE);
      renameSync(temporaryLedger, ledgerPath);
      ledgerCommitted = true;
      syncDirectory(this.#ledgerRoot);
      return Object.freeze({ root: finalRoot, ledger, digest: this.#ledgerDigest(entries) });
    } catch (error) {
      rmSync(stagedRoot, { recursive: true, force: true });
      if (finalMoved && !ledgerCommitted) rmSync(finalRoot, { recursive: true, force: true });
      throw error;
    }
  }

  public removeConservatively(bindingId: string): boolean {
    const ledger = this.readLedger(bindingId);
    if (ledger === undefined) return false;
    if (this.detectDrift(bindingId).length > 0) return false;
    rmSync(ledger.overlayPath, { recursive: true, force: false });
    rmSync(this.ledgerPath(bindingId));
    syncDirectory(this.#ledgerRoot);
    return true;
  }

  #ledgerDigest(entries: readonly OverlayLedgerEntry[]): string {
    return hash(
      JSON.stringify(entries.map((entry) => [entry.relativePath, entry.contentHash, entry.mode])),
    );
  }

  #validateBinding(bindingId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bindingId))
      throw new Error("Provider binding ID is not path-safe");
  }
}
