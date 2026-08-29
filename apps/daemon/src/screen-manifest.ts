import { createHash } from "node:crypto";
import { z } from "zod";
import { IdentifierSchema } from "@nanasa/contracts";

export const SCREEN_MAX_ROWS = 80;
export const SCREEN_MAX_BYTES = 65_536;
export const SCREEN_MAX_RULES = 64;
export const SCREEN_MAX_MATCHERS = 512;
export const SCREEN_MAX_MATCHER_CHARS = 256;
export const SCREEN_CAPTURE_CONCURRENCY = 4;

const MatcherSchema = z.string().min(1).max(SCREEN_MAX_MATCHER_CHARS);
export const ScreenManifestRuleSchema = z
  .object({
    id: IdentifierSchema,
    priority: z.number().int().min(-10_000).max(10_000),
    classification: z.enum(["blocked", "working_hint", "idle_hint", "skip"]),
    visibleBlocker: z.boolean().default(false),
    region: z.object({ lastLines: z.number().int().min(1).max(SCREEN_MAX_ROWS) }).strict(),
    all: z.array(MatcherSchema).min(1).max(16),
    none: z.array(MatcherSchema).max(16).default([]),
  })
  .strict();
export const ScreenManifestSchema = z
  .object({
    id: IdentifierSchema,
    version: z.string().trim().min(1).max(32),
    rules: z.array(ScreenManifestRuleSchema).max(SCREEN_MAX_RULES),
  })
  .strict()
  .superRefine((manifest, context) => {
    const count = manifest.rules.reduce(
      (total, rule) => total + rule.all.length + rule.none.length,
      0,
    );
    if (count > SCREEN_MAX_MATCHERS) {
      context.addIssue({
        code: "custom",
        message: `A screen manifest may contain at most ${SCREEN_MAX_MATCHERS} matchers`,
        path: ["rules"],
      });
    }
    const ids = new Set(manifest.rules.map((rule) => rule.id));
    if (ids.size !== manifest.rules.length) {
      context.addIssue({
        code: "custom",
        message: "Screen rule IDs must be unique",
        path: ["rules"],
      });
    }
  });
export type ScreenManifest = z.infer<typeof ScreenManifestSchema>;

export function screenManifestDigest(manifest: ScreenManifest): string {
  return createHash("sha256")
    .update(JSON.stringify(ScreenManifestSchema.parse(manifest)))
    .digest("hex");
}
