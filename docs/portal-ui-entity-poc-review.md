---
title: Entity-first portal POC review
description: Replacement prototype, operational status placement, capability entry points, screenshot review, and simulation boundaries
ms.date: 2026-09-06
---

## Archived preview

The user authorized production implementation on 2026-09-06 and requested the
mock be moved to a temporary directory. The complete reference copy is under
`/tmp/nanasa-portal-mock.Pzupj0/mock`; the entity and parity sources also remain
at the archive root. Preview servers on ports 5181, 5182, and 5183 are stopped.
The generated screenshots remain under `test-results/portal-entity`.

The POC used newly composed presentation components in its entity mock, not the production App,
shell, forms, menus, dialogs, or stylesheet. Shared domain contracts, the local
fixture client, and xterm's terminal engine remain reusable infrastructure.
The previous mocks on ports 5181 and 5182 are comparison artifacts only.

Production implementation now proceeds on `feat/portal-entity-design`; see the
[implementation log](portal-ui-implementation.md). The findings below describe
the prototype, not certification of the production implementation.

## Operational status decision

Reducing duplicate controls must not remove operational visibility. Status is
part of the domain model, not decorative chrome.

| Signal | Placement | Meaning |
| --- | --- | --- |
| Project connection | Under project identity in the desktop rail; under the mobile wordmark | Whether workspace updates are currently available |
| Snapshot freshness | Secondary project metadata and connection details | When this browser last received a confirmed snapshot |
| Interrupted updates | Warning near the workspace content, only when degraded | Displayed entities are last-known data; mutations and terminal input must wait |
| Team state | Team shortcuts and compact runtime summary in the team workspace | Working, starting, response/approval, completion, and failure counts |
| Agent state | Directory row, inspector, and session strip | Observed runtime state rather than an inference from process existence |
| Terminal attachment | Selected terminal header | Whether the local terminal engine is attached, distinct from agent health |
| Input ownership | Live terminal lease line | Whether this browser can type or paste into the selected live session |

The center of the header remains search. Healthy connection state is not a
standalone badge inserted between unrelated controls. The project status opens
one connection/freshness detail view with diagnostics and refresh/reconnect.

Connecting, reconnecting, stale, and disconnected are separate states. Preview
scenario controls exercise interrupted updates without deleting the retained
snapshot. Connected means the local fixture transport is available; it does not
claim a live daemon connection or that every agent is healthy.

Agent status distinguishes not started, stopped, stopping, starting, updating,
approval, response, stalled progress, stale status, unknown status, idle,
working, completion, and recovery failure. Older run generations do not provide
current status. Team alerts are not hidden just because inbox subscriptions are
disabled.

## Capability entry points

The [entity/action register](portal-ui-entity-actions.json) remains the feature
baseline. The following is a navigation map, not a claim of exhaustive behavior
parity.

| Capability family | New entry point |
| --- | --- |
| Project health and diagnostics | Project identity status, System Health, connection details |
| Navigation and command discovery | Sidebar destinations, team shortcuts, command search, browser history |
| Team creation and editing | Teams directory, Create team, team inspector Edit |
| Team organization and removal | Organize teams; membership section and impact confirmation |
| Agent search and inspection | All agents or team Members; grouped rows and shared inspector |
| Agent creation and edits | Add agent sheet; Configuration edit mode with retained draft |
| Agent reordering and move | Explicit Organize mode and destination selector; stopped-state guard |
| Agent removal | Inspector Session membership section and impact confirmation |
| Run lifecycle and recovery | Agent Session; team-scoped actions and outcome review |
| Input lease and terminal tools | Selected session, live lease line, active-target tool strip |
| Terminal layout and history | Focus/Grid and column controls; History reader with output-source selector |
| Console session | Project Console entry, same terminal work surface, explicit close session |
| Checkpoint reading and deletion | Terminal History and System Checkpoints |
| Messages and delivery | Team conversation, attached composer, recipient delivery details |
| Durable execution | Explicit Prompt when ready option; Attention activity |
| Attention selection and dismissal | Scoped inbox, search/type filters, selection action bar, inspector |
| Launch consent and URL requests | Source-aware decision inspector and exact-effect review |
| Event subscriptions | Agent inspector Attention view; terminal bell links to that same view |
| Workspaces and assignment | Branch directory, Assignment/Git facts/Maintenance inspector views |
| Provider lifecycle and trust | Provider Overview/Plan/State; exact-plan approval and typed removal |
| Provider state retention | Provider State view with separate retain/delete actions |
| Role presentation | Preferences Roles; supported glyph and color pickers |
| Appearance and accessibility | Preferences sections with segments, selectors, and toggles |
| Notifications | Browser preference and permission controls, preview toast, sound setting |
| Service and remote facts | System Service/Remote; planned restart preview, not restart execution |
| Help and build identity | Offline Help topics and About Nanasa |

Important preserved distinctions include creation versus activation, message
delivery versus execution, dismissal versus resolving a request, a provider
package versus retained state, and a process versus its browser input lease.
Provider install and repair require prior approval of the exact plan in the
local mock. Unchecked workspace activation leaves the existing team binding
unchanged.

## Independent visual review

The reviewer opened 49 screenshots: 45 screen/interaction captures and four
dedicated connection-state captures. Coverage included all nine top-level
destinations, terminals and conversations, both themes, and desktop/mobile
examples. It was not an independent execution of every capability.

The initial reviewer found no high-severity visual blocker. It confirmed that connection
status now belongs with project identity, leaving the center header for search,
but did not adequately assess the composition inside the project block. The
user's subsequent crop exposed that gap. Correct placement is not proof of
consistent hierarchy, alignment, or typography.

| Finding | Refinement |
| --- | --- |
| Historical output showed live-input tools nearby | History now hides live lease/input tools and exposes Copy output and Back to live; input is disabled while reading history |
| Mobile detail retained too much collection chrome | Mobile detail hides collection statistics and toolbar; keeps compact context, Back, and the entity heading |
| Delivery failure resembled a successful receipt | Failure uses a distinct alert glyph and error-colored receipt that expands recipient outcomes |
| Workspace review showed a count without affected identities | Review now includes the source branch, destination, and affected agent names |

Each refinement has a focused browser assertion. The latest screenshots are
regenerated after these changes; older screenshots are not evidence of the final
state.

## Composition review after user feedback

Two independent, read-only subagent reviews re-examined the supplied sidebar
issue and repeated patterns. One inspected four full-resolution images and the
owning markup/styles; the other inspected twelve screenshots across screen
families. Both identified the project block as an actual design inconsistency,
not a contrast or overflow problem.

| Inconsistency | Correction |
| --- | --- |
| Folder centered against the entire name/status stack | Separate identity and connection rows using the same 18px icon column and 9px gap; icon anchors to the project-title line |
| Noninteractive folder resembled a bordered button | Remove the enclosure; preserve the clickable connection control separately |
| Product and project both appeared as unexplained Nanasa labels | Label the repository context as Project: nanasa |
| Status inherited project-title styling through a broad selector | Explicitly scope project-name, workspace, status, and freshness classes; use 13/12/11/11px hierarchy |
| Metadata followed a staircase of different text axes | Align project, workspace, connection, and freshness to one axis, shared with navigation labels |
| Provider glyph and identity color changed between row and inspector | Share one neutral identity presentation; keep readiness color in the status indicator |
| Entity metadata used too many near-identical sizes | Use primary, secondary, and technical type tokens at 14/12/11px across repeated entity patterns |
| Tabs and their following section both drew the same boundary | Give the boundary one owner; suppress the first section's top border after tabs |

A follow-up subagent opened twelve native-scale comparisons and confirmed the
visible component-level corrections. It also found sticky-header obscuration in
three captures, so those images could not support a visual pass. The capture
tool now resets document scroll and crops page coordinates without locator
auto-scrolling. The obscured examples were regenerated and inspected directly.

## Visual review gate

Reviewer briefs must require these checks explicitly. Automated checks are
supporting evidence, not a substitute for design review.

1. Compare native-scale crops of repeated patterns side by side: project/status,
  row/inspector identity, role identity, editor fields, action groups, and tab
  boundaries. Explain any difference in icon, tone, baseline, or inset.
2. Identify what each icon belongs to. Verify its alignment to the intended
  text line, not the containing block. Noninteractive decorations must not
  borrow button borders without a reason.
3. Compare actual rendered font sizes and weights with semantic importance.
  Inspect computed styles where hierarchy looks wrong; an intended rule can
  be overridden by another selector.
4. Trace full-page rhythm from heading to toolbar, rows, sections, and footer.
  Check repeated control heights, inset spacing, divider ownership, and
  duplicated identity information.
5. Compare mobile collection, detail, edit, navigation, and dialog views at
  native scale. Long names and disconnected/stale states must preserve the
  grouping and alignment without reducing metadata to miniature text.
6. Reject obscured or transitional screenshots as review evidence. Record
  capture limitations and exact images inspected; do not infer whole-screen
  consistency from a sample or a passing accessibility report.

The archived `entity/capture-patterns.mjs` tool
generates 38 native-scale crops/context images and twelve geometric checks of
project alignment, type hierarchy, and state stability. Long-name examples are
explicit browser-only stress probes, not changes to fixture truth. Its metrics
catch known regressions; a reviewer must still judge composition from images.

## Verification

The archived `entity/check.mjs` browser check captures
129 states in a complete run: 37 workflow states, eight connection/detail
states, 80 screen/theme/viewport combinations, and four scenario states.
It checks accessible names and contrast, horizontal overflow, runtime errors,
daemon API traffic, and the absence of production presentation imports.

Core executed journeys include agent configuration editing and persistence,
subscription changes, wait-to-terminal navigation, lease review, terminal input
and history, guarded workspace switching, scoped message sending and draft
restoration, provider-plan approval, typed removal guards, create forms,
organization, mobile detail Back, and command search.

The archived `entity/status.test.ts` unit tests cover connection
freshness, distinct process/agent states, old-generation waits, approvals, and
team alerts independent of subscriptions. Separate focused browser checks verify
project status placement, retained disconnected data, configuration-reader
keyboard access, refreshed Git facts, and arrow-key command navigation.

No daemon calls or real process, filesystem, permission, or package operations
are performed by the preview. The isolated Vite server responds with HTTP 403 to
API requests.

## Simulation boundaries

This is a reviewed interactive design POC, not production feature-parity
certification. All current capability groups remain in the register; the local
fixture implementation does not emulate every runtime transition or safeguard
enforced by the daemon.

* Terminal output/input, leases, recovery, and backend operations are local simulations.
* OS clipboard and desktop notifications depend on real browser permissions.
* Automated-input suspension and agent-initiated clipboard-write consent are not yet modeled as separate interactive terminal scenarios.
* Provider/run recovery timing and partial failures are illustrative; concurrent revision and ownership races are not exhaustively tested.
* Dirty-worktree forced removal is not offered in this POC; only eligible clean worktrees can be removed.
* The fixture help articles are not the complete generated production command reference.
* Role picker changes update configuration, but glyph/color propagation to every mock identity needs a final integration pass.
* Message history pagination is implemented, but long-history behavior is not fully exercised by the small default fixture.
* Global browser guards, every disabled state, and every combination of entity state and viewport are not proven by screenshot counts.

These items are explicit follow-through requirements before claiming complete
parity or starting a production rollout. No current capability should be removed
from the product merely because the POC omits a simulation.

## Archive boundary

The temporary archive preserves source for comparison. Its original relative
imports and workspace dependency resolution need adjustment before running it
outside the repository; it is not advertised as a standalone runnable package.
Do not move the mock back into the production source to perform the migration.

## Approval gate

The entity-first design direction is approved for implementation. Completion of
the production migration and live-backend acceptance testing remain separate
from the prototype review. The old component-reuse mock should not be carried
into implementation.