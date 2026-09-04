import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(128);
const TimestampSchema = z.string().datetime({ offset: true });
const ProviderIdSchema = z.string().min(1).max(128);
const RunGenerationSchema = z.number().int().positive();
const SnapshotDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ProviderUpdateTransitionStateSchema = z.enum(["pending", "in-progress", "completed"]);
export type ProviderUpdateTransitionState = z.infer<typeof ProviderUpdateTransitionStateSchema>;

export const ProviderUpdateTransitionOutcomeSchema = z.enum([
  "restarted",
  "approval-required",
  "ownership-uncertain",
  "failed",
]);
export type ProviderUpdateTransitionOutcome = z.infer<typeof ProviderUpdateTransitionOutcomeSchema>;

export const ProviderUpdateSafeErrorSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
  })
  .strict();
export type ProviderUpdateSafeError = z.infer<typeof ProviderUpdateSafeErrorSchema>;

export const ProviderUpdateTransitionSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    generation: RunGenerationSchema,
    memberId: IdentifierSchema,
    providerId: ProviderIdSchema,
    previousSnapshotDigest: SnapshotDigestSchema,
    currentSnapshotDigest: SnapshotDigestSchema,
    state: ProviderUpdateTransitionStateSchema,
    outcome: ProviderUpdateTransitionOutcomeSchema.optional(),
    replacementRunId: IdentifierSchema.optional(),
    safeError: ProviderUpdateSafeErrorSchema.optional(),
    detectedAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((transition, context) => {
    if (transition.previousSnapshotDigest === transition.currentSnapshotDigest) {
      context.addIssue({
        code: "custom",
        message: "Provider update transition requires different snapshot digests",
        path: ["currentSnapshotDigest"],
      });
    }
    const completed = transition.state === "completed";
    if (completed !== (transition.outcome !== undefined && transition.completedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Completed provider updates require an outcome and completion time",
        path: ["state"],
      });
    }
    if (transition.outcome === "restarted" && transition.replacementRunId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Restarted provider updates require a replacement run",
        path: ["replacementRunId"],
      });
    }
  });
export type ProviderUpdateTransition = z.infer<typeof ProviderUpdateTransitionSchema>;
