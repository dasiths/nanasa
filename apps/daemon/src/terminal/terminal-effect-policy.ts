import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { TerminalServerFrame } from "@nanasa/contracts";
import {
  TERMINAL_CLIPBOARD_MAX_BYTES,
  TERMINAL_EFFECT_TTL_MS,
} from "./terminal-transport-limits.js";

const PREFIX = "\u001b]52;";
const MAX_ENCODED_BYTES = Math.ceil(TERMINAL_CLIPBOARD_MAX_BYTES / 3) * 4 + 64;

export class TerminalEffectPolicy {
  #pending = "";
  #discarding = false;

  public filter(
    data: string,
    allowEffects: boolean,
  ): { output: string; effects: TerminalServerFrame[] } {
    let source = this.#pending + data;
    this.#pending = "";
    let output = "";
    const effects: TerminalServerFrame[] = [];
    while (source.length > 0) {
      if (this.#discarding) {
        const end = this.#terminator(source);
        if (end === undefined) return { output, effects };
        this.#discarding = false;
        source = source.slice(end);
        continue;
      }
      const start = source.indexOf(PREFIX);
      if (start < 0) {
        const possible = this.#prefixTail(source);
        output += source.slice(0, source.length - possible);
        this.#pending = source.slice(source.length - possible);
        break;
      }
      output += source.slice(0, start);
      const sequence = source.slice(start + PREFIX.length);
      const end = this.#terminator(sequence);
      if (end === undefined) {
        if (Buffer.byteLength(sequence, "utf8") > MAX_ENCODED_BYTES) {
          this.#discarding = true;
        } else {
          this.#pending = PREFIX + sequence;
        }
        break;
      }
      const terminatorBytes = sequence[end - 1] === "\u0007" ? 1 : 2;
      const body = sequence.slice(0, end - terminatorBytes);
      source = sequence.slice(end);
      const separator = body.indexOf(";");
      if (separator < 0 || body.slice(0, separator) !== "c") continue;
      const encoded = body.slice(separator + 1);
      if (
        !allowEffects ||
        encoded.length === 0 ||
        encoded === "?" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
      )
        continue;
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length === 0 || bytes.length > TERMINAL_CLIPBOARD_MAX_BYTES || bytes.includes(0))
        continue;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      effects.push({
        type: "effect",
        effectId: `effect_${randomUUID()}`,
        kind: "clipboard-write",
        byteCount: bytes.length,
        preview: [...text]
          .map((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code < 32 || code === 127 ? " " : character;
          })
          .join("")
          .slice(0, 160),
        data: text,
        expiresAt: new Date(Date.now() + TERMINAL_EFFECT_TTL_MS).toISOString(),
      });
    }
    return { output, effects };
  }

  public reset(): void {
    this.#pending = "";
    this.#discarding = false;
  }

  #terminator(value: string): number | undefined {
    const bel = value.indexOf("\u0007");
    const st = value.indexOf("\u001b\\");
    if (bel < 0 && st < 0) return undefined;
    if (bel >= 0 && (st < 0 || bel < st)) return bel + 1;
    return st + 2;
  }

  #prefixTail(value: string): number {
    const maximum = Math.min(PREFIX.length - 1, value.length);
    for (let length = maximum; length > 0; length -= 1) {
      if (PREFIX.startsWith(value.slice(-length))) return length;
    }
    return 0;
  }
}
