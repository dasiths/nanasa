import { createHash } from "node:crypto";
import type { ScreenObservation } from "@nanasa/contracts";
import {
  SCREEN_MAX_BYTES,
  SCREEN_MAX_ROWS,
  ScreenManifestSchema,
  screenManifestDigest,
  type ScreenManifest,
} from "./screen-manifest.js";

export interface ScreenClassificationInput {
  runId: string;
  generation: number;
  paneId: string;
  text: string;
  alternateScreen?: boolean;
  observedAt?: string;
}

function sanitize(value: string): string {
  const withoutControls = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
  return withoutControls;
}

function boundedText(value: string): {
  text: string;
  rows: number;
  bytes: number;
  truncated: boolean;
} {
  const clean = sanitize(value);
  const lines = clean.split("\n").slice(-SCREEN_MAX_ROWS);
  let text = lines.join("\n");
  let bytes = Buffer.byteLength(text, "utf8");
  let truncated = lines.length < clean.split("\n").length;
  if (bytes > SCREEN_MAX_BYTES) {
    const data = Buffer.from(text, "utf8");
    text = data
      .subarray(data.length - SCREEN_MAX_BYTES)
      .toString("utf8")
      .replace(/^\uFFFD/, "");
    bytes = Buffer.byteLength(text, "utf8");
    truncated = true;
  }
  return { text, rows: text.length === 0 ? 0 : text.split("\n").length, bytes, truncated };
}

export class ScreenStatusClassifier {
  readonly #manifest: ScreenManifest;
  readonly #digest: string;

  public constructor(manifest: ScreenManifest) {
    this.#manifest = ScreenManifestSchema.parse(manifest);
    this.#digest = screenManifestDigest(this.#manifest);
  }

  public classify(input: ScreenClassificationInput): ScreenObservation {
    const bounded = boundedText(input.text);
    const rules = [...this.#manifest.rules].sort((left, right) => right.priority - left.priority);
    const match = rules.find((rule) => {
      const region = bounded.text.split("\n").slice(-rule.region.lastLines).join("\n");
      return (
        rule.all.every((value) => region.includes(value)) &&
        rule.none.every((value) => !region.includes(value))
      );
    });
    const classification = match?.classification ?? "unknown";
    return {
      runId: input.runId,
      generation: input.generation,
      paneId: input.paneId,
      observedAt: input.observedAt ?? new Date().toISOString(),
      captureHash: createHash("sha256").update(bounded.text).digest("hex"),
      rows: bounded.rows,
      bytes: bounded.bytes,
      truncated: bounded.truncated,
      alternateScreen: input.alternateScreen ?? false,
      manifestId: this.#manifest.id,
      manifestVersion: this.#manifest.version,
      manifestDigest: this.#digest,
      ...(match === undefined ? {} : { ruleId: match.id }),
      classification,
      confidence: classification === "blocked" && match?.visibleBlocker === true ? "medium" : "low",
      visibleBlocker: classification === "blocked" && match?.visibleBlocker === true,
    };
  }
}
