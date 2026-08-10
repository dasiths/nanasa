import { once } from "node:events";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_JSONL_RECORD_BYTES = 1_048_576;

export class JsonlProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "JsonlProtocolError";
  }
}

export interface JsonlFramerOptions {
  maxRecordBytes?: number;
  onRecord(record: string): void;
}

export class JsonlFramer {
  readonly #maxRecordBytes: number;
  readonly #onRecord: (record: string) => void;
  #decoder = new StringDecoder("utf8");
  #record = "";
  #recordBytes = 0;
  #ended = false;

  public constructor(options: JsonlFramerOptions) {
    this.#maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_JSONL_RECORD_BYTES;
    this.#onRecord = options.onRecord;
    if (!Number.isSafeInteger(this.#maxRecordBytes) || this.#maxRecordBytes <= 0) {
      throw new RangeError("maxRecordBytes must be a positive safe integer");
    }
  }

  public write(chunk: Buffer | Uint8Array | string): void {
    if (this.#ended) throw new JsonlProtocolError("jsonl_stream_already_ended");
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      this.#append(bytes.subarray(offset, end));
      if (newline === -1) return;
      this.#emitRecord();
      offset = newline + 1;
    }
  }

  public end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#record += this.#decoder.end();
    if (this.#recordBytes !== 0 || this.#record.length !== 0) {
      throw new JsonlProtocolError("jsonl_record_missing_lf");
    }
  }

  #append(bytes: Buffer): void {
    this.#recordBytes += bytes.length;
    if (this.#recordBytes > this.#maxRecordBytes) {
      throw new JsonlProtocolError("jsonl_record_too_large");
    }
    this.#record += this.#decoder.write(bytes);
  }

  #emitRecord(): void {
    this.#record += this.#decoder.end();
    const record = this.#record.endsWith("\r") ? this.#record.slice(0, -1) : this.#record;
    this.#decoder = new StringDecoder("utf8");
    this.#record = "";
    this.#recordBytes = 0;
    this.#onRecord(record);
  }
}

export function parseJsonRecord(record: string): unknown {
  if (record.length === 0) throw new JsonlProtocolError("jsonl_empty_record");
  try {
    return JSON.parse(record) as unknown;
  } catch {
    throw new JsonlProtocolError("jsonl_malformed_json");
  }
}

export async function writeJsonLine(
  stream: Writable,
  value: unknown,
  maxRecordBytes = DEFAULT_MAX_JSONL_RECORD_BYTES,
): Promise<void> {
  const record = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(record, "utf8") - 1 > maxRecordBytes) {
    throw new JsonlProtocolError("jsonl_record_too_large");
  }
  if (stream.destroyed || stream.writableEnded) {
    throw new JsonlProtocolError("jsonl_stream_not_writable");
  }
  if (!stream.write(record, "utf8")) {
    await once(stream, "drain");
  }
}

export class BoundedByteCapture {
  readonly #limit: number;
  #value = Buffer.alloc(0);

  public constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("limit must be a positive safe integer");
    }
    this.#limit = limit;
  }

  public append(chunk: Buffer | Uint8Array | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.#value = Buffer.concat([this.#value, bytes]).subarray(-this.#limit);
  }

  public toString(): string {
    return this.#value.toString("utf8");
  }
}
