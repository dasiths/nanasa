import { describe, expect, it } from "vitest";
import {
  ProviderUpdateOutcomeSchema,
  ProviderUpdatePlanSchema,
  ProviderUpdateRecoveryCommandSchema,
  ProviderUpdateRecoveryResultSchema,
  ProviderUpdateSafeErrorSchema,
} from "../src/index.js";

const digest = (character: string): string => character.repeat(64);

describe("provider update contracts", () => {
  it("accepts consistent current and outdated plans", () => {
    const common = {
      runId: "run-one",
      generation: 1,
      memberId: "member-one",
      providerId: "copilot",
      previousSnapshotDigest: digest("a"),
    } as const;
    expect(
      ProviderUpdatePlanSchema.parse({
        ...common,
        currentSnapshotDigest: digest("a"),
        status: "current",
      }).status,
    ).toBe("current");
    expect(
      ProviderUpdatePlanSchema.parse({
        ...common,
        currentSnapshotDigest: digest("b"),
        status: "outdated",
      }).status,
    ).toBe("outdated");
    expect(
      ProviderUpdatePlanSchema.safeParse({
        ...common,
        currentSnapshotDigest: digest("b"),
        status: "current",
      }).success,
    ).toBe(false);
  });

  it("models every reconciliation outcome with bounded safe errors", () => {
    const common = {
      runId: "run-one",
      generation: 1,
      memberId: "member-one",
      providerId: "copilot",
      previousSnapshotDigest: digest("a"),
      currentSnapshotDigest: digest("b"),
    } as const;
    for (const status of [
      "retained",
      "restarted",
      "approval-required",
      "ownership-uncertain",
      "failed",
    ] as const) {
      expect(ProviderUpdateOutcomeSchema.parse({ ...common, status }).status).toBe(status);
    }
    expect(
      ProviderUpdateSafeErrorSchema.parse({
        code: "provider_update_ownership_uncertain",
        message: "The old process could not be identified safely",
        retryable: true,
      }),
    ).toEqual({
      code: "provider_update_ownership_uncertain",
      message: "The old process could not be identified safely",
      retryable: true,
    });
  });

  it("defaults strict recovery options and validates batch results", () => {
    expect(ProviderUpdateRecoveryCommandSchema.parse({})).toEqual({
      dryRun: false,
      forceIndeterminate: false,
    });
    expect(
      ProviderUpdateRecoveryCommandSchema.safeParse({ dryRun: true, unexpected: true }).success,
    ).toBe(false);
    expect(
      ProviderUpdateRecoveryResultSchema.parse({
        groupId: "group-one",
        dryRun: true,
        outcomes: [
          {
            runId: "run-one",
            generation: 1,
            memberId: "member-one",
            providerId: "copilot",
            previousSnapshotDigest: digest("a"),
            currentSnapshotDigest: digest("a"),
            status: "retained",
          },
        ],
      }),
    ).toMatchObject({ groupId: "group-one", dryRun: true, outcomes: [{ status: "retained" }] });
  });
});
