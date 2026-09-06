---
title: Portal entity-first implementation
description: Completed production migration, discovered fixes, validation evidence, and operator review guide
ms.date: 2026-09-06
---

## Scope and branch

Production implementation is authorized on branch `feat/portal-entity-design`,
starting from `add9ccf`. The operator has requested a commit and push to preserve
the work, but has not accepted the UI/UX. This is a review snapshot, not approval
to merge or release the redesign.

The production entity-first migration remains pending operator review.
Existing runtime, authentication, consent, terminal transport, messages, workspace
operations, and configuration ownership are preserved. No mock client or mock
terminal behavior is imported into production.

The [issue log](portal-ui-issue-log.md) records discovered bugs and composition
gaps, their origins, fixes, and verification. All reported visual blockers were
addressed and recaptured before the final targeted reviewer check.

Functional fixes are separately recorded in
[portal-functional-bugs.md](portal-functional-bugs.md), with fresh-branch
application guidance. Design changes and migration-only repairs are in
[portal-ui-design-issues.md](portal-ui-design-issues.md). UI/UX acceptance remains
pending; no bug-only branch has been created.

## Mock archive

All portal mocks were moved to `/tmp/nanasa-portal-mock.Pzupj0`.

* `mock/` contains a verified complete copy of the original mock directory.
* `entity/` and `parity/` contain the moved later POC sources.
* `original-agents/` contains the moved original tracked Agents mock.
* The initial visual study and inventory-check script are at the archive root.
* The former preview servers on 5181, 5182, and 5183 have been stopped.

This is temporary local storage, not a committed or durable backup. Relative
workspace imports require adjustment before the archived mock can run elsewhere.
Generated review evidence remains in `test-results/portal-entity`.

## Slice 1 Shell and project status

Implemented:

* New product topbar with one command-search entry point and mobile navigation
* Separate project identity and connection/freshness component
* Shared icon/text axes and explicit typography for project and connection metadata
* Status opens the existing System status dialog without extra network fetches until requested
* Freshness uses local receipt time of accepted snapshots, not the snapshot's authored timestamp
* Stale responses and failed loads do not advance the last successful receipt time
* Operations ordered Workspaces, Teams, Attention; secondary destinations in More
* Compact global context header, leaving the screen's own title visually prominent
* Approved neutral/green light and dark palette in the existing production token definitions
* Shell layout with bounded viewport sizing and a shared mobile project strip

The sidebar tree is replaced by team shortcuts in the actual portal. Team
shortcuts follow operations in DOM order. Teams includes an All agents subview;
Providers, System, and Preferences are under More. The original tree remains for compatibility,
but does not control production sidebar management.

## Entity workspaces

| Surface | Implemented treatment | Preserved behavior |
| --- | --- | --- |
| All agents and Members | Operational directory with configuration, prompt, session, and Attention inspector views | Stable identity, direct/inherited configuration, runtime details, copy ID, create/edit, organize, move/remove, run controls, subscriptions |
| Teams | Directory, inspector, create/edit sheets, organize, deletion review | Instruction files, order revisions, fallback selection, confirmation and focus |
| Attention | Filterable/selectable inbox with source-aware inspector | Durable/bulk dismissal, exact routing, browser URL safety, partial errors, history and diagnostic distinctions |
| Workspaces | Branch directory with Assignment, Git facts, and Maintenance | Explicit activation, revisions, fetch/references, create/attach, stop-switch-restart, ownership and dirty-removal safeguards |
| Providers | Catalog with Overview, Plan, and Lifecycle | Exact-plan approval, revision checks, permissions/commands/mutations, install/repair/disable/rollback, typed removal |
| Terminals | Session strip, grid/focus navigation, bounded mobile header | Existing xterm mounts, leases, takeover/observe, pinning, search, clipboard consent, transcript, reconnect and input |
| Messages | Conversation with attached composer and search; quick composer retained | DM/multicast/broadcast, intent, errors, read cursors, pagination, outcomes, clear history, separate durable execution |
| Preferences and System | Unframed sections, segmented presentation controls, consistent themed actions | Cross-tab preferences, roles, notification permission, diagnostics/checkpoints/state, service/remote descriptors |
| Help and About | Consistent reference surfaces | Generated offline help and existing diagnostics access |

Explicit healthy setup previews now show a result, so an operator-initiated check
does not appear to do nothing. Automatic startup reconciliation stays quiet when
no attention is needed. Configuration edits send only changed fields, preserving
running-team and agent renames without unrelated restart-sensitive changes.

## Validation

Follow-up tests cover the requested navigation, configured terminal glyphs, and
exhausted-run fixes, including confirmed Stop then fresh Start without affecting
a teammate. All 19 coordinator tests and 251 portal unit tests pass. Lint and
workspace typechecks pass. UI/UX acceptance remains an independent user decision.

Focused unit coverage:

```bash
pnpm --filter @nanasa/portal exec vitest run src/App.test.tsx src/shell/project-context.test.tsx src/hooks/use-portal-snapshot.test.ts
```

The full portal unit suite passes 251 tests across 30 files. Coverage includes
accepted snapshot freshness, rejected stale snapshots, failed-refresh retention,
navigation, stable IDs, rename-only payloads, unsaved-edit guards, recovery phases,
exact Attention destinations, and retained operation safeguards.

Focused daemon coverage checks store/coordinator deletion and provider graph
persistence, including immutable run and replacement-run retention.

Real-daemon acceptance coverage:

```bash
pnpm package:build
pnpm exec playwright test test/acceptance --workers=1
```

The acceptance fixture creates temporary repositories and daemons, uses safe echo
agents, and cleans up afterward. The latest suite run passed 19 of 20 tests;
the remaining messaging test passed on a focused rerun after fixing its pane
readiness race. All 20 scenarios are now verified. Coverage includes management, workspace/provider
lifecycle, messages, restart continuity, terminal ownership and input, stable
mounts, responsive layouts, and serious/critical accessibility findings at 200%
text zoom. DOM rendering is a supported xterm fallback when WebGL is unavailable.

Final scoped ESLint, repository workspace typechecks, changed-file formatting,
documentation validation, and production package build also passed.

The production screenshot sweep uses persisted theme selection, loaded fonts,
settled latest-message delivery, visible terminal output, and explicit header/tool
bounding-box checks. Current captures and the generated
[review gallery](../test-results/portal-production/index.html) are under
`test-results/portal-production`; populated URL-request Attention captures are
retained there too. Additional screenshots/traces are in acceptance output.

Independent reviewers checked native-scale composition against the approved POC,
including hierarchy, icon/text axes, divider ownership, dark controls, runtime
scanning, mobile list replacement, and terminal tool visibility. Initial reviews
rejected several defects. Fixes were applied and recaptured, and the final
targeted visual recheck cleared the reported blockers and navigation gap.

### Resolved deletion failure

The pre-existing team-deletion foreign-key failure reproduced at baseline
`add9ccf`. Under the subsequent request to fix discovered issues, it is now
repaired: deletion retains stopped runs referenced by immutable provider bindings
or update transitions. The live group graph is removed without destroying audit
anchors. Physical deletion counts exclude retained run records.

Regression coverage checks membership deletion, idempotency, bound/replacement
run retention, immutable evidence, and SQLite foreign-key integrity. Real-daemon
CRUD now passes. Historical runs may still appear when their agent is active in
another group, consistent with existing profile-based history after reparenting.

Before any package-manager command, source `.devcontainer/.env` when present
and preserve its configured registries, as required by repository instructions.

## Development preview

No persistent frontend or daemon server was started for this review. Use the
existing Makefile workflow to build/start the portal, as requested. Acceptance
tests provide their own temporary daemon and do not modify an operator session.

## Operator review

1. Inspect All agents and Teams, including edit, cancel/discard, organization,
   run actions, subscriptions, and deletion review.
2. Move between Members, Terminals, Messages, and Attention and check session
   continuity and mobile Back navigation.
3. Review Workspace assignment/maintenance and Provider plan/lifecycle controls
   before applying changes to a real team.
4. Check Preferences, Diagnostics, Service, Remote access, Help, and About in both
   themes and at mobile widths.

The [capability register](portal-ui-entity-actions.json) and
[entity-first design](portal-ui-entity-design.md) remain the requirements. A
successful UI check is not external-provider certification. Real provider login,
every provider-specific failure state, every possible content length, the full
daemon suite, and external platform certifications are not claimed to be
exhaustively verified by this migration.