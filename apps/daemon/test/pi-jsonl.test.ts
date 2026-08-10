import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  BoundedByteCapture,
  JsonlFramer,
  JsonlProtocolError,
  parseJsonRecord,
  writeJsonLine,
} from "../src/pi-jsonl.js";

describe("Pi JSONL framing", () => {
  it("decodes fragmented UTF-8 and preserves Unicode line separators", () => {
    const records: string[] = [];
    const framer = new JsonlFramer({ onRecord: (record) => records.push(record) });
    const input = Buffer.from('{"text":"A😀\u2028B\u2029C"}\n', "utf8");

    framer.write(input.subarray(0, 12));
    framer.write(input.subarray(12, 14));
    framer.write(input.subarray(14));
    framer.end();

    expect(records).toEqual(['{"text":"A😀\u2028B\u2029C"}']);
    expect(parseJsonRecord(records[0] ?? "")).toEqual({ text: "A😀\u2028B\u2029C" });
  });

  it("accepts CRLF while splitting only on LF", () => {
    const records: string[] = [];
    const framer = new JsonlFramer({ onRecord: (record) => records.push(record) });

    framer.write('{"one":1}\r\n{"two":2}\n');
    framer.end();

    expect(records).toEqual(['{"one":1}', '{"two":2}']);
  });

  it("rejects malformed, empty, unterminated, and oversized records", () => {
    expect(() => parseJsonRecord("{")).toThrowError(new JsonlProtocolError("jsonl_malformed_json"));
    expect(() => parseJsonRecord("")).toThrowError(new JsonlProtocolError("jsonl_empty_record"));

    const unterminated = new JsonlFramer({ onRecord: () => undefined });
    unterminated.write("{}");
    expect(() => unterminated.end()).toThrowError(
      new JsonlProtocolError("jsonl_record_missing_lf"),
    );

    const oversized = new JsonlFramer({ maxRecordBytes: 4, onRecord: () => undefined });
    expect(() => oversized.write("12345")).toThrowError(
      new JsonlProtocolError("jsonl_record_too_large"),
    );
  });

  it("waits for drain after a backpressured write", async () => {
    class BackpressuredWritable extends Writable {
      public writes = 0;
      public override write(): boolean {
        this.writes += 1;
        return false;
      }
    }

    const stream = new BackpressuredWritable();
    const writing = writeJsonLine(stream, { type: "get_state" });
    let resolved = false;
    void writing.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    EventEmitter.prototype.emit.call(stream, "drain");
    await expect(writing).resolves.toBeUndefined();
    expect(stream.writes).toBe(1);
  });

  it("retains only the configured stderr tail", () => {
    const capture = new BoundedByteCapture(5);
    capture.append("abc");
    capture.append("defg");
    expect(capture.toString()).toBe("cdefg");
  });
});
