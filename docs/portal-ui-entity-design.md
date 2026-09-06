---
title: Entity-first portal experience
description: Domain entities, capability inventory, interaction patterns, and revised design direction based on the Agents directory
ms.date: 2026-09-06
---

## Design decision

Preserve what an operator can accomplish, not where the current portal puts its
buttons. The prior component-reuse mock is a behavioral reference, not the design
direction. Its inherited menus, forms, dialog layouts, repeated headings, and
terminal chrome must not dictate the next POC.

Start with the Agents directory's visual and interaction language: grouped rows,
compact type, restrained semantic color, source-aware details, and a contextual
inspector. Extend that language through newly composed screens and controls.
Reuse contracts, validated domain behavior, and the terminal engine, not old
presentation components or a cascade of overrides to the production stylesheet.

The [capability register](portal-ui-entity-actions.json) inventories 19 domain
entities and 61 capability groups: 53 current-UI groups and eight API-only
groups containing nine methods. These are not 19 pages or 61 buttons. Every
group records the operator's intent, current UI exposure, backing methods,
proposed interaction, and safeguards that must survive redesign.

## Entity model

| Entity | What it represents | Operator capabilities | Proposed home |
| --- | --- | --- | --- |
| Project | Repository configuration and daemon context | Inspect configuration, connection, build and diagnostics; navigate and discover commands | Project context in shell and project inspector |
| Team | Membership, instruction scope, and workspace binding | Create, rename, edit instructions, reorder, delete; manage members and team execution | Teams directory and team workspace |
| Configured agent | A named membership using an integration and optional role | Search/group; add, edit, rename, reorder, move, remove; inspect prompts, policy and provenance | Agents directory and shared agent inspector |
| Run | A process generation with observed runtime state | Start/stop, team start/stop, preview/recover/retry, inspect failure and progress | Agent inspector Session view and team actions |
| Terminal view/lease | A browser's view and input ownership of a run | Observe/control; type/paste; find, select/copy; pin/focus; choose columns; view output history | Team terminal work surface |
| Ad-hoc console | A separately owned operator console | Open, use, close | Console workspace using the terminal tool language |
| Checkpoint | Historical output for a run generation | List, select/read, delete | Transcript History view; System maintenance |
| Conversation/message | Scoped communication with delivery/read state | Direct/multicast/broadcast; four intents; history, pagination, read state, clear history | Conversations and attached composer |
| Durable work item | Execution tracking, separate from message delivery | Prompt when ready; inspect actions, attempts and acknowledgements | Message execution details and Attention |
| Attention item | A projection referencing another entity's event/state | Filter/search; select; dismiss eligible items; navigate to responsible entity | Global or team-scoped inbox |
| Subscription | Per-member event preference over config defaults | Toggle nine event types, enable/disable all, reset to inherited settings | Agent inspector Attention view |
| Launch consent | A decision bound to an exact configured launcher | Inspect exact subject; trust and start; cancel; review team recovery requests | Attention decision inspector |
| URL request | A run's expiring request to open a URL | Inspect origin/full URL; open explicitly or dismiss | Attention decision inspector |
| Checkout/binding | Git checkout, team assignment, and optional managed-worktree ownership | Inspect, refresh, fetch, create, attach, assign/switch, remove when eligible | Workspaces directory and assignment inspector |
| Provider/integration | Extension capabilities and authored launch configuration | Inspect plan/health/integration use; trust, install, repair, disable, rollback, remove | Providers directory and plan-review view |
| Provider state | Retained runtime/auth-state binding, not the package | Inspect, retain, delete | Provider State view with System entry point |
| Role presentation | Shared visual identity, not role permissions | Choose supported glyph, color and compact name | Preferences Roles view and agent role link |
| Service/remote | Daemon lifecycle and loopback connectivity | Inspect health/service/SSH facts; preview restart behavior | System views |
| Browser preferences | Browser-owned presentation and notifications | Theme, density, motion, contrast, sound, OS notification permission/test | Preferences |

### Relationships that control the experience

```text
Project
  Team -> configured agents -> run generations -> terminal views / input leases
    |             |                   |
    |             +-> integration     +-> observed status and recovery
    |             +-> role            +-> checkpoints
    |             +-> instructions    +-> launch consent / URL requests
    +-> checkout binding
    +-> conversations -> messages -> per-recipient delivery outcomes
    +-> durable work items (separate from message delivery)

Attention = a filtered index into those entities, not another source of truth.
Subscriptions decide what enters the operator's inbox and notifications.
Browser preferences change presentation, not daemon configuration.
```

An agent configuration can exist without a run. A running process can continue
without an open browser terminal. A connected terminal can show an unhealthy
agent. A delivered message does not prove that requested work ran. The UI must
make these distinctions visible instead of reducing them to a single green dot.

## Information architecture

| Destination | Primary question | Content and subviews |
| --- | --- | --- |
| Attention | What needs my decision? | Needs action, Active, History, All; optional team scope; details beside the list |
| Agents | Who is configured and what are they doing? | Team/provider grouping; shared inspector; config, prompts, session, subscriptions |
| Teams | Who is working together? | Team directory; Members, Terminals, Messages, Attention within a team |
| Workspaces | Where will this team work? | Branch directory; assignment, Git facts, ownership, guarded maintenance |
| Providers | Can these agents launch and recover? | Extension readiness, integration facts, plan review, retained state |
| System | Is the environment healthy? | Health, configuration, service, remote; help and build information remain reachable |
| Preferences | How should this browser present work? | Appearance, Accessibility, Notifications, Roles |

Teams is a proposed first-class directory, not a new backend entity. Help and
About can remain direct utility destinations even when also linked from System.
Existing deep links and keyboard commands must continue resolving to the same
task during a future production rollout. Team attention is a scoped inbox, not
a second independently designed implementation.

The sidebar contains destinations and team shortcuts, not a miniature agent
management application. Agent editing moves to the shared inspector; the command
palette provides fast access to the same actions. No capabilities disappear when
the sidebar is collapsed or on mobile.

## Six interaction patterns

### 1 Directory and inspector

Use grouped, selectable rows for agents, teams, workspaces, providers, and inbox
items. One compact heading, one toolbar, one set of column labels. Search,
grouping, and filters belong beside the collection, not in the global header.

Selecting a row opens its inspector without replacing the collection. Inspector
tabs are entity-specific but share placement, spacing, focus behavior, and action
layout. Stable entity links preserve selection on navigation and browser Back.
On phones, the detail view replaces the list with a named Back action; do not
append details several screens below the selected item.

### 2 Inspect and edit in place

An inspector begins in read mode. A pencil action switches the editable section
into a coherent form using the same field layout. Save and Cancel occupy a stable
footer; dirty-state exit is explicit, and an error keeps the entered values.

Renaming is editing the name field, not a separate bespoke inline-rename widget.
Inherited values remain read-only with their source. Do not expose execution
policy, credential, or model editors just because the configuration schema
contains those values. The existing UI command determines what can be changed.

### 3 Create and organize

Create uses one sheet pattern with a named entity, a small set of required
fields, relevant defaults, and an explicit submit action. Creating a membership
does not automatically start it. Creating or attaching a workspace does not
silently activate it.

An Organize mode exposes row handles and keyboard move-up/down actions. Moving
an agent to another team shows the destination and stopped-run requirement.
Do not repeat reorder, rename, move, and remove controls on every normal row.

### 4 Run and operate

One contextual primary command reflects the selected entity's state: Start for
a stopped agent, Open terminal for a running agent, Review request for pending
consent, Review recovery when ownership is uncertain. Secondary lifecycle actions
sit in the inspector, not in every row and every header simultaneously.

Terminals and conversations remain task surfaces, not forced into directory
tables. Terminal identity, run state, connection state, and input ownership have
separate positions. Conversation audience and execution intent remain explicit.

### 5 Review impact and decide

Use a consistent review step for workspace transitions, provider plans, launch
consent, team deletion, and multi-run stop. Show the object, exact effect, scope,
preconditions, and available outcomes. Use precise labels such as Trust and
start, Stop and switch, or Remove extension, not generic Confirm or Continue.

Presentation can be shared; semantics cannot. Do not combine cancelling a launch
request with durably denying a launcher. Preserve typed extension-ID confirmation
and uncertain-process ownership safeguards where they exist today.

### 6 History, results, and preferences

History readers clearly distinguish live data from captured output. Batch actions
produce an outcome list, including partial failures and items requiring approval.
They do not disappear behind a generic success toast.

Preferences use labeled rows: segments for a small mode set, toggles for boolean
preferences, visual swatches/glyphs for roles, and an explicit permission request
for OS notifications. Readiness and unavailable states include a reason; a
disabled action must not be the only explanation.

## Reimagined workflows

| Task | New sequence | Controls retained through the new sequence |
| --- | --- | --- |
| Change an agent's role | Select agent, Configuration, Edit, choose role, Save | Integration, instructions, name, optional role, inherited read-only policy, errors and draft |
| Move an agent to a team | Select agent, Organize, choose destination, review eligibility, Move | Stopped-state guard, order revision, keyboard operation, target team |
| Respond to a waiting agent | Select inbox item, inspect source and request, Open terminal | Request type, run identity, freshness, actual terminal response path |
| Trust a custom launcher | Select consent, inspect exact command and permission floor, Trust and start | Subject/config revision, environment names, cancellation, pending and failed startup |
| Switch a team's workspace | Select workspace, Assignment, choose team, review run impacts, choose transition | Stopped-only/stop-switch/restart policies, revision checks, partial outcomes |
| Send scoped work | Choose conversation, audience control, enter message, optional Prompt when ready, Send | Direct/multicast/group, intent, recipient validation, byte limit, execution separate from delivery |
| Review provider changes | Select provider, inspect readiness, choose maintenance action, review exact plan | Trust, install/repair/rollback/disable, affected agents, package digests, typed removal safeguard |
| Change attention settings | Select agent, Attention, toggle event rows or reset to inherited | Nine event types, source of each value, enable/disable all, reset, pending/error feedback |
| Find old terminal output | Select terminal, History, choose checkpoint | Bounded live read, timestamp, generation, truncation, historical label, read-only output |

### Terminal composition

```text
Backend Team                    Start eligible   Team actions
Members | Terminals | Messages | Attention

Project Manager  Engineer 1*  Reviewer       [layout] [history]
Engineer 1   Pi   Needs response              Observe / Control
----------------------------------------------------------------
                    terminal work surface
----------------------------------------------------------------
Search / selection / clipboard tools for the active terminal
```

In a grid, each pane keeps agent identity, input ownership, and focus/pin actions.
The active pane owns the shared tool strip and is visibly marked. Copy, Paste,
Search, Select all, Clear selection, Transcript, subscriptions, and clipboard
consent remain reachable. Controls must never silently operate on a different
pane from the one the operator is reading.

### Agent inspector composition

```text
Engineer 1                                     [close]
Backend Team / Implementor

[Open terminal]                      [more lifecycle actions]
Configuration | Prompts | Session | Attention
------------------------------------------------------------
Workspace                                      main
Integration                                    Pi
Role                                           Implementor
Instructions                                   backend.md
Source                                         config.yaml
                                               [edit]
```

The same inspector is opened from All agents, a team's Members view, an inbox
source, or a terminal identity. No different agent-settings dialog on each path.

## Capability audit corrections

The previous 73-method check validated a fixture interface. It did not prove
feature parity or that every method had a portal button. A source audit found
these methods have no current production UI caller:

* `replyOpenWait`, `acknowledgeCompletion`, and `cancelAgentAction`
* `denyLaunchConsent` and `revokeLaunchConsent`
* `getLaunchConsent`, since the current UI uses complete requests from the list
* `createTerminalCheckpoint`
* `planProviderExtension` and `providerExtensionHealth` as separate operations

The current portal navigates an open wait to its live terminal; a neighboring
[test](../apps/portal/src/App.test.tsx) explicitly asserts that it does not call
`replyOpenWait`. Existing provider inspection already includes plan and health
facts. These API-only methods are recorded but must not create invented parity
buttons. Exposing them later is a separate product decision.

Also preserve the correct verbs: Clear selection, not Clear terminal history;
Dismiss an inbox item, not Resolve an agent request; Preview planned restart,
not Restart service; role presentation, not role permission editing.

## Evidence and acceptance

Primary evidence is the [portal client contract](../apps/portal/src/api.ts),
[team and agent operations](../apps/portal/src/components/group-tree.tsx),
[route panels](../apps/portal/src/routes/portal-route-panels.tsx),
[terminal controls](../apps/portal/src/terminal/terminal-console.tsx),
[message composer](../apps/portal/src/components/message-workspace.tsx),
[workspace transitions](../apps/portal/src/components/checkout-workspace.tsx), and
[provider actions](../apps/portal/src/components/extensions-workspace.tsx).

The register is an inventory, not proof of a finished design. Each current-UI
capability needs a new entry point, its conditions and failure states, a working
mock journey, and screenshot evidence. Repeated old buttons may collapse into
one shared action; distinct operations and safeguards may not be collapsed.

The archived `check-entity-model.mjs` uses the TypeScript parser to
account for all 73 interface methods exactly once and checks call-site evidence
outside tests and the API wrapper. Eleven of the 53 current-UI groups are
frontend-only and must be assessed through interaction coverage, not API calls.
This check detects inventory drift; it does not establish runtime reachability
or completeness of UI behavior by itself.

The falsifiable design hypothesis is that these six patterns can carry the
existing capabilities while making the active entity and action scope easier
to identify. Test it first on agent editing, wait-to-terminal navigation,
workspace switching, and message composition. If an action is hidden without a
discoverable route, loses its target, or drops a safeguard, revise the pattern
before expanding to every screen.

## POC sequence

1. Build the new shell, directory, inspector, editor, and decision-review primitives
   in isolation. Do not import the production App, shell, menus, forms, dialogs,
   or stylesheet. Keep the old parity mock only as a behavioral comparison.
2. Prove the four representative workflows above against the capability register,
   with local fixture state and explicit scope in every action.
3. Extend those same primitives to Teams, Providers, System, Preferences, and the
   remaining current capabilities. Reuse the terminal engine and domain contracts.
4. Capture every screen and named interaction family at desktop/mobile widths;
   include light/dark, loading, empty, denied, stale, partial-failure, and history.
5. Have the reviewer assess coherence against the Agents reference and action
   discoverability, not just contrast and control presence.
6. Present the new POC for review. No production changes before approval.

The replacement POC is archived under `/tmp/nanasa-portal-mock.Pzupj0`. Its
[review and coverage notes](portal-ui-entity-poc-review.md) record the newly
composed UI, independent visual findings, operational status placement, and
remaining simulation gaps. Production implementation is now authorized on
`feat/portal-entity-design` and tracked in the
[implementation log](portal-ui-implementation.md). The old mixed-style mock is
not the implementation direction.