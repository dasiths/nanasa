import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export class ReporterSequencer {
  readonly #path: string;
  readonly #epoch: string;

  public constructor(path: string, reporterEpoch: string) {
    this.#path = path;
    this.#epoch = reporterEpoch;
  }

  public next(): number {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const lock = `${this.#path}.lock`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lock, "wx", 0o600);
      let current = { epoch: this.#epoch, sequence: 0 };
      try {
        const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as typeof current;
        if (parsed.epoch !== this.#epoch) throw new Error("reporter_sequence_epoch_mismatch");
        if (Number.isSafeInteger(parsed.sequence) && parsed.sequence >= 0) current = parsed;
      } catch (error) {
        if (error instanceof Error && error.message === "reporter_sequence_epoch_mismatch")
          throw error;
      }
      const next = current.sequence + 1;
      const temporary = `${this.#path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ epoch: this.#epoch, sequence: next }), {
        mode: 0o600,
      });
      renameSync(temporary, this.#path);
      return next;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(lock, { force: true });
    }
  }
}
