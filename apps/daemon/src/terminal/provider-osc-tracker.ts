export interface ProviderOscSnapshot {
  readonly title?: string;
  readonly progress?: string;
  readonly revision: number;
}

type ParserState =
  | "ground"
  | "escape"
  | "osc"
  | "osc-escape"
  | "ignored-string"
  | "ignored-string-escape"
  | "oversized"
  | "oversized-escape";

const MAX_OSC_BODY_BYTES = 4_096;
const MAX_RETAINED_CHARACTERS = 256;

function sanitize(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("")
    .slice(0, MAX_RETAINED_CHARACTERS);
}

export class ProviderOscTracker {
  #state: ParserState = "ground";
  #body: number[] = [];
  #title: string | undefined;
  #progress: string | undefined;
  #revision = 0;

  public observe(bytes: Uint8Array): boolean {
    const previousRevision = this.#revision;
    for (const byte of bytes) this.#observeByte(byte);
    return this.#revision !== previousRevision;
  }

  public snapshot(): ProviderOscSnapshot {
    return Object.freeze({
      ...(this.#title === undefined ? {} : { title: this.#title }),
      ...(this.#progress === undefined ? {} : { progress: this.#progress }),
      revision: this.#revision,
    });
  }

  public resetForProcess(): void {
    this.#state = "ground";
    this.#body = [];
    this.#title = undefined;
    this.#progress = undefined;
    this.#revision += 1;
  }

  #observeByte(byte: number): void {
    switch (this.#state) {
      case "ground":
        if (byte === 0x1b) this.#state = "escape";
        return;
      case "escape":
        if (byte === 0x5d) {
          this.#body = [];
          this.#state = "osc";
        } else if ([0x50, 0x5f, 0x5e, 0x58].includes(byte)) {
          this.#body = [];
          this.#state = "ignored-string";
        } else {
          this.#state = byte === 0x1b ? "escape" : "ground";
        }
        return;
      case "osc":
        if (byte === 0x07) this.#finalize();
        else if (byte === 0x1b) this.#state = "osc-escape";
        else this.#append(byte);
        return;
      case "osc-escape":
        if (byte === 0x5c) this.#finalize();
        else {
          const acceptedEscape = this.#append(0x1b);
          const acceptedByte = acceptedEscape && this.#append(byte);
          if (acceptedByte) this.#state = "osc";
        }
        return;
      case "ignored-string":
        if (byte === 0x1b) this.#state = "ignored-string-escape";
        return;
      case "ignored-string-escape":
        if (byte === 0x5c) this.#state = "ground";
        else if (byte !== 0x1b) this.#state = "ignored-string";
        return;
      case "oversized":
        if (byte === 0x07) this.#state = "ground";
        else if (byte === 0x1b) this.#state = "oversized-escape";
        return;
      case "oversized-escape":
        if (byte === 0x5c) this.#state = "ground";
        else if (byte !== 0x1b) this.#state = "oversized";
    }
  }

  #append(byte: number): boolean {
    this.#body.push(byte);
    if (this.#body.length > MAX_OSC_BODY_BYTES) {
      this.#body = [];
      this.#state = "oversized";
      return false;
    }
    return true;
  }

  #finalize(): void {
    const body = Buffer.from(this.#body).toString("utf8");
    this.#body = [];
    this.#state = "ground";
    const separator = body.indexOf(";");
    if (separator < 0) return;
    const code = body.slice(0, separator);
    const value = sanitize(body.slice(separator + 1));
    if (code === "0" || code === "2") {
      if (this.#title !== value) {
        this.#title = value;
        this.#revision += 1;
      }
    } else if (code === "9" && this.#progress !== value) {
      this.#progress = value;
      this.#revision += 1;
    }
  }
}
