import { z } from "zod";
import { IdentifierSchema, TimestampSchema } from "./control-v1.js";

export const RepositorySchema = z
  .object({
    id: IdentifierSchema,
    commonDirectory: z.string().trim().min(1).max(4_096),
    objectFormat: z.enum(["sha1", "sha256"]),
    createdAt: TimestampSchema,
  })
  .strict();
export const CheckoutSchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    path: z.string().trim().min(1).max(4_096),
    gitDirectory: z.string().trim().min(1).max(4_096),
    head: z.string().trim().min(1).max(256),
    branch: z.string().trim().min(1).max(1_024).optional(),
    dirty: z.boolean(),
    observedAt: TimestampSchema,
  })
  .strict();
export const WorktreeSchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    checkoutId: IdentifierSchema,
    path: z.string().trim().min(1).max(4_096),
    provenanceToken: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(["creating", "ready", "removing", "removed", "failed"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export const GitOperationSchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    checkoutId: IdentifierSchema.optional(),
    kind: z.enum(["inspect", "create-worktree", "remove-worktree", "refresh"]),
    state: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const GitStatusProjectionSchema = z
  .object({
    checkoutId: IdentifierSchema,
    head: z.string().trim().min(1).max(256),
    branch: z.string().trim().min(1).max(1_024).optional(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    staged: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    untracked: z.number().int().nonnegative(),
    observedAt: TimestampSchema,
  })
  .strict();
