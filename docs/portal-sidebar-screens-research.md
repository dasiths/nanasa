---
title: Portal Screen Research
description: Research findings and consolidation recommendations for the portal group, operations, and system screens
ms.date: 2026-09-03
ms.topic: concept
---

## Decision summary

The assessed destinations do not represent equally substantial user workflows.
They currently divide into four coherent product areas:

1. Operator work that needs a response
2. Cross-group agent discovery
3. Git checkout management
4. Provider and daemon administration

The portal should preserve all of the underlying capabilities, but it should not
keep all seven as peer navigation destinations. The recommended information
architecture has four workspaces:

* Operations, with Attention as the default view and Agents as a second view
* Checkouts
* Providers, combining Extensions with provider-state lifecycle
* System health, combining daemon diagnostics, configuration, service state,
  remote identity, and retention data

Attention and Checkouts already match distinct operator jobs and should remain
easy to reach. Extensions is also a real management workflow, although
"Providers" describes it more accurately. All agents needs more capability to
justify a standalone route. Diagnostics, Service, and Remote access are too
fragmented and sparse to justify separate navigation entries.

The group Overview screen should be removed in its current form. It presents no
unique group workflow, repeats details already available in agent controls, and
labels repository-wide retention settings as group information. If a fourth
group tab is needed later, it should be an actionable Team settings screen, not
a passive runtime dump.

## Research scope and method

The assessment covers the current group Overview plus the sidebar destinations
shown under Repository operations and System:

1. Group Overview
2. Attention
3. All agents
4. Checkouts
5. Extensions
6. Diagnostics
7. Service
8. Remote access

Evidence came from four sources:

* Route definitions and React components in the current working tree
* Portal client contracts and daemon HTTP route implementations
* Focused Vitest coverage for the route, checkout, extension, and navigation
  components
* Manual browser verification at 1440 by 1000 and 390 by 844 against the
  portal running at `127.0.0.1:3210`

The focused source validation passed 18 tests across five files. All seven live
routes rendered without horizontal overflow at the mobile viewport. Mutating
checkout, extension, and diagnostics actions were not executed against the
working repository.

The live instance is older than the current working tree. Current source loads
and serves `/api/v1/attention-dismissals`, but the running daemon returns 404 for
that route and the running portal does not request it during startup. Live
behavior is therefore recorded separately from current-source behavior.

The Group Overview reassessment also uses the rendered screen supplied on
September 3, 2026 and the current working-tree implementation. The source and
the supplied screen agree on its structure and content.

## 1. Group Overview

### What it does

Overview is the fourth group-level tab after Terminals, Messages, and Attention.
Its internal route section is still named `settings`, although it renders a
read-only `GroupSettingsPanel` in
[portal-route-panels.tsx](../apps/portal/src/routes/portal-route-panels.tsx#L157).
It contains three cards:

* Models and provider state lists every active member's resolved or configured
  model, provider-state scope, and requested-model source
* Recovery lists every run ever retained for the group, with recovery phase,
  outcome or reason, and attempt count
* Retention shows message and terminal-checkpoint limits from repository
  configuration

The screen has no controls, drill-down links, filters, or remediation actions.
Actual editable group settings, name and instruction files, already live in the
group action menu's `GroupSettingsDialog` in
[group-tree.tsx](../apps/portal/src/components/group-tree.tsx#L528).

### Functional assessment

The screen renders the data it requests, but it does not turn that data into a
reliable group summary.

The Models card mostly displays "provider default" in the supplied screen. It
does not name the provider, role, checkout, or reason an operator should care
about the model source. Agent details already expose integration, role,
checkout, status, activity, and recovery state in
[group-tree.tsx](../apps/portal/src/components/group-tree.tsx#L1474).

The Recovery card is the largest defect. It maps every historical run for the
group without sorting, grouping, or limiting the results. Repeated internal IDs
such as `musing-kilby` occupy the page, while aliases such as "Engineer 2" are
not used. Normal restart records look like unresolved incidents, and the list
will continue growing with run history. The group tree and team recovery result
banner already expose current recovery state and actionable retry behavior.

The Retention card is misplaced. `messages.retentionPerGroup` and
`terminal.checkpoints` are repository-wide configuration values. They are not
overrides owned by the selected group. Showing them here suggests a group-level
policy that users cannot change on this screen.

There is no focused component test for `GroupSettingsPanel`. Existing tests
only assert that Overview appears in navigation. This matches the screen's low
behavioral content but leaves its historical-run projection unguarded.

### Consumer value

The screen does not answer a distinct operator question:

* "What is running?" is answered by the group header and Terminals
* "What needs me?" is answered by Attention
* "What happened?" is answered by Messages, Attention history, and agent details
* "How is this team configured?" is partially answered by the group and agent
  settings dialogs, not Overview

At present, Overview is an implementation-state inspection page presented as a
product workflow. Its information density is deceptive: the large cards contain
many values, but few support a decision or action.

### Recommendation

Remove Overview from group navigation now. Redirect existing
`/groups/:groupId/settings` URLs to the group Terminals route so bookmarks do not
fail. Keep group configuration accessible through a clearly labeled settings
button or menu in the group header.

Redistribute the small amount of useful content:

* Keep current agent status, model, provider, checkout, and recovery detail in
  the existing agent details surface
* Show active recovery only, as a group header indicator or recovery result
  banner; do not show raw historical runs in routine navigation
* Move repository retention policy to System health or repository settings

If a dedicated fourth tab becomes necessary, replace Overview with **Team
settings**. It should edit group name and instructions, show the agent roster
with role, provider, model, and checkout, and link to relevant provider or
checkout management. Recovery history and retention constants should not be in
that screen.

## Shared navigation and page structure

The destination registry in
[portal-destinations.ts](../apps/portal/src/router/portal-destinations.ts#L41)
groups Attention, All agents, and Checkouts as repository operations. It places
Extensions, Diagnostics, Service, and Remote access in a collapsible System
section. Every destination is a first-class URL parsed by
[portal-router.tsx](../apps/portal/src/router/portal-router.tsx#L13).

The grouping is understandable, but the visual hierarchy overstates the weight
of the system pages. Extensions is a full management surface. Service and Remote
access each render one small status card. Diagnostics is a collection of data
that belongs to several different ownership domains.

All routes use the same shell and `RouteSurface` pattern in
[portal-route-panels.tsx](../apps/portal/src/routes/portal-route-panels.tsx#L1037).
This produces a shell-level heading followed by a second, identical route
heading. For example, "Remote access" appears as both the page heading and the
article heading before the actual status. The repeated title, eyebrow, and
description consume meaningful space on mobile and make sparse desktop pages
look unfinished.

The persistent desktop rail also shows the complete group and agent tree on
every system page. That context is useful in Attention, All agents, and
Checkouts. It is mostly unrelated while inspecting service or remote metadata.
The mobile shell avoids this problem by moving navigation into an application
menu.

The shared accessibility foundation is sound:

* Routes use headings, regions, lists, description lists, and named controls
* Navigation exposes the current destination and Attention count
* Async results use status regions in the tested interactions
* The mobile layouts did not produce horizontal overflow in the live pass

The shared UX should be simplified by letting the shell own the route title and
by making the left rail contextual. System administration should not compete
with the group tree for horizontal space.

## 2. Attention

### What it does

Attention is the operator inbox. It projects several backend concepts into one
review queue:

* Open waits and launch consent requests that require an answer
* Input and approval requests inferred from agent status
* Failed, stuck, and ownership-uncertain agents
* Completed work awaiting acknowledgment
* Failed message deliveries
* Durable action progress and provider update notices

The current implementation derives these items in
[attention-items.ts](../apps/portal/src/attention-items.ts#L267) and renders both
global and group-scoped views through the same `AttentionPanel` in
[portal-route-panels.tsx](../apps/portal/src/routes/portal-route-panels.tsx#L247).
That reuse is good. Global Attention and group Attention are not duplicate
implementations; they are two scopes over the same queue.

The redesigned screen uses one continuous inbox with Needs action, Active,
History, and All views. It supports search, event-type and team filters, row
selection, durable individual or bulk dismissal, and contextual navigation to
the responsible terminal, messages, or consent surface. Exact waits and actions
are loaded per group by
[use-attention-workspaces.ts](../apps/portal/src/hooks/use-attention-workspaces.ts#L14).

Repository defaults, agent configuration, and durable operator overrides now
decide which event types enter Attention. The effective subscription policy is
resolved by
[attention-subscription-policy.ts](../apps/daemon/src/attention-subscription-policy.ts#L18)
and applied before badges and notifications in
[App.tsx](../apps/portal/src/App.tsx#L338).

### Functional assessment

Current source has meaningful component coverage for inbox views, search,
filters, destination routing, selection, durable dismissal, partial-load
errors, and action diagnostics in
[portal-route-panels.test.tsx](../apps/portal/src/routes/portal-route-panels.test.tsx#L277).

The redesign deliberately removed inline reply, approval, completion
acknowledgment, recovery, and action cancellation controls. Each row now has
exactly two actions: open the destination or dismiss the item. This makes the
list consistent, but "Needs action" is now a triage label rather than an
actionable queue. The portal client still exposes wait reply, action
cancellation, and completion acknowledgment methods, but the current portal has
no remaining call sites for those methods. Unless the terminal destination can
perform the same domain action, those workflows have become unreachable from
the portal.

Per-agent subscriptions are controlled from an eight-option bell dialog in each
terminal pane. A subscription controls inbox admission and notification
delivery together. Disabling agent health therefore removes current failures or
stuck states from Attention and its badge; it does not merely silence a toast.
The control needs stronger language than "Configure Attention" to communicate
that consequence. Eight per-agent toggles, Subscribe all, Unsubscribe all, and
Reset to config defaults are too much policy for a compact terminal toolbar.

The live instance has a visible inconsistency. Its navigation badge and document
title report one item, and the group tree shows a stuck Project Manager, while
the Attention filters report zero and the review list is empty. Waiting for
workspace loading did not change the result and no partial-load error appeared.

The earlier live mismatch is consistent with version skew rather than evidence
that the current source still has the defect. Current source includes durable
Attention dismissals in
[App.tsx](../apps/portal/src/App.tsx#L302) and daemon routes in
[route-registry.ts](../apps/daemon/src/http/route-registry.ts#L944). The served
portal and daemon predate those changes.

### Portal fit

Attention belongs in the portal and should remain the most prominent global
destination. It is the only screen organized around operator urgency rather
than system structure. The global badge, notification behavior, and direct
links into the responsible group make it the natural starting point for
supervising multiple agents.

The unified list is a material improvement over separate review, update, and
progress sections. Search and team filtering become valuable at repository
scale. On a group route, however, the disabled Team selector adds no value and
should not render. Search, four views, a type selector, and a team selector are
too much permanent chrome for small inboxes; secondary filters should collapse
until item volume warrants them.

### Recommendation

Keep Attention as the default Operations view and preserve group-scoped
Attention. Restore resolution at the destination before considering the inbox
complete. Prefer one primary row action such as Review, with Dismiss in an
overflow menu, rather than giving a destructive hide action equal visual weight.

Simplify subscriptions to three operator-facing levels per agent: Important
only, All activity, and Custom. Keep response requests, health failures,
completion, delivery failure, and failed provider updates in Important by
default. Put the eight-event Custom editor in agent settings, not the terminal
toolbar. The bell can show the current level and link to that editor.

Before judging the remaining live UX, rebuild and restart the portal and daemon
from the same source revision. Add one acceptance test that asserts the badge,
filter total, and rendered review rows agree for the same snapshot.

## 3. All agents

### What it does

All agents maps active memberships across every group to projected status and
the latest run. Each row shows the alias, status label, effective model when
available, and an Open agent action. The action routes directly to the selected
run's terminal. The implementation is a small read-only projection in
[portal-route-panels.tsx](../apps/portal/src/routes/portal-route-panels.tsx#L572).

### Functional assessment

The live route rendered four agents and each Open agent button was available.
Current source has a focused test for exact group and run routing and projected
labels in
[portal-route-panels.test.tsx](../apps/portal/src/routes/portal-route-panels.test.tsx#L657).

The screen is functional, but its information value is low. In the live data,
all four rows displayed "provider model pending." Rows do not display group,
role, last activity, checkout, attention reason, or a useful status detail. The
screen has no search, filter, sort, or multi-agent operation.

### Portal fit

A global directory becomes valuable when a repository has many groups and the
left rail can no longer show all agents at once. In the current UX, however, it
mostly repeats the always-visible group tree with less context. The tree already
shows alias, role, status, details, terminal access, and an action menu.

The description promises "provider models and projected status across groups,"
but the rows omit group names and often cannot resolve a model. Duplicate agent
aliases across groups would be ambiguous.

### Recommendation

Do not keep the current thin list as a peer sidebar destination. Preserve the
route as an Agents view within Operations and make it a real cross-group tool:

* Show group, role, provider, effective model, checkout, and last activity
* Support search and filters for group, role, provider, and status
* Sort attention-worthy agents first by default
* Reuse the same status labels and actions as the group tree
* Link an attention-worthy row to its review item when one exists

This gives Attention and Agents complementary purposes: work queue versus
inventory. It also avoids turning Attention into an overloaded dashboard.

## 4. Checkouts

### What it does

Checkouts owns repository worktree operations. The screen can create a managed
worktree from a branch and base revision, open an existing absolute worktree
path, list known checkouts, remove managed worktrees, and assign stopped agents
to a checkout. Its component is
[checkout-workspace.tsx](../apps/portal/src/components/checkout-workspace.tsx#L7).

The daemon validates repository identity and worktree state, serializes Git
mutations, and uses operation generations to protect removal. Dirty removal
requires a second explicit force action in the UI. The source component tests
cover managed creation and the dirty-removal confirmation in
[checkout-worktree-dialog.test.tsx](../apps/portal/src/components/checkout-worktree-dialog.test.tsx#L83).

### Functional assessment

The live screen correctly showed the primary checkout as dirty and disabled
assignment changes for running agents. Forms and assignment controls rendered
without layout overflow. No repository mutation was performed during this
research.

The implementation has three notable gaps:

* It uses `snapshot.repositories[0]`, so its ownership is implicitly a
  single-repository portal even though the contracts expose repository IDs
* The route description promises inspection and provenance checking, but the
  UI does not show a worktree provenance token or operation history
* Tests do not cover opening an existing checkout or changing an assignment

The heading "Stopped-agent assignments" then lists every active membership,
including running agents with disabled controls. This is accurate but makes the
primary task harder to scan.

### Portal fit

Checkouts belongs in the portal. Checkout assignment is a cross-agent workflow
with real safety constraints, and it does not fit naturally inside one group's
terminal or settings page. It is also substantial enough to justify a dedicated
workspace.

### Recommendation

Keep Checkouts separate. Improve the existing workspace instead of merging it:

* Separate assignable stopped agents from running agents
* Expose managed versus discovered ownership and provenance in plain language
* Add confirmation context for branch, path, dirty state, and affected agents
* Add focused tests for opening and assignment
* Replace the first-repository assumption if multi-repository snapshots are a
  supported product direction

## 5. Extensions

### What it does

Extensions is a provider package manager. It lists built-in and available
provider packages, inspects exact package identity, reports health and drift,
previews permissions and owned mutations, shows generated commands, and exposes
trust, install, repair, disable, rollback, and conservative removal actions.
The UI is implemented in
[extensions-workspace.tsx](../apps/portal/src/components/extensions-workspace.tsx#L7).

The daemon separates planning, health inspection, trust, and lifecycle
mutations in
[route-registry.ts](../apps/daemon/src/http/route-registry.ts#L438). Mutations
use exact plan digests and lock revisions, reject stale plans, and block unsafe
changes while provider runs are active. Removal preserves provider state,
authentication, sessions, and changed files.

### Functional assessment

This is the most complete System screen. The live instance listed four provider
packages, displayed current and unavailable health, and rendered the selected
package's permissions, ownership, command preview, and lifecycle controls. The
focused component test covers the main preview and lifecycle actions in
[extensions-workspace.test.tsx](../apps/portal/src/components/extensions-workspace.test.tsx#L112).

The responsive layout avoids horizontal overflow, but the mobile page is very
long. Users must move through catalog, package facts, diagnostics, permissions,
mutations, commands, lifecycle actions, and removal in one vertical stream.

The catalog automatically selects its first item even when that provider is
unavailable. Several buttons remain visually enabled when an active run will
make the daemon reject the operation. Backend rejection is safe, but the UI can
set expectations earlier.

### Portal fit

The capability belongs in the portal. Provider setup, trust, health, and repair
directly affect whether agents can start and whether Nanasa can safely manage
their configuration. Calling these data-only provider packages "Extensions"
can imply executable UI plugins, despite the explanatory copy saying the
opposite.

Provider-state lifecycle currently appears in Diagnostics even though users
will understand it in relation to a provider. That split forces them to move
between two screens to diagnose and manage one provider.

### Recommendation

Rename this workspace to Providers and move provider-state lifecycle into the
selected provider detail. Retain the trust and ownership evidence, which is the
screen's strongest feature.

Use local tabs or progressive disclosure for Overview, Permissions and changes,
State, and Lifecycle. Select an installed or unhealthy provider before an
unavailable unconfigured provider. Reflect active-run blockers directly in the
action area with a link to the affected agents.

## 6. Diagnostics

### What it does

Diagnostics aggregates four independent sources in
[portal-route-panels.tsx](../apps/portal/src/routes/portal-route-panels.tsx#L614):

* Daemon metadata and event sequence
* Configuration status and parser diagnostics
* Provider-state bindings and retention lifecycle
* Terminal checkpoints and deletion

Provider-state Retain changes the binding lifecycle to retained. Delete marker
marks the binding deleted; it does not directly delete provider files. The
repository behavior is defined in
[provider-state-repository.ts](../apps/daemon/src/provider-state-repository.ts#L105).

### Functional assessment

The live route loaded all four datasets. It showed a ready daemon and
configuration, four active provider-state bindings, and no retained terminal
checkpoints. The Retain and Delete marker actions were enabled. They were not
executed because they mutate repository state.

This screen has the highest UX risk of the seven:

* "Delete marker" does not explain whether data is deleted, queued for cleanup,
  or only marked in the database
* Destructive provider-state actions have no confirmation
* Lifecycle mutations have no local busy state or rendered error handling
* A failure in any one of the four initial requests rejects the combined
  `Promise.all`, so unrelated sections do not get independent error states
* The entire dataset reloads on every snapshot sequence change
* There is no dedicated Diagnostics component test

The page mixes health inspection with retention policy and destructive
maintenance. This weakens both discoverability and safety.

### Portal fit

The underlying data belongs in the portal, but the current aggregate screen
does not. Each dataset has a more natural owner:

* Daemon and configuration status belong in System health
* Provider-state lifecycle belongs in Providers
* Terminal checkpoints belong with terminal recovery or System data retention

### Recommendation

Remove Diagnostics as a standalone destination after relocating its sections.
Until that consolidation lands, rename Delete marker to an outcome-focused
label such as "Mark for cleanup," explain retained files, add confirmation and
error handling, and allow each section to load independently.

## 7. Service

### What it does

Service reads the project-local systemd user service descriptor and displays
unit name, service state, process policy, continuity behavior, and the last
activation. Its only action requests a browser reconnect plan from
`/api/v1/service/restart-plan`.

The HTTP action does not restart the daemon. The route definition in
[route-registry.ts](../apps/daemon/src/http/route-registry.ts#L301) returns a
typed frame describing retry delay, resnapshot requirements, and PTY handoff.
Actual install, start, stop, and restart operations exist in the daemon's
systemd service implementation in
[systemd-user-service.ts](../apps/daemon/src/service/systemd-user-service.ts#L159),
but the portal does not expose them.

### Functional assessment

The live environment reported `not-installed`. Clicking Preview planned restart
still returned "Reconnect in 1000 ms, resnapshot required, PTY handoff
disabled." The interaction works as implemented, and source tests verify the
status and continuity copy.

The result is semantically weak. A planned reconnect frame is available even
when there is no installed service and no restart will occur. "Preview planned
restart" sounds like the first step of an executable restart workflow, but the
screen cannot perform the second step.

### Portal fit

Service state is useful operational context. A dedicated screen is not
justified while it contains one status card and a protocol preview. The daemon
continuity contract matters most when diagnosing connectivity or preparing an
upgrade.

### Recommendation

Move service state into System health. Rename the preview to "View restart
continuity" if it remains non-mutating, and disable it when the service is not
installed. If browser-triggered restart is intentionally out of scope, make the
boundary explicit rather than presenting an incomplete command flow.

## 8. Remote access

### What it does

Remote access reads a loopback connection descriptor. The descriptor contains
repository and instance identity, build and protocol versions, service state,
loopback host, and port. It is built by
[remote-descriptor.ts](../apps/daemon/src/remote/remote-descriptor.ts#L9).

The portal does not create, inspect, reconnect, or close SSH tunnels. Those
operations are CLI-owned. The screen presents security constraints and tells
the operator to restore the tunnel and reload when disconnected.

### Functional assessment

The live route rendered correctly and had no controls. It showed `not-installed`
because the heading uses `remote.service.state`. That is the local systemd
service state, not a measurement of tunnel installation or tunnel health.

The statement "No browser-managed tunnel is active" is static policy copy. The
backend cannot determine whether the browser reached the portal through an SSH
tunnel. As a result, this screen is not a remote connection status screen even
though its position and heading suggest that role.

### Portal fit

Remote identity and loopback policy belong in the product, but not as a
standalone screen with no workflow. The information is useful for support,
compatibility checks, and security verification. It is less useful during
ordinary agent operation.

### Recommendation

Remove Remote access from primary navigation. Move repository identity, build,
protocol compatibility, loopback endpoint, and service state into System
health. Move SSH setup and reconnect guidance into Help or CLI documentation.
Do not label service state as remote access state.

## Proposed streamlined experience

### Operations

Make `/operations` the global supervision workspace with two local views:

* Attention, the default, retaining the global badge and current review actions
* Agents, an enhanced searchable and filterable cross-group directory

Keep group-scoped Attention where it is. Preserve `/attention` and `/agents` as
redirects or aliases so bookmarks, notifications, and command palette actions
remain stable.

### Group workspace

Use three default tabs: Terminals, Messages, and Attention. Remove the passive
Overview tab. Keep a group settings command in the header for name and
instruction changes. Add a Team settings route only when configuration grows
enough to require a full page.

### Checkouts

Keep `/checkouts` as a dedicated repository workspace. It is a cohesive,
high-consequence workflow and has little meaningful overlap with the other
screens.

### Providers

Rename `/extensions` to `/providers` and combine:

* Provider catalog and health
* Permission, command, and ownership previews
* Trust and lifecycle operations
* Provider-state retention and cleanup status

Preserve `/extensions` as an alias during migration.

### System health

Replace Diagnostics, Service, and Remote access with `/system`. Use sections or
local tabs for:

* Overview, including daemon lifecycle, event connection, version, and epoch
* Configuration, including path, revision, and diagnostics
* Continuity, including systemd state and restart behavior
* Connection, including repository identity, loopback endpoint, and protocol
  compatibility
* Data retention, including terminal checkpoints and explicit cleanup actions

Preserve `/diagnostics`, `/service`, and `/remote` as aliases to the relevant
System health section until external links and operator habits have migrated.

## Recommended delivery order

1. Remove Group Overview, preserve its URL as a redirect, and keep the existing
  settings dialog discoverable from the group header.
2. Verify every Attention destination can complete the required response,
  approval, acknowledgment, recovery, or cancellation workflow.
3. Rebuild the live portal and daemon from one revision, then add the Attention
  badge-to-list acceptance assertion.
4. Add confirmation, busy state, outcome-focused labels, and error rendering to
   provider-state and checkpoint mutations.
5. Create System health from the existing Diagnostics, Service, and Remote
   components without changing daemon contracts.
6. Rename Extensions to Providers and move provider-state lifecycle into it.
7. Turn All agents into the Operations Agents view and add group-aware search,
   filters, and richer status context.
8. Remove duplicate route headings and make the desktop group rail contextual
   on administration screens.
9. Preserve old URLs as aliases and update command palette destinations only
   after the replacement routes are stable.

This sequence addresses correctness and destructive-action clarity first, then
reduces navigation without requiring a risky backend redesign.
