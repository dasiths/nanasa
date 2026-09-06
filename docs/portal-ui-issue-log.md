---
title: Portal migration issue log
description: Bugs and design gaps discovered during the entity-first portal migration, their fixes, and verification
ms.date: 2026-09-06
---

## Scope

Use the two separate ledgers for current decisions and fresh-branch extraction:

* [Portable functional bugs](portal-functional-bugs.md): stable issue IDs,
  minimal implementation surfaces, regression checks, dependencies, and open issues
* [UI/UX decisions and migration issues](portal-ui-design-issues.md): design-only
  work and repairs that should not be imported with independent bug fixes

The tables below retain the historical discovery record. They do not imply that
every repair should be ported to the old UI. In particular, direct Resources and
System navigation has been superseded by the requested More menu.

Issues found while implementing the approved entity-first portal on
`feat/portal-entity-design`. Pre-existing defects are distinguished from migration
regressions. No credentials, production data, or user sessions were used for
verification.

## Fixed issues

| Issue | Origin | Fix | Verification |
| --- | --- | --- | --- |
| Team deletion failed with a foreign-key constraint after stopping runs | Pre-existing, reproduced at `add9ccf` | Retain stopped run records referenced by immutable provider bindings or update transitions; delete the live group graph without destroying audit evidence | Real-daemon CRUD acceptance passes; provider persistence test checks retained evidence, idempotency, hidden live projection, and `foreign_key_check` |
| Editing a name sent unchanged restart-sensitive configuration fields | Migration | Submit only changed team or agent fields | Running-team and agent renames pass real CRUD; exact payload unit tests |
| Membership record ID was mistaken for configured agent ID | Existing directory projection, exposed by migration | Resolve through stable member identity or agent profile key | Distinct-ID management regression and directory tests |
| Recovering runs could appear startable or movable | Migration | Preserve recovery-aware Start, Stop, and Retry decisions; validate current move destinations | Recovery-phase tests and App management tests |
| Unsaved configuration could be lost through inspector navigation or Escape | Migration | Confirm discard for outside actions and Escape; block dismissal and duplicate submissions while saving | Dirty navigation, keep-editing, Escape, and payload tests |
| Member-ID copying and detailed runtime diagnostics disappeared with the tree | Migration parity gap | Restore copy control and projected runtime details in the agent inspector | Copy-ID and directory tests |
| Team deletion lost selected-team fallback and focus handling | Migration parity gap | Reuse App-owned team lifecycle callbacks | App deletion confirmation and fallback-focus test |
| Browser request links did not open their matching inspector | Migration | Resolve all supported Attention fragments, not only waits and actions | Real browser request acceptance, including popup isolation and no referrer |
| Provider inspect responses could race and display an older plan | Existing asynchronous selection risk | Version requests and discard stale responses; clear old inspection while loading | Typecheck and provider lifecycle tests; code review |
| Explicit recovery preview gave no visible feedback when nothing needed restart | Pre-existing interaction gap | Show explicit dry-run results; leave automatic startup reconciliation quiet | App recovery tests and portrait/landscape recovery acceptance |
| New terminal strip overlapped terminal panes | Migration layout regression | Give session navigation and terminal content separate bounded grid rows | Real terminal sweep and focus checks |
| Mobile terminal ownership and tools were clipped | Migration layout regression | Allocate explicit rows for identity/ownership and tools; suppress decorative grid occupants | Screenshot review and header/ownership/tool bounding-box assertions |
| Provider tab content leaked through `hidden` | Migration CSS conflict | Scope an explicit hidden-content rule inside entity layouts | Provider tab screenshots and lifecycle tests |
| Dark system and preference actions rendered as unreadable white rectangles | Existing bare controls exposed by theme migration | Apply themed action surfaces and text | Light/dark visual review |
| Team Members repeated repository headings and hid useful rows below the fold | Migration composition gap | Remove repository-level summary and repeated team group headers in scoped members | Mobile screenshot review |
| Agent rows prioritized repeated configuration defaults over runtime state | Design gap against approved POC | Use identity, runtime, effective model, and role columns; keep detailed configuration in inspector | Directory tests and visual review |
| Inspector icon axis, empty inherited headings, and adjacent divider ownership were inconsistent | Migration composition gaps | Align identity headings, suppress empty inherited sections, and use one boundary rule | Native-scale visual review |
| Message execution checkbox separated from its label | Migration CSS conflict | Restore adjacent checkbox/label layout | Desktop/mobile conversation captures |
| Workspace inspector contained a global assignment editor | Migration composition gap | Show current checkout owners and an explicit assign-another-team control | Workspace switch tests and screenshots |
| Provider approval and removal lacked clear action hierarchy | Design gap against approved POC | Primary exact-plan approval; lifecycle view; expandable conservative removal | Provider approval/repair/rollback/removal tests |
| Team shortcuts were separated from operations and resources were hidden | Migration composition gap | Place shortcuts before System in DOM order and expose Resources directly | Navigation tests and final visual review |

## Evidence corrections

These were validation issues, not product fixes:

* Replaced obsolete tree-menu and modal-composer selectors with the new actual
  workflows without removing payload, consent, focus, or delivery assertions.
* Changed screenshots to select the real persisted theme instead of changing only
  an HTML attribute, which left xterm using a different theme.
* Awaited font loading and lazy route availability before screenshots and axe scans.
* Checked visible terminal output without assuming a canvas renderer or requiring
  the initial ready line to remain on screen after subsequent messages.
* Added geometry assertions because DOM visibility alone missed clipped terminal
  ownership text and toolbar controls.
* Updated terminal acceptance to allow its intentional DOM fallback when WebGL
  is unavailable while still verifying renderer output and interactions.

## Subsequent live-provider observations

The operator's real Pi runs exposed the following after the acceptance review.
These observations are not covered by the safe-echo fixture's successful starts.
No live agent was restarted or modified during diagnosis.

* Backend Team / Engineer 1 attempted native-session resume and exited with code
  1. The retained pane error was `No session found matching
  '01a072fb-c60b-7bb4-8929-e4c1c281e138'`. Its persisted recovery count was 3 and
  reason was `recovery_attempts_exhausted`. The recorded session could not be
  resolved by Pi in that launch context; deletion of the session files has not
  been established.
* Frontend Pi also attempted resume, but had budget for
  `native_resume_fallback_restart` and reached a recovered run at attempt 2.
* The failed backend pane was dead while its persisted run status remained
  `running` with recovery phase `failed`. The header therefore counted it as live
  even though terminal access was unavailable. The subsequent status fix and
  Stop-control fix are implemented and tested as BUG-002 and BUG-003 in the
  functional ledger. Native-session lookup itself remains OPEN-001. No live
  operator run was changed.

## Verification limits

The final validation scope and remaining review notes are maintained in
[portal-ui-implementation.md](portal-ui-implementation.md). Screenshot coverage
does not by itself prove every provider-specific runtime state; real provider
authentication and external-provider certification remain separate from this UI
migration.