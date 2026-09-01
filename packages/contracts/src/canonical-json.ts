export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface CanonicalJsonOptions {
  readonly setLikePaths?: readonly string[];
}

export class CanonicalJsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function assertWellFormedUnicode(value: string, path: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError(`Unpaired high surrogate at ${path}`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalJsonError(`Unpaired low surrogate at ${path}`);
    }
  }
  return value.normalize("NFC");
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function canonicalize(value: unknown, path: string, setLikePaths: ReadonlySet<string>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError(`Non-finite number at ${path}`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") return JSON.stringify(assertWellFormedUnicode(value, path));
  if (Array.isArray(value)) {
    const items = value.map((item, index) => canonicalize(item, `${path}/${index}`, setLikePaths));
    if (setLikePaths.has(path)) items.sort(compareUtf8);
    return `[${items.join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new CanonicalJsonError(`Unsupported JSON value at ${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(`Non-plain object at ${path}`);
  }
  const normalized = new Map<string, unknown>();
  for (const [rawKey, item] of Object.entries(value)) {
    if (item === undefined) throw new CanonicalJsonError(`Undefined value at ${path}/${rawKey}`);
    const key = assertWellFormedUnicode(rawKey, `${path}/<key>`);
    if (normalized.has(key)) {
      throw new CanonicalJsonError(
        `Duplicate normalized object key ${JSON.stringify(key)} at ${path}`,
      );
    }
    normalized.set(key, item);
  }
  const keys = [...normalized.keys()].sort(compareUtf8);
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(normalized.get(key), `${path}/${key}`, setLikePaths)}`,
    )
    .join(",")}}`;
}

export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  return canonicalize(value, "", new Set(options.setLikePaths ?? []));
}

export function canonicalJsonBytes(value: unknown, options: CanonicalJsonOptions = {}): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value, options));
}

class StrictJsonParser {
  readonly #text: string;
  #offset = 0;

  public constructor(text: string) {
    this.#text = text;
  }

  public parse(): CanonicalJsonValue {
    this.#whitespace();
    const value = this.#value();
    this.#whitespace();
    if (this.#offset !== this.#text.length) this.#fail("Unexpected trailing input");
    return value;
  }

  #value(): CanonicalJsonValue {
    const character = this.#text[this.#offset];
    if (character === '"') return this.#string();
    if (character === "{") return this.#object();
    if (character === "[") return this.#array();
    if (character === "t") return this.#literal("true", true);
    if (character === "f") return this.#literal("false", false);
    if (character === "n") return this.#literal("null", null);
    return this.#number();
  }

  #object(): { readonly [key: string]: CanonicalJsonValue } {
    this.#offset += 1;
    this.#whitespace();
    const result: Record<string, CanonicalJsonValue> = Object.create(null) as Record<
      string,
      CanonicalJsonValue
    >;
    const keys = new Set<string>();
    if (this.#text[this.#offset] === "}") {
      this.#offset += 1;
      return result;
    }
    while (true) {
      if (this.#text[this.#offset] !== '"') this.#fail("Expected an object key");
      const key = this.#string();
      if (keys.has(key)) this.#fail(`Duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.#whitespace();
      if (this.#text[this.#offset] !== ":") this.#fail("Expected ':' after object key");
      this.#offset += 1;
      this.#whitespace();
      result[key] = this.#value();
      this.#whitespace();
      const delimiter = this.#text[this.#offset];
      if (delimiter === "}") {
        this.#offset += 1;
        return result;
      }
      if (delimiter !== ",") this.#fail("Expected ',' or '}' in object");
      this.#offset += 1;
      this.#whitespace();
    }
  }

  #array(): readonly CanonicalJsonValue[] {
    this.#offset += 1;
    this.#whitespace();
    const result: CanonicalJsonValue[] = [];
    if (this.#text[this.#offset] === "]") {
      this.#offset += 1;
      return result;
    }
    while (true) {
      result.push(this.#value());
      this.#whitespace();
      const delimiter = this.#text[this.#offset];
      if (delimiter === "]") {
        this.#offset += 1;
        return result;
      }
      if (delimiter !== ",") this.#fail("Expected ',' or ']' in array");
      this.#offset += 1;
      this.#whitespace();
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#offset += 1;
    let backslashes = 0;
    while (this.#offset < this.#text.length) {
      const character = this.#text[this.#offset];
      if (backslashes % 2 === 0 && character === '"') {
        this.#offset += 1;
        const parsed = JSON.parse(this.#text.slice(start, this.#offset)) as string;
        return assertWellFormedUnicode(parsed, `byte ${start}`);
      }
      if (backslashes % 2 === 0 && character !== undefined && character.charCodeAt(0) < 0x20) {
        this.#fail("Unescaped control character in string");
      }
      backslashes = character === "\\" ? backslashes + 1 : 0;
      this.#offset += 1;
    }
    this.#fail("Unterminated string");
  }

  #number(): number {
    const remainder = this.#text.slice(this.#offset);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remainder);
    if (match === null) this.#fail("Expected a JSON value");
    this.#offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.#fail("JSON number is outside the finite range");
    return value;
  }

  #literal<T extends CanonicalJsonPrimitive>(text: string, value: T): T {
    if (!this.#text.startsWith(text, this.#offset)) this.#fail(`Expected ${text}`);
    this.#offset += text.length;
    return value;
  }

  #whitespace(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.#text[this.#offset] ?? "")) {
      this.#offset += 1;
    }
  }

  #fail(message: string): never {
    throw new CanonicalJsonError(`${message} at byte ${this.#offset}`);
  }
}

export function parseStrictJson(text: string): CanonicalJsonValue {
  return new StrictJsonParser(text).parse();
}

export function requireCanonicalJson(
  text: string,
  options: CanonicalJsonOptions = {},
): CanonicalJsonValue {
  const value = parseStrictJson(text);
  if (canonicalJson(value, options) !== text) {
    throw new CanonicalJsonError("JSON bytes are not canonical");
  }
  return value;
}
