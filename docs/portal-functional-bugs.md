---
title: Portable portal and runtime bug fixes
description: Independent defects, minimal fixes, regression checks, and fresh-branch application guidance separate from the portal redesign
ms.date: 2026-09-06
---

## Purpose and provenance

These fixes can be considered independently of the entity-first UI/UX proposal.
Work is recorded on `feat/portal-entity-design`, starting from `add9ccf`.
The UI/UX remains unaccepted. No separate bug-only branch has been created.

Two daemon-only commits can be selected without taking the UI redesign:

| Issue | Commit | Contents |
| --- | --- | --- |
| BUG-001 | `c01f0e7` | Group-deletion audit retention and persistence regression |
| BUG-002 | `064941d` | Exhausted dead-run status and coordinator regressions |

The remaining fixes are documented below but share a work-in-progress portal
commit with UI changes; extract their minimal behavior rather than that commit.

Do not cherry-pick the entire redesign or copy whole mixed files. The source
locations below identify the behavior to reapply on the chosen fresh-branch base.
Test selectors may need adaptation to that base's existing portal.

## BUG-001 Group deletion breaks immutable provider references

Status: fixed and regression-tested on the working branch. Pre-existing failure
also reproduced on an unmodified `add9ccf` build.

Deleting a team with managed provider runs stopped its processes but failed with
`FOREIGN KEY constraint failed`. Deletion attempted to remove run records still
referenced by deliberately immutable provider bindings and dependent audit data.

Minimal fix in [store.ts](../apps/daemon/src/store.ts), `deleteGroup`: exclude
run records referenced by `run_provider_bindings`, or either `run_id` or
`replacement_run_id` in `provider_update_transitions`, from physical run deletion.
Keep the existing group cleanup transaction, stop ordering, and idempotency.
Do not disable foreign keys, remove immutability triggers, or erase provider audits.

Portable regression in
[provider-snapshot-persistence.test.ts](../apps/daemon/test/provider-snapshot-persistence.test.ts):
delete an active membership's group after its runs stop; retain both a bound run
and transition-linked replacement; verify idempotency, immutable audit rows,
and `PRAGMA foreign_key_check`. Existing store/coordinator deletion tests and
real-daemon CRUD also pass.

Dependencies: current provider-platform tables must exist on the target base.
No portal redesign dependency. `deletedRuns` counts physical deletions, not
retained historical anchors. Existing profile-based snapshot history can still
show historical runs when an agent is active in another group.

## BUG-002 Exhausted dead runs remain recorded as running

Status: fixed and all 19 coordinator tests pass; also observed in the operator's
real backend Pi run. No live operator run was changed during investigation.

A dead pane with exhausted recovery remained `status: running` and
`recoveryPhase: failed`. The portal counted it as live, and a new start collided
with `run_already_active`.

Minimal fix in
[run-runtime-coordinator.ts](../apps/daemon/src/run-runtime-coordinator.ts),
`#recoverMissingRun`: when the retry limit is reached for a confirmed absent/dead
run, transition running/starting status to failed before returning. Preserve
desired state and retry budget. Do not apply this status change to a still-present
process being considered for forced fresh fallback (`forceFresh`).

Portable regression in
[run-runtime-coordinator.test.ts](../apps/daemon/test/run-runtime-coordinator.test.ts):
cover both reconciling and already-failed recovery phases, assert failed status,
no new generation, preserved stop capability, and no automatic relaunch.

Dependencies: none on the redesigned UI. Reconciliation applies after the updated
daemon is started. This fix does not explain or restore a missing Pi session.

## BUG-003 Active failed-recovery runs lose their Stop control

Status: fixed in the redesigned portal. The legacy tree has a similar lifecycle
decision that must be checked on a fresh-branch base rather than copied blindly.

Failed recovery was tested before active process status, offering Retry start and
disabling Stop even when the daemon still considered the run active.

Behavior to port: running, starting, and stopping records must offer Stop before
any failed-recovery retry decision. Stop remains available for in-progress
recovery. Only stopped/failed inactive records should offer Start or Retry.

Current implementation: `entityRunAction` in
[entity-management.tsx](../apps/portal/src/components/entity-management.tsx).
Legacy implementation surface: `runAction` in
[group-tree.tsx](../apps/portal/src/components/group-tree.tsx).
Do not bring `EntityManagementContext`, inspectors, or Teams navigation into a
bug-only branch solely to carry this predicate.

Regression behavior in
[entity-management.test.tsx](../apps/portal/src/components/entity-management.test.tsx)
and [portal-entity-workspaces.spec.ts](../test/acceptance/portal-entity-workspaces.spec.ts):
an active failed-recovery run must allow confirmed Stop; subsequent Start creates
a fresh generation with zero recovery attempts and no resume-session ID; the
teammate's run and pane remain unchanged. Adapt locators to the old controls.

## BUG-004 Directory resolves configuration using the membership record ID

Status: fixed; distinct-ID and existing directory tests pass. Pre-existing
directory projection issue exposed by the migration.

`membership.id` can differ from the configured agent key. Indexing configuration
with that ID hides integration, role, prompt, and edit data for valid agents.

Minimal fix in
[agent-directory-model.ts](../apps/portal/src/components/agent-directory-model.ts),
`agentDirectoryEntries`: resolve the configured entry by stable `memberId`, with
the existing profile-key fallback, and use the configured key for provider-home
mapping. No row layout or inspector redesign is required.

Portable test: make membership ID, member ID, and configured key distinct; assert
the correct integration, role, instruction layers, and provider-home path.
Existing [directory tests](../apps/portal/src/components/agent-directory-model.test.ts)
can host this fixture on a fresh branch. The current distinct-ID management test
also verifies update commands address the configured key.

## BUG-005 Provider inspection responses can arrive out of order

Status: guarded on this branch; existing provider lifecycle tests pass. A focused
out-of-order response test is still desirable before a standalone extraction.

Selecting provider B before provider A's inspection resolves can display A's plan
with B's selected identity. A refresh can race with selection in the same way.

Minimal behavior in
[extensions-workspace.tsx](../apps/portal/src/components/extensions-workspace.tsx):
version asynchronous load/selection requests, clear old inspection on selection,
and accept results/errors only for the latest request. Disable switching while a
lifecycle operation is pending. Preserve exact-plan and revision validation.

This file also contains extensive design changes. Port only asynchronous state
handling, not the new tabs, catalog rows, or removal presentation.

## Optional feedback and error-handling changes

These need a product decision, not automatic inclusion in a bug-only branch:

* Explicit healthy setup previews now provide visible results. The former
  behavior intentionally stayed quiet and had a test asserting that. The change
  is in `shouldShowRecoveryResults` in [App.tsx](../apps/portal/src/App.tsx);
  automatic startup reconciliation stays quiet. Port only with approval of the
  feedback behavior, adapting its existing test.
* Provider-state lifecycle, checkpoint deletion, and service restart-preview
  promise failures are surfaced via `ErrorNotice` in
  [portal-route-panels.tsx](../apps/portal/src/routes/portal-route-panels.tsx).
  These catches can be extracted independently of the new section layout.

## OPEN-001 Pi cannot resolve its recorded native session

Status: diagnosed, root cause of session unavailability not established.

Backend Engineer 1 exited with code 1 while resuming a recorded session; retained
output said `No session found matching` the recorded session ID. Its third
recovery attempt exhausted the budget. Frontend Pi had sufficient budget to use
`native_resume_fallback_restart` and recovered on attempt 2.

The agents share a Pi integration but use separate provider-state homes. Missing
files, launch-context mismatch, and session-reference validity have not been
distinguished. Do not describe this as an authentication failure or delete
session files based on this evidence. BUG-002 and BUG-003 fix status and operator
recovery access, not native-session lookup. No operator agent was restarted.

## OPEN-002 Workspace validation feedback appears behind the dialog

Status: observed in both pinned old (`add9ccf`) and new (`0b194f7`) portals during
the Full HD comparison. Not fixed as part of the screenshot task.

Reproduction: open Workspaces, Add workspace, enter `invalid branch name`, and
submit Create workspace. The actual API returns `invalid_worktree_branch`; the
error notice is outside the still-open dialog and dimmed by its backdrop. This
can make it unclear why submission failed, even though the draft is preserved.

Evidence: [old capture](assets/portal-comparison/old-workspace-error-dark.png) and
[new capture](assets/portal-comparison/new-workspace-error-dark.png).
The owning component is
[checkout-workspace.tsx](../apps/portal/src/components/checkout-workspace.tsx).
A prospective fix should put operation-specific errors inside the active dialog
without changing workspace validation or dropping error codes. Add a regression
that checks the error is visible within the dialog and the entered values remain.

## Fresh-branch application checklist

1. Choose the desired base and verify which defects remain reproducible there.
2. Apply each selected minimal fix separately. BUG-001 and BUG-002 are daemon-only;
   BUG-003 through BUG-005 can be applied to existing frontend abstractions.
3. Bring only the relevant regression fixtures/assertions. Do not copy all App or
   acceptance test rewrites, because many assert redesign-specific controls.
4. Run the focused checks below and the target branch's existing tests.
5. Use the standalone commit mapping above for BUG-001 and BUG-002 when compatible
   with the chosen base. Record new commits for any other extracted fixes.

Before package commands, follow [AGENTS.md](../AGENTS.md) and load the configured
registry environment without printing its contents.

```bash
pnpm --filter @nanasa/daemon exec vitest run test/provider-snapshot-persistence.test.ts
pnpm --filter @nanasa/daemon exec vitest run test/run-runtime-coordinator.test.ts -t 'exhausted|delet|remov'
pnpm --filter @nanasa/portal exec vitest run src/components/agent-directory-model.test.ts
pnpm --filter @nanasa/portal exec vitest run src/components/extensions-workspace.test.tsx
```

## Independent harness correction

The Start All messaging acceptance test assumed three terminal regions meant all
three run records already had pane bindings. That can race with launch. In
[start-and-messaging.spec.ts](../test/acceptance/start-and-messaging.spec.ts), wait
for each selected member's authoritative running run and nonempty pane ID before
capturing the run-to-pane map. The focused messaging test passes after this change.
This synchronization improvement can be ported without UI selector rewrites.

The separate [UI/UX ledger](portal-ui-design-issues.md) lists changes that should
not be treated as independent pre-existing bug fixes.