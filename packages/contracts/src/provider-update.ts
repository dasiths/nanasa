import { z } from "zod";
import { CustomLaunchConsentRequestSchema } from "./launch-consent.js";
import { ProviderIdSchema, RunGenerationSchema, SnapshotDigestSchema } from "./provider-runtime.js";
import { ProviderUpdateSafeErrorSchema } from "./provider-update-state.js";

const IdentifierSchema = z.string().min(1).max(128);

export const ProviderUpdatePlanStatusSchema = z.enum(["current", "outdated"]);
export type ProviderUpdatePlanStatus = z.infer<typeof ProviderUpdatePlanStatusSchema>;

export const ProviderUpdatePlanSchema = z
  .object({
    runId: IdentifierSchema,
    generation: RunGenerationSchema,
    memberId: IdentifierSchema,
    providerId: ProviderIdSchema,
    previousSnapshotDigest: SnapshotDigestSchema,
    currentSnapshotDigest: SnapshotDigestSchema,
    status: ProviderUpdatePlanStatusSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    const digestsMatch = plan.previousSnapshotDigest === plan.currentSnapshotDigest;
    if ((plan.status === "current") !== digestsMatch) {
      context.addIssue({
        code: "custom",
        message: "Provider update status must match the snapshot digest comparison",
        path: ["status"],
      });
    }
  });
export type ProviderUpdatePlan = z.infer<typeof ProviderUpdatePlanSchema>;

export const ProviderUpdateOutcomeStatusSchema = z.enum([
  "retained",
  "restarted",
  "approval-required",
  "ownership-uncertain",
  "failed",
]);
export type ProviderUpdateOutcomeStatus = z.infer<typeof ProviderUpdateOutcomeStatusSchema>;

export const ProviderUpdateOutcomeSchema = z
  .object({
    runId: IdentifierSchema,
    generation: RunGenerationSchema,
    memberId: IdentifierSchema,
    providerId: ProviderIdSchema,
    previousSnapshotDigest: SnapshotDigestSchema,
    currentSnapshotDigest: SnapshotDigestSchema,
    status: ProviderUpdateOutcomeStatusSchema,
    replacementRunId: IdentifierSchema.optional(),
    consentRequest: CustomLaunchConsentRequestSchema.optional(),
    safeError: ProviderUpdateSafeErrorSchema.optional(),
  })
  .strict();
export type ProviderUpdateOutcome = z.infer<typeof ProviderUpdateOutcomeSchema>;

export const ProviderUpdateRecoveryCommandSchema = z
  .object({
    dryRun: z.boolean().default(false),
    forceIndeterminate: z.boolean().default(false),
  })
  .strict();
export type ProviderUpdateRecoveryCommand = z.infer<typeof ProviderUpdateRecoveryCommandSchema>;

export const ProviderUpdateRecoveryResultSchema = z
  .object({
    groupId: IdentifierSchema,
    dryRun: z.boolean(),
    outcomes: z.array(ProviderUpdateOutcomeSchema),
  })
  .strict();
export type ProviderUpdateRecoveryResult = z.infer<typeof ProviderUpdateRecoveryResultSchema>;
