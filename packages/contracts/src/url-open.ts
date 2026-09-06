import { z } from "zod";
import { IdentifierSchema, TimestampSchema } from "./control.js";

export const BrowserUrlSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => {
    if (
      !/^https?:\/\//i.test(value) ||
      value.includes("\\") ||
      [...value].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      return false;
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        url.hostname.length > 0 &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }, "Expected an HTTP or HTTPS URL without credentials or control characters");

export const CreateUrlOpenRequestSchema = z.object({ url: BrowserUrlSchema }).strict();

export const UrlOpenRequestSchema = z
  .object({
    id: IdentifierSchema,
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    url: BrowserUrlSchema,
    requestedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();
export type UrlOpenRequest = z.infer<typeof UrlOpenRequestSchema>;
export const UrlOpenRequestListSchema = z.array(UrlOpenRequestSchema).max(500);
