import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TerminalCheckpointContentSchema,
  TerminalReadRequestSchema,
  type TerminalCheckpoint,
  type TerminalReadRequest,
  type TerminalReadResult,
  type TerminalPolicy,
} from "@nanasa/contracts";
import { DomainError, type NanasaStore } from "../store.js";
import type { TmuxRuntime } from "../tmux-runtime.js";

export class TerminalReadService {
  readonly #directory: string;

  public constructor(
    private readonly store: NanasaStore,
    private readonly runtime: TmuxRuntime,
    directory: string,
    private readonly policy: TerminalPolicy["checkpoints"],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#directory = resolve(directory);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    chmodSync(this.#directory, 0o700);
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
    const storageReference = join(this.#directory, `${randomUUID()}.txt`);
    writeFileSync(storageReference, read.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      return this.store.saveTerminalCheckpoint(ownerPrincipalId, {
        runId,
        generation,
        terminalBinding: read.binding,
        capturedAt: read.capturedAt,
        lineCount: read.lineCount,
        byteCount: read.byteCount,
        truncated: read.truncated,
        sensitivity: policy.sensitivity,
        storageReference,
        expiresAt: new Date(this.now().getTime() + policy.retentionSeconds * 1_000).toISOString(),
      });
    } catch (error) {
      rmSync(storageReference, { force: true });
      throw error;
    }
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
    const path = resolve(checkpoint.storageReference);
    if (!path.startsWith(`${this.#directory}/`))
      throw new DomainError(
        "terminal_checkpoint_invalid",
        "Terminal checkpoint storage is invalid",
        500,
      );
    return TerminalCheckpointContentSchema.parse({ checkpoint, text: readFileSync(path, "utf8") });
  }

  public delete(ownerPrincipalId: string, checkpointId: string): boolean {
    const checkpoint = this.store
      .listTerminalCheckpoints(ownerPrincipalId)
      .find((candidate) => candidate.id === checkpointId);
    if (checkpoint === undefined) return false;
    const deleted = this.store.deleteTerminalCheckpoint(ownerPrincipalId, checkpointId);
    if (deleted) rmSync(checkpoint.storageReference, { force: true });
    return deleted;
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
