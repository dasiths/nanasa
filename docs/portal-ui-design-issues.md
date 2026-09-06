---
title: Portal UI and UX changes and migration issues
description: Design decisions and migration-specific repairs kept separate from portable functional bug fixes
ms.date: 2026-09-06
---

## Acceptance boundary

The UI/UX proposal is not accepted. Commit and push are authorized only to
preserve work in progress for further review. Implemented on
`feat/portal-entity-design`, it is separate from the
[portable functional bug fixes](portal-functional-bugs.md). Rejecting the design
does not imply rejecting those fixes. The two daemon fixes have standalone
commits recorded in that ledger; no separate bug-only branch has been created.

## Current requested navigation

Operations contains exactly this order:

1. Workspaces
2. Teams
3. Attention

Teams has Teams and All agents subviews. `/agents` remains a compatible route and
shortcut target; it is not a separate top-level destination. Providers,
Preferences, Diagnostics, Service, Remote access, Help, and About are under More
on desktop/mobile. Earlier direct System/Resources navigation is superseded.

The team-shortcuts sidebar has no add button. Team creation remains available
from the Teams screen; this removes only the duplicate sidebar entry point.

Terminal session tabs use configured role glyphs and colors, matching agent
identity elsewhere, with neutral fallback icons when no role is configured.

## Redesign-specific repairs

These are required if accepting the new UI. They are not evidence that the old
portal needed the new abstractions.

| ID | Issue or decision | Current resolution |
| --- | --- | --- |
| UX-001 | New editor submitted unchanged restart-sensitive fields during rename | Send changed fields only; preserve running-agent rename behavior. Legacy dedicated rename already sent only the name. |
| UX-002 | New inspector navigation could discard dirty configuration | Confirm discard for outside actions and Escape; preserve drafts on failure and prevent duplicate save. |
| UX-003 | Removing the tree lost copy-ID and runtime diagnostics | Restore these capabilities in the agent inspector. |
| UX-004 | Direct team deletion bypassed existing fallback/focus handling | Reuse App-owned team deletion callback. |
| UX-005 | Attention deep links did not open the new inspector | Resolve supported fragments to selected events; preserve exact action destinations. |
| UX-006 | New terminal strip overlapped panes | Allocate separate bounded grid rows. |
| UX-007 | Mobile terminal header clipped ownership and controls | Explicit identity/status and tool rows with geometry assertions. |
| UX-008 | Provider hidden tab contents were displayed by conflicting CSS | Scoped hidden-content rule. |
| UX-009 | Dark settings/system actions became unreadable | Themed button surfaces and text. Adaptable to old CSS, but the observed failure was in the migrated theme. |
| UX-010 | Scoped Members repeated repository-level headings | Remove duplicate context while retaining member controls. |
| UX-011 | Agent rows prioritized repeated defaults rather than runtime | Identity, runtime, effective model, and role columns; details remain in inspector. |
| UX-012 | Icon axes, empty inherited sections, and adjacent dividers varied | Align headings, suppress empty sections, and give boundaries one owner. |
| UX-013 | Attached composer's execution checkbox separated from its label | Restore adjacent checkbox/label alignment. |
| UX-014 | Selected workspace inspector exposed all teams' assignments | Show current owners and an explicit assign-another-team action. |
| UX-015 | Provider actions lacked clear approval/removal hierarchy | Primary exact-plan approval, separate lifecycle view, expandable removal review. |
| UX-016 | Navigation remained too broad after migration | Workspaces, Teams, Attention in Operations; secondary destinations under More. |
| UX-017 | Terminal tabs used a generic monitor icon | Use the existing configured role glyph and color. |

Recovery action eligibility is tracked as BUG-003 in the functional ledger: its
predicate can be ported to legacy controls without the new inspector.

## Test and evidence changes

* Old menu/modal selectors were adapted for entity inspectors and attached
  composition. These test rewrites should not be copied wholesale to a bug-only
  branch.
* Screenshots use actual persisted theme selection, loaded fonts, settled latest
  message delivery, and visible terminal output, rather than only HTML styling.
* xterm can use DOM fallback without WebGL; its renderer-specific visibility and
  input checks remain. This harness correction can be extracted independently.
* Geometry checks catch controls that exist in the DOM but are clipped.
* The latest checks pass 251 portal unit tests and the navigation/glyph/fresh-start
  browser scenarios. All 20 acceptance scenarios passed across the suite run
  (19 passing) and the messaging rerun after the readiness correction documented
  separately in the functional ledger.
* Initial visual reviews rejected several composition defects; follow-up reviews
  checked fixes. Those reviews predate later user menu/icon revisions unless
  explicitly stated in the [implementation report](portal-ui-implementation.md).

Current production captures are in
[the gallery](../test-results/portal-production/index.html). Screenshots and passing
tests are review evidence, not approval of the proposed UX or exhaustive external
provider certification.