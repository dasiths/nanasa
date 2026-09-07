# Portable portal and runtime bug fixes

## Purpose and provenance

These fixes can be considered independently of the entity-first UI/UX proposal.
This functional-fixes branch, `docs/portal-functional-fixes`, starts from
`origin/main` at `add9ccfd48889fb8b05876dffd2b447a2da15514`, fetched on 2026-09-07.
It began as documentation-only at `f10edf5`. The operator subsequently authorized
implementing the fixes here, independently of the UI/UX redesign. The original
portal navigation, screens, styling, and component structure are retained.

The source research came from `feat/portal-entity-design` at `0b194f7` and its
comparison follow-up at `55ba14f`. The UI/UX remains unaccepted. The branch-local
status and verification below describe independently applied functional changes,
not a merge of those feature commits. The operator authorized committing, pushing,
and opening a PR for these fixes; the UI/UX redesign remains excluded.

## Current implementation status

| Issue | Branch-local result | Verification |
| --- | --- | --- |
| BUG-001 | Preserve immutable run audit anchors during team deletion | Persistence, store, and original real-daemon CRUD tests |
| BUG-002 | Mark confirmed dead/missing exhausted running/starting runs failed | Coordinator regression for both new and already-failed recovery states |
| BUG-003 | Keep Stop available for active runs despite failed recovery | Eight legacy menu cases; isolated real Stop and fresh Start with teammate unchanged |
| BUG-004 | Resolve configuration by stable member ID, then legacy profile key | Distinct-ID directory projection and existing directory interactions |
| BUG-005 | Reject stale provider inspections and catalog refreshes | Out-of-order success, rejection, loading failure, and refresh tests; exact plan/provider assertion |
| OPEN-002 | Move operation errors inside the active workspace dialog | Create/attach/switch unit tests and real API invalid-branch browser test |
| OPEN-001 | Native session absence investigated; cause remains unknown | Read-only filename and reporter/adapter contract checks |

No original-portal layout changes, entity inspectors, new routes, or stylesheet
changes were imported. Runtime validation uses temporary safe-echo fixtures. The
operator's live agents and credential files were not modified.

## Source commit reference

Two daemon-only commits can be selected without taking the UI redesign:

| Issue | Commit | Contents |
| --- | --- | --- |
| BUG-001 | `c01f0e7` | Group-deletion audit retention and persistence regression |
| BUG-002 | `064941d` | Exhausted dead-run status and coordinator regressions |

These commits are provenance references; their functional changes were reapplied
with `apply_patch`, not cherry-picked or merged. Other fixes were implemented in
this branch's existing components, with local regressions.

Do not cherry-pick the entire redesign or copy whole mixed files. The source
locations below identify the behavior to reapply on the chosen fresh-branch base.
Test selectors may need adaptation to that base's existing portal. Links to
redesign-only files point to the source commit instead of nonexistent local files.

## BUG-001 Group deletion breaks immutable provider references

Status: fixed and regression-tested on this branch. Pre-existing failure also
reproduced on an unmodified `add9ccf` build.

Deleting a team with managed provider runs stopped its processes but failed with
`FOREIGN KEY constraint failed`. Deletion attempted to remove run records still
referenced by deliberately immutable provider bindings and dependent audit data.

Minimal fix in [store.ts](../apps/daemon/src/store.ts), `deleteGroup`: exclude
run records referenced by `run_provider_bindings`, or either `run_id` or
`replacement_run_id` in `provider_update_transitions`, from physical run deletion.
Keep the existing group cleanup transaction, stop ordering, and idempotency.
Do not disable foreign keys, remove immutability triggers, or erase provider audits.

Regression added to
[provider-snapshot-persistence.test.ts](../apps/daemon/test/provider-snapshot-persistence.test.ts),
available in `c01f0e7`: delete an active membership's group after its runs stop;
retain both a bound run and transition-linked replacement; verify idempotency,
immutable audit rows, and `PRAGMA foreign_key_check`. Existing store/coordinator
deletion tests and the original real-daemon CRUD test pass on this branch.

Dependencies: current provider-platform tables must exist on the target base.
No portal redesign dependency. `deletedRuns` counts physical deletions, not
retained historical anchors. Existing profile-based snapshot history can still
show historical runs when an agent is active in another group.

## BUG-002 Exhausted dead runs remain recorded as running

Status: fixed and all 19 coordinator tests pass on this branch;
also observed in the operator's real backend Pi run. No live operator run was
changed during investigation.

A dead pane with exhausted recovery remained `status: running` and
`recoveryPhase: failed`. The portal counted it as live, and a new start collided
with `run_already_active`.

Minimal fix in
[run-runtime-coordinator.ts](../apps/daemon/src/run-runtime-coordinator.ts),
`#recoverMissingRun`: when the retry limit is reached for a confirmed absent/dead
run, transition running/starting status to failed before returning. Preserve
desired state and retry budget. Do not apply this status change to a still-present
process being considered for forced fresh fallback (`forceFresh`).

Regression added to
[run-runtime-coordinator.test.ts](../apps/daemon/test/run-runtime-coordinator.test.ts),
available in `064941d`: cover both reconciling and already-failed recovery phases,
assert failed status, no new generation, preserved stop capability, and no
automatic relaunch.

Dependencies: none on the redesigned UI. Reconciliation applies after the updated
daemon is started. This fix does not explain or restore a missing Pi session.

## BUG-003 Active failed-recovery runs lose their Stop control

Status: fixed in the legacy tree on this branch. Active process status now takes
precedence over failed recovery when choosing Stop or Retry.

Failed recovery was tested before active process status, offering Retry start and
disabling Stop even when the daemon still considered the run active.

Behavior to port: running, starting, and stopping records must offer Stop before
any failed-recovery retry decision. Stop remains available for in-progress
recovery. Only stopped/failed inactive records should offer Start or Retry.

Historical source implementation: `entityRunAction` in the
[feature-branch entity management component](https://github.com/dasiths/nanasa/blob/0b194f7/apps/portal/src/components/entity-management.tsx).
Current implementation surface: `runAction` in
[group-tree.tsx](../apps/portal/src/components/group-tree.tsx).
Do not bring `EntityManagementContext`, inspectors, or Teams navigation into a
bug-only branch solely to carry this predicate.

Source regression behavior in the
[entity management tests](https://github.com/dasiths/nanasa/blob/0b194f7/apps/portal/src/components/entity-management.test.tsx)
and [entity workspace acceptance test](https://github.com/dasiths/nanasa/blob/0b194f7/test/acceptance/portal-entity-workspaces.spec.ts):
an active failed-recovery run must allow confirmed Stop; subsequent Start creates
a fresh generation with zero recovery attempts and no resume-session ID; the
teammate's run and pane remain unchanged. Adapt locators to the old controls.

Branch-local regressions use the existing GroupTree in
[App.test.tsx](../apps/portal/src/App.test.tsx) and the original agent menu in
[functional-fixes.spec.ts](../test/acceptance/functional-fixes.spec.ts). The browser
test injects the stale recovery fields into an otherwise real snapshot, then
executes real daemon Stop/Start operations. The separate coordinator test covers
the actual dead-run transition. Neither test invokes provider-setup recovery as a
substitute for a fresh start.

## BUG-004 Directory resolves configuration using the membership record ID

Status: fixed; distinct-ID and all 14 directory tests pass on this branch.
Pre-existing directory projection issue exposed by the migration.

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
now host this fixture, including the legacy profile-key fallback. Stable member
identity is preferred over the fallback. The old directory's presentation is
unchanged.

## BUG-005 Provider inspection responses can arrive out of order

Status: fixed in the existing provider panel on this branch. All five provider
tests pass, including out-of-order responses and exact plan/provider matching.

Selecting provider B before provider A's inspection resolves can display A's plan
with B's selected identity. A refresh can race with selection in the same way.

Minimal behavior to port to
[extensions-workspace.tsx](../apps/portal/src/components/extensions-workspace.tsx):
version asynchronous load/selection requests, clear old inspection on selection,
and accept results/errors only for the latest request. Disable switching while a
lifecycle operation is pending. Preserve exact-plan and revision validation.

Request generations invalidate older successes and failures, including refresh
and effect cleanup. Stale actionable details are cleared while inspecting;
operations are guarded against overlapping submission and selection. A plan is
rendered only when its extension ID matches the selected provider. No new tabs,
catalog layout, or removal presentation was introduced.

## Optional feedback and error-handling changes

These need a product decision, not automatic inclusion in a bug-only branch:

Neither optional item below was applied in this pass. Existing healthy-preview
behavior and its tests remain unchanged.

* Explicit healthy setup previews provide visible results on the feature branch.
  The former behavior intentionally stayed quiet and had a test asserting that.
  The change is in `shouldShowRecoveryResults` in
  [App.tsx](../apps/portal/src/App.tsx); automatic startup reconciliation stays
  quiet. Port only with approval of the feedback behavior, adapting its test.
* Provider-state lifecycle, checkpoint deletion, and service restart-preview
  promise failures are surfaced via `ErrorNotice` in the feature-branch version
  of [portal-route-panels.tsx](../apps/portal/src/routes/portal-route-panels.tsx).
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

Read-only follow-up on 2026-09-07 found no file matching the failed backend session
ID in its current private Pi home, while the previously recorded frontend session
file is present. Pi references are reported as session IDs and the adapter passes
`--session` with that reference. This does not establish when or why the backend
file became unavailable. No session invalidation, file deletion, authentication
change, or retry-budget increase was applied. Keep this issue open.

## OPEN-002 Workspace validation feedback appears behind the dialog

Status: fixed on this branch; added from the old/new comparison follow-up.

Reproduction before the fix: open Team workspaces, Add workspace, enter
`invalid branch name`, and submit Create workspace. The API returns
`invalid_worktree_branch`, but the error appears outside the open dialog and is
dimmed by its backdrop. Both the old portal and the unaccepted redesign showed
the issue in the pinned comparison captures.

Fix in [checkout-workspace.tsx](../apps/portal/src/components/checkout-workspace.tsx):
track the operation's error target and render create/attach/switch failures
inside the corresponding dialog. Keep fetch/refresh/removal errors on the page.
Preserve drafts and diagnostic codes, clear unrelated errors when switching forms,
and prevent mode changes or switch-dialog dismissal while an operation is pending.
No workspace policy, activation rule, or dialog styling was changed.

Verification: all eight
[workspace dialog tests](../apps/portal/src/components/checkout-worktree-dialog.test.tsx)
pass. The real-daemon test in
[functional-fixes.spec.ts](../test/acceptance/functional-fixes.spec.ts) verifies the
actual API error inside the dialog, retained input, and bounding-box containment.

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
registry environment without printing its contents. The following checks cover
the branch-local functional changes without depending on the redesign.

```bash
pnpm --filter @nanasa/daemon exec vitest run test/provider-snapshot-persistence.test.ts
pnpm --filter @nanasa/daemon exec vitest run test/run-runtime-coordinator.test.ts -t 'exhausted|delet|remov'
pnpm --filter @nanasa/portal exec vitest run src/components/agent-directory-model.test.ts
pnpm --filter @nanasa/portal exec vitest run src/components/extensions-workspace.test.tsx
pnpm --filter @nanasa/portal exec vitest run src/components/checkout-worktree-dialog.test.tsx
pnpm package:build
pnpm exec playwright test test/acceptance/functional-fixes.spec.ts test/acceptance/crud-workflows.spec.ts --workers=1
```

## Independent harness correction

Status: documented source-branch improvement, not applied in this pass. The new
functional acceptance test waits for actual terminal readiness independently.

The Start All messaging acceptance test assumed three terminal regions meant all
three run records already had pane bindings. That can race with launch. In
[start-and-messaging.spec.ts](../test/acceptance/start-and-messaging.spec.ts), wait
for each selected member's authoritative running run and nonempty pane ID before
capturing the run-to-pane map. The focused messaging test passed on the source
branch after this change. This synchronization improvement can be ported without
UI selector rewrites.

## Verification on this branch

* 245 portal unit tests pass across 26 files.
* 44 tests pass across the store, runtime coordinator, and provider-persistence suites.
* The original real-daemon CRUD acceptance test passes, including group deletion.
* Both new functional acceptance tests pass: old-menu fresh restart and visible
   workspace validation errors.
* Production package build, touched-file ESLint/format checks, all workspace
   typechecks, and documentation validation pass.

The full daemon suite, complete browser acceptance suite, and external-provider
certification were not run. The missing native session is not declared repaired.
The fixes are submitted from `docs/portal-functional-fixes` independently of the
unaccepted UI/UX proposal. The missing native-session cause remains a follow-up.

The separate
[feature-branch UI/UX ledger](https://github.com/dasiths/nanasa/blob/0b194f7/docs/portal-ui-design-issues.md)
lists changes that should not be treated as independent pre-existing bug fixes.
That design ledger is intentionally not included on this functional-fixes branch.