import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  type TerminalCheckpoint,
  TerminalCheckpointContentSchema,
  type TerminalPolicy,
  type TerminalReadRequest,
  TerminalReadRequestSchema,
  type TerminalReadResult,
} from "@nanasa/contracts";
import { DomainError, type NanasaStore } from "../store.js";
import { AnchoredDirectory } from "../anchored-directory.js";
import type { TmuxRuntime } from "../tmux-runtime.js";

export class TerminalReadService {
  readonly #directory: string;
  readonly #anchoredDirectory: AnchoredDirectory;

  public constructor(
    private readonly store: NanasaStore,
    private readonly runtime: TmuxRuntime,
    directory: string,
    private readonly policy: TerminalPolicy["checkpoints"],
    private readonly now: () => Date = () => new Date(),
    anchoredDirectoryFactory: (path: string) => AnchoredDirectory = (path) =>
      new AnchoredDirectory(path),
  ) {
    this.#directory = resolve(directory);
    if (existsSync(this.#directory)) {
      const existing = lstatSync(this.#directory, { bigint: true });
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error("Terminal checkpoint root must be a non-symlink directory");
      }
    } else {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    }
    chmodSync(this.#directory, 0o700);
    this.#anchoredDirectory = anchoredDirectoryFactory(this.#directory);
  }

  public read(input: TerminalReadRequest): Promise<TerminalReadResult> {
    const request = TerminalReadRequestSchema.parse(input);
    const run = this.store.getRun(request.runId);
    if (run.generation !== request.generation || run.terminal === undefined) {
      throw new DomainError(
        "terminal_read_generation_mismatch",
        "Terminal read generation does not match the run",
        409,
      );
    }
    return this.runtime.readTerminal(request);
  }

  public async captureCheckpoint(
    ownerPrincipalId: string,
    runId: string,
    generation: number,
    source: TerminalReadRequest["source"] = "history",
  ): Promise<TerminalCheckpoint> {
    const policy = this.policy;
    if (!policy.enabled)
      throw new DomainError(
        "terminal_checkpoints_disabled",
        "Terminal checkpoint storage is disabled by configuration",
        409,
      );
    const read = await this.read({
      runId,
      generation,
      source,
      maxLines: policy.maxLines,
      maxBytes: policy.maxBytes,
    });
    const name = `${randomUUID()}.txt`;
    const storageReference = this.#anchoredDirectory.reference(name);
    return this.#anchoredDirectory.withHandle((directory) =>
      directory.createExclusive(name, read.text, () =>
        this.store.saveTerminalCheckpoint(ownerPrincipalId, {
          runId,
          generation,
          terminalBinding: read.binding,
          capturedAt: read.capturedAt,
          lineCount: read.lineCount,
          byteCount: read.byteCount,
          truncated: read.truncated,
          sensitivity: policy.sensitivity,
          storageReference,
          contentDigest: createHash("sha256").update(read.text, "utf8").digest("hex"),
          expiresAt: new Date(this.now().getTime() + policy.retentionSeconds * 1_000).toISOString(),
        }),
      ),
    );
  }

  public list(ownerPrincipalId: string): TerminalCheckpoint[] {
    return this.store
      .listTerminalCheckpoints(ownerPrincipalId)
      .filter((checkpoint) => Date.parse(checkpoint.expiresAt) > this.now().getTime());
  }

  public retrieve(ownerPrincipalId: string, checkpointId: string) {
    const checkpoint = this.store
      .listTerminalCheckpoints(ownerPrincipalId)
      .find((candidate) => candidate.id === checkpointId);
    if (checkpoint === undefined)
      throw new DomainError("terminal_checkpoint_not_found", "Terminal checkpoint not found", 404);
    if (Date.parse(checkpoint.expiresAt) <= this.now().getTime())
      throw new DomainError("terminal_checkpoint_expired", "Terminal checkpoint expired", 410);
    let name: string;
    try {
      name = this.#anchoredDirectory.basenameFor(checkpoint.storageReference);
    } catch {
      throw new DomainError(
        "terminal_checkpoint_invalid",
        "Terminal checkpoint storage is invalid",
        500,
      );
    }
    let bytes: Buffer;
    try {
      bytes = this.#anchoredDirectory.withHandle((directory) => directory.readFile(name));
    } catch {
      throw new DomainError(
        "terminal_checkpoint_invalid",
        "Terminal checkpoint storage is unavailable or unsafe",
        500,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== checkpoint.contentDigest) {
      throw new DomainError(
        "terminal_checkpoint_invalid",
        "Terminal checkpoint content identity does not match persistence",
        500,
      );
    }
    return TerminalCheckpointContentSchema.parse({ checkpoint, text: bytes.toString("utf8") });
  }

  public delete(ownerPrincipalId: string, checkpointId: string): boolean {
    const checkpoint = this.store
      .listTerminalCheckpoints(ownerPrincipalId)
      .find((candidate) => candidate.id === checkpointId);
    if (checkpoint === undefined) return false;
    const name = this.#anchoredDirectory.basenameFor(checkpoint.storageReference);
    return this.#anchoredDirectory.withHandle((directory) => {
      directory.deleteVerified(
        name,
        {
          storageReference: checkpoint.storageReference,
          contentDigest: checkpoint.contentDigest,
        },
        {
          delete: () => this.store.deleteTerminalCheckpoint(ownerPrincipalId, checkpointId),
          reconcile: () =>
            this.store.reconcileDestroyedTerminalCheckpoint(ownerPrincipalId, checkpointId),
        },
      );
      return true;
    });
  }

  public expire(): number {
    let expired = 0;
    for (const owner of this.store.listTerminalCheckpointOwners()) {
      for (const checkpoint of this.store.listTerminalCheckpoints(owner)) {
        if (Date.parse(checkpoint.expiresAt) > this.now().getTime()) continue;
        if (this.delete(owner, checkpoint.id)) expired += 1;
      }
    }
    return expired;
  }
}
