import type { ConfiguredMembership } from "@nanasa/contracts";

export function orderedMembershipEntries(
  memberships: Readonly<Record<string, ConfiguredMembership>>,
): Array<[string, ConfiguredMembership]> {
  return Object.entries(memberships)
    .map(([membershipId, membership], sourceIndex) => ({
      membershipId,
      membership,
      sourceIndex,
    }))
    .sort((left, right) => {
      const leftOrder = left.membership.order;
      const rightOrder = right.membership.order;
      if (leftOrder !== undefined && rightOrder !== undefined) {
        return (
          leftOrder - rightOrder ||
          left.sourceIndex - right.sourceIndex ||
          left.membershipId.localeCompare(right.membershipId)
        );
      }
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return (
        left.sourceIndex - right.sourceIndex || left.membershipId.localeCompare(right.membershipId)
      );
    })
    .map(({ membershipId, membership }) => [membershipId, membership]);
}

export function normalizeMembershipOrder(
  memberships: Readonly<Record<string, ConfiguredMembership>>,
): Record<string, ConfiguredMembership> {
  return Object.fromEntries(
    orderedMembershipEntries(memberships).map(([membershipId, membership], order) => [
      membershipId,
      { ...membership, order },
    ]),
  );
}
