import { z } from "zod";
import { ConfiguredAgentIdSchema, IdentifierSchema, TimestampSchema } from "./control-v1.js";
export const GitObjectFormatSchema = z.enum(["sha1", "sha256"]);
export const GitRefStorageSchema = z.enum(["files", "reftable"]);
export const CheckoutKindSchema = z.enum(["primary", "linked", "bare"]);

export const RepositorySchema = z
  .object({
    id: IdentifierSchema,
    commonDirectory: z.string().trim().min(1).max(4_096),
    displayName: z.string().trim().min(1).max(256),
    objectFormat: GitObjectFormatSchema,
    refStorage: GitRefStorageSchema,
    primaryCheckoutId: IdentifierSchema.optional(),
    revision: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Repository = z.infer<typeof RepositorySchema>;

export const CheckoutSchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    checkoutKey: z.string().regex(/^[0-9a-f]{64}$/),
    path: z.string().trim().min(1).max(4_096),
    gitDirectory: z.string().trim().min(1).max(4_096),
    kind: CheckoutKindSchema,
    head: z.string().trim().min(1).max(256).optional(),
    branch: z.string().trim().min(1).max(1_024).optional(),
    dirty: z.boolean(),
    observedAt: TimestampSchema,
  })
  .strict();
export type Checkout = z.infer<typeof CheckoutSchema>;

export const WorktreeSchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    checkoutId: IdentifierSchema,
    sourceCheckoutId: IdentifierSchema,
    path: z.string().trim().min(1).max(4_096),
    branch: z.string().trim().min(1).max(1_024),
    base: z.string().trim().min(1).max(1_024),
    provenanceToken: z.string().regex(/^[0-9a-f]{64}$/),
    operationGeneration: z.number().int().positive(),
    state: z.enum(["creating", "ready", "removing", "removed", "failed"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Worktree = z.infer<typeof WorktreeSchema>;

export const GitOperationSchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    checkoutId: IdentifierSchema.optional(),
    worktreeId: IdentifierSchema.optional(),
    kind: z.enum(["inspect", "create-worktree", "remove-worktree", "refresh"]),
    generation: z.number().int().positive(),
    targetPath: z.string().trim().min(1).max(4_096).optional(),
    state: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type GitOperation = z.infer<typeof GitOperationSchema>;

export const GitStatusProjectionSchema = z
  .object({
    checkoutId: IdentifierSchema,
    head: z.string().trim().min(1).max(256).optional(),
    branch: z.string().trim().min(1).max(1_024).optional(),
    detached: z.boolean(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    staged: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    untracked: z.number().int().nonnegative(),
    observedAt: TimestampSchema,
  })
  .strict();
export type GitStatusProjection = z.infer<typeof GitStatusProjectionSchema>;

export const CreateWorktreeCommandSchema = z
  .object({
    sourceCheckoutId: IdentifierSchema,
    branch: z.string().trim().min(1).max(1_024),
    base: z.string().trim().min(1).max(1_024).default("HEAD"),
    assignAgentIds: z.array(ConfiguredAgentIdSchema).max(256).default([]),
  })
  .strict();
export type CreateWorktreeCommand = z.infer<typeof CreateWorktreeCommandSchema>;

export const OpenCheckoutCommandSchema = z
  .object({
    sourceCheckoutId: IdentifierSchema,
    path: z.string().trim().min(1).max(4_096).optional(),
    branch: z.string().trim().min(1).max(1_024).optional(),
  })
  .strict()
  .refine((value) => (value.path === undefined) !== (value.branch === undefined), {
    message: "Open checkout requires exactly one path or branch selector",
  });
export type OpenCheckoutCommand = z.infer<typeof OpenCheckoutCommandSchema>;

export const RemoveWorktreeCommandSchema = z
  .object({
    force: z.boolean().default(false),
    expectedOperationGeneration: z.number().int().positive(),
  })
  .strict();
export type RemoveWorktreeCommand = z.infer<typeof RemoveWorktreeCommandSchema>;

export const AssignAgentCheckoutCommandSchema = z.object({ checkoutId: IdentifierSchema }).strict();
export type AssignAgentCheckoutCommand = z.infer<typeof AssignAgentCheckoutCommandSchema>;

export const WorktreeOperationResultSchema = z
  .object({
    operation: GitOperationSchema,
    checkout: CheckoutSchema.optional(),
    worktree: WorktreeSchema.optional(),
  })
  .strict();
export type WorktreeOperationResult = z.infer<typeof WorktreeOperationResultSchema>;
