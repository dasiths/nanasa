import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { TerminalServerFrame } from "@nanasa/contracts";
import {
  TERMINAL_CLIPBOARD_MAX_BYTES,
  TERMINAL_EFFECT_TTL_MS,
} from "./terminal-transport-limits.js";

const MAX_ENCODED_BYTES = Math.ceil(TERMINAL_CLIPBOARD_MAX_BYTES / 3) * 4 + 64;
const MAX_OSC_BYTES = 16 * 1024;
const FORWARDED_OSC = new Set([
  "0",
  "1",
  "2",
  "4",
  "8",
  "10",
  "11",
  "12",
  "104",
  "110",
  "111",
  "112",
]);

type StringControl = "osc" | "blocked";

export class TerminalEffectPolicy {
  #state: "normal" | "escape" | "string" = "normal";
  #control: StringControl = "blocked";
  #prefix = "";
  #bodyParts: string[] = [];
  #bodyPrefix = "";
  #bodyBytes = 0;
  #escaped = false;
  #overflow = false;

  public filter(
    data: string,
    allowEffects: boolean,
  ): { output: string; effects: TerminalServerFrame[] } {
    let output = "";
    const effects: TerminalServerFrame[] = [];
    for (const character of data) {
      if (this.#state === "normal") {
        if (character === "\u001b") {
          this.#state = "escape";
        } else if (character === "\u009d") {
          this.#startString("osc", character);
        } else if (["\u0090", "\u0098", "\u009e", "\u009f"].includes(character)) {
          this.#startString("blocked", character);
        } else {
          output += character;
        }
        continue;
      }

      if (this.#state === "escape") {
        if (character === "]") this.#startString("osc", "\u001b]");
        else if (["P", "X", "^", "_"].includes(character)) {
          this.#startString("blocked", `\u001b${character}`);
        } else if (character === "\u001b") {
          output += "\u001b";
        } else {
          output += `\u001b${character}`;
          this.#state = "normal";
        }
        continue;
      }

      if (this.#escaped) {
        if (character === "\\") {
          output += this.#finishString("\u001b\\", allowEffects, effects);
          continue;
        }
        this.#appendBody("\u001b");
        this.#escaped = false;
      }

      if (character === "\u001b") {
        this.#escaped = true;
        continue;
      }
      if (character === "\u009c") {
        output += this.#finishString(character, allowEffects, effects);
        continue;
      }
      if (character === "\u0018" || character === "\u001a") {
        this.#resetString();
        continue;
      }
      if (this.#control === "osc" && character === "\u0007") {
        output += this.#finishString(character, allowEffects, effects);
        continue;
      }
      this.#appendBody(character);
    }
    return { output, effects };
  }

  public reset(): void {
    this.#state = "normal";
    this.#resetString();
  }

  #startString(control: StringControl, prefix: string): void {
    this.#state = "string";
    this.#control = control;
    this.#prefix = prefix;
    this.#bodyParts = [];
    this.#bodyPrefix = "";
    this.#bodyBytes = 0;
    this.#escaped = false;
    this.#overflow = false;
  }

  #appendBody(value: string): void {
    if (this.#overflow || this.#control === "blocked") return;
    this.#bodyBytes += Buffer.byteLength(value, "utf8");
    const prefix = (this.#bodyPrefix + value).slice(0, 3);
    const limit = `52;`.startsWith(prefix) ? MAX_ENCODED_BYTES : MAX_OSC_BYTES;
    if (this.#bodyBytes > limit) {
      this.#overflow = true;
      this.#bodyParts = [];
      return;
    }
    this.#bodyParts.push(value);
    this.#bodyPrefix = prefix;
  }

  #finishString(terminator: string, allowEffects: boolean, effects: TerminalServerFrame[]): string {
    let output = "";
    if (this.#control === "osc" && !this.#overflow) {
      const body = this.#bodyParts.join("");
      if (body.startsWith("52;")) this.#createEffect(body.slice(3), allowEffects, effects);
      else {
        const identifier = body.split(";", 1)[0] ?? "";
        if (FORWARDED_OSC.has(identifier)) output = this.#prefix + body + terminator;
      }
    }
    this.#resetString();
    return output;
  }

  #createEffect(body: string, allowEffects: boolean, effects: TerminalServerFrame[]): void {
    const separator = body.indexOf(";");
    if (separator < 0 || body.slice(0, separator) !== "c" || !allowEffects) return;
    const encoded = body.slice(separator + 1);
    if (
      encoded.length === 0 ||
      encoded === "?" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      return;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.length > TERMINAL_CLIPBOARD_MAX_BYTES || bytes.includes(0))
      return;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return;
    }
    effects.push({
      type: "effect",
      effectId: `effect_${randomUUID()}`,
      kind: "clipboard-write",
      byteCount: bytes.length,
      preview: "",
      data: text,
      expiresAt: new Date(Date.now() + TERMINAL_EFFECT_TTL_MS).toISOString(),
    });
  }

  #resetString(): void {
    this.#state = "normal";
    this.#control = "blocked";
    this.#prefix = "";
    this.#bodyParts = [];
    this.#bodyPrefix = "";
    this.#bodyBytes = 0;
    this.#escaped = false;
    this.#overflow = false;
  }
}
