---
title: Config-backed agent ordering research
description: Evidence and recommendation for one group-local agent order across Nanasa views
ms.date: 2026-08-11
ms.topic: concept
---

## Research questions

* Where agent membership and ordering are represented in contracts and YAML configuration
* How daemon configuration, topology, routes, and store projections determine current order
* How the portal orders the group tree, terminal tabs, and terminal grid panes
* Whether explicit numeric membership order plus one atomic reorder command is safer than alternatives
* What migration and default behavior preserve existing YAML semantics
* What active-run safety constraints and focused validation are required

## Findings

### Current ordering path

* `packages/contracts/src/index.ts` defines `ConfiguredMembershipSchema` without an order field.
  `ConfiguredGroupSchema.memberships` is a record keyed by stable membership ID.
  `GroupMembershipSchema` also has no presentation order.
* `apps/daemon/src/config.ts` parses YAML records into JavaScript records without an ordering
  normalization step. JavaScript preserves YAML mapping insertion order in this path, but that order
  is not represented as configuration data.
* `apps/daemon/src/config-repository.ts` already provides the required atomic write primitive.
  `ConfigRepository.mutate()` serializes changes. `ConfigRepository.#write()` verifies the source
  SHA-256 revision twice, validates the candidate YAML, writes and fsyncs a temporary file, renames
  it over `.nanasa/config.yaml`, and fsyncs the containing directory.
* `ConfigRepository.initializeTopology()` imports legacy SQLite topology by iterating the snapshot.
  It currently preserves snapshot membership array order only as YAML map insertion order.
* `apps/daemon/src/topology-service.ts` makes YAML the source of truth for portal topology changes.
  `TopologyService.addMembership()`, `updateMembership()`, and `removeMembership()` mutate one
  configured group and then call `NanasaStore.reconcileTopology()`.
* `NanasaStore.reconcileTopology()` in `apps/daemon/src/store.ts` compares sorted membership
  identity triples. Alias, role, instructions, and prospective display order do not affect
  `membershipRevision`. This is appropriate because that revision protects group broadcast
  recipient membership, not presentation.
* `NanasaStore.listActiveMemberships()` orders by `member_id, id`. `RunRuntimeCoordinator.startAll()`
  consumes this method, so start-all launch order is currently member-ID order.
* `NanasaStore.getSnapshot()` orders active memberships by `joined_at, id`. This is the current
  portal order and can differ from both YAML map order and `listActiveMemberships()` order.
* `apps/portal/src/App.tsx` filters `snapshot.memberships` for the selected group without sorting.
  It passes that array to `TerminalWorkspace` and uses the same snapshot in `GroupTree`.
* `GroupTree` in `apps/portal/src/components/group-tree.tsx` filters the snapshot array per group
  and maps it directly for the left tree.
* `TerminalWorkspace` in `apps/portal/src/components/terminal-workspace.tsx` starts with
  `members.map(...)` to build `availableRuns`. Both the terminal tab list and grid pane list map
  `availableRuns`, so they already share the incoming membership order.
* `usePortalSnapshot()` in `apps/portal/src/hooks/use-portal-snapshot.ts` fetches snapshot and config
  separately. A reorder command should use `snapshot.configStatus.revision`, which is aligned with
  the ordered snapshot projection, rather than infer concurrency from the separately fetched config.
* The current workspace `.nanasa/config.yaml` contains four memberships without order fields. The
  migration behavior must therefore preserve their existing YAML mapping order without requiring an
  immediate file rewrite.

### Alternatives considered

* YAML mapping order alone is implicit and is already lost when topology reaches SQLite. Reordering
  also requires reconstructing a record, and object-key order is a poor API contract.
* A separate `membershipOrder` array creates two sources that can drift when a membership is added,
  removed, or manually edited. It requires cross-field set validation on every load.
* Replacing the membership record with an array breaks the documented stable-key YAML shape and
  makes keyed lookup and migration more invasive.
* A SQLite `display_order` column makes runtime projection another persistence authority, requires a
  database migration, and can become stale after manual YAML edits.
* Portal preferences or local storage do not provide repository-wide persistence or synchronization
  across operators.
* Fractional ranks reduce writes for one move but introduce collisions, precision or string-rank
  complexity, and eventual rebalance. The expected group sizes do not justify that complexity.
* Updating one member's numeric order per request permits transient duplicates and partial reorders.
  A full permutation in one config mutation is easier to validate and commit atomically.

## Recommendation

### Data model and projection

Add an optional nonnegative integer `order` to `ConfiguredMembershipSchema`. Keep it out of
`GroupMembershipSchema` and out of SQLite. The snapshot membership array, not a duplicated runtime
field, should remain the portal's authoritative ordered projection.

Introduce one daemon helper, for example `normalizeConfiguredMemberships()`, with this algorithm:

1. Read `Object.entries(group.memberships)` in YAML source order and retain each source index.
2. Sort entries with explicit `order` values first by numeric order.
3. Resolve equal explicit values by source index, then membership ID as a final deterministic key.
4. Append entries with no `order` in source order. This preserves all existing YAML and makes a
   manually added orderless membership append after explicitly ordered members.
5. Return the entries with dense orders `0..n-1`.

Use the helper without writing during configuration load. Existing YAML therefore loads unchanged.
The first add, remove, or reorder mutation for a group should write dense orders for that group only.
`ConfigRepository.initializeTopology()` should assign dense order from the imported snapshot.
New memberships append at `normalized.length`; removal compacts the remaining target group.

Change `NanasaStore.getSnapshot()` to group active membership rows by the already ordered `groups`
array and sort each group with normalized configured order. Use the current `joined_at, id` sequence
as a deterministic fallback only when configuration is unavailable. Do not add a database column.
Leave `listActiveMemberships()` unchanged so this presentation feature does not silently change
start-all launch order, status enumeration, recovery, or delivery behavior.

### Atomic API

Add these shared contract symbols in `packages/contracts/src/index.ts`:

```ts
ReorderGroupMembershipsCommandSchema = z.object({
  memberIds: z.array(IdentifierSchema).max(256),
  expectedConfigRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine(/* memberIds must be unique */)

ReorderGroupMembershipsResultSchema = z.object({
  groupId: IdentifierSchema,
  memberIds: z.array(IdentifierSchema),
  configRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
```

Use `PUT /api/groups/:groupId/membership-order`. `PUT` matches full replacement semantics and avoids
the dynamic `memberships/:memberId` route. The command must contain every current configured member
ID exactly once. Return `400` for duplicate input, `404` for a missing group, and `409` with a stable
code such as `membership_order_stale` when the set differs or `config_revision_conflict` when the
expected SHA revision is stale.

Extend the callback invocation in `ConfigRepository.mutate()` to supply the queued
`LoadedNanasaConfig` alongside the cloned config. `TopologyService.reorderMemberships()` can then
check `expectedConfigRevision` inside the serialized mutation, validate exact set equality, assign
dense orders, and commit all values through the existing atomic writer. Reconcile the store, record
a `membership.reordered` runtime event for portal refresh, and return the newly loaded config
revision. Do not increment `Group.membershipRevision`.

Add `PortalClient.reorderMemberships()` and its `api` implementation in
`apps/portal/src/api.ts`. Add an `App` action that sends the current group-local member permutation
and `snapshot.configStatus.revision`, refreshes on success, and refreshes after a conflict. Add an
`onReorderAgents` prop to `GroupTree`. The smallest accessible UI is a pair of Move up and Move down
commands in each member's existing action menu; each command swaps adjacent IDs and sends the full
permutation. This avoids a drag-and-drop dependency while leaving the API suitable for future drag
reordering.

### Active-run safety

Reordering is safe while runs are active because it changes no group ID, membership ID, member ID,
profile, role, prompt, run row, desired state, generation, terminal binding, or delivery audience.
It should not use the stop-before-change guards that protect instruction and role changes.

React keys are already `member.id` in the tree and `run.id` in terminal tabs and panes. A snapshot
refresh should therefore move existing components rather than recreate run state. Tab layout keeps
only the selected run mounted and should preserve `selectedRunId`. Grid layout moves keyed iframe
nodes; browser behavior should be validated end to end because an iframe reconnect would matter to
ttyd's one-client constraint even if React does not remount the component.

### Focused validation plan

* Extend `packages/contracts/test/contracts.test.ts` for missing and explicit order, invalid negative
  values, reorder-command uniqueness, and result parsing.
* Extend `apps/daemon/test/config.test.ts` for old YAML source order, sparse values, duplicate values,
  mixed explicit and missing values, lazy migration, and ordered legacy SQLite import.
* Add a focused `NanasaStore` test proving snapshot order follows config even when joined timestamps
  and member IDs disagree, while `listActiveMemberships()` retains its existing operational order.
* Extend `apps/daemon/test/server.test.ts` for successful full reorder, dense YAML persistence,
  exact-set rejection, stale revision rejection, unchanged `membershipRevision`, event publication,
  and an active run retaining its run and terminal identity.
* Extend `apps/portal/src/api.test.ts` for the encoded `PUT` route, validated request body, and parsed
  result.
* Extend `apps/portal/src/App.test.tsx` for tree order, adjacent move commands, full-permutation body,
  busy state, and conflict refresh behavior.
* Extend `apps/portal/src/components/terminal-workspace.test.tsx` by reversing `members` and asserting
  both tab DOM order and grid region order, plus preservation of the selected run.
* Add one acceptance path that starts three runs, reorders while grid terminals are live, verifies
  left tree, tabs, and panes agree, confirms terminal continuity, restarts the daemon, and verifies
  the persisted order from `.nanasa/config.yaml` is restored.

## Clarifying questions

* None. The requested three portal surfaces already share one snapshot membership array, so the
  projection boundary and minimal persistence owner are unambiguous.
