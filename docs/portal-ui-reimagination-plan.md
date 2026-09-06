---
title: Portal UI reimagination research and plan
description: Agents-led design direction, screen coverage, isolated proof of concept, and approval-gated rollout
ms.date: 2026-09-06
---

## Status and boundary

Production implementation was authorized on 2026-09-06. Work is on branch
`feat/portal-entity-design`, created from `add9ccf`. The mock has been moved out
of the repository to `/tmp/nanasa-portal-mock.Pzupj0`; its development servers
have been stopped.

The [implementation log](portal-ui-implementation.md) records completed slices,
validation, and remaining work. The approved entity-first direction guides the
migration; the prototype's shortcuts and simulated domain behavior must not be
copied into the production runtime.

### Design reset after user review

The user rejected the component-reuse mock as visually inconsistent. Its
production controls and layout imposed the old UI on the new visual treatment.
That approach is superseded; do not continue layering CSS over it.

The current design brief is the [entity-first experience](portal-ui-entity-design.md)
and its [capability register](portal-ui-entity-actions.json). Identify the object,
the operator's intent, its conditions, and its outcome before choosing a control.
Extend the Agents directory language through a newly composed UI.

### Capability parity requirement

Preserve every current user-facing capability and safeguard, including the small
ones, but not the old widgets, duplicated entry points, or button locations.
Reusing `App`, its menus, forms, dialogs, shell, and stylesheet is not the means
of achieving parity in the next POC.

The register accounts for 19 domain entities, 61 capability groups, and all 73
client methods. Nine methods have no current UI caller and are recorded as
API-only, not promoted into invented existing features. Client method coverage
alone is not user-facing feature parity. For example, current waits lead to the
terminal, not a new structured reply form; dismissal is not acknowledgement.

New controls may use shared domain contracts, fixture state, and the existing
terminal engine. Each current capability needs a discoverable new entry point,
working local behavior, preserved conditions, and evidence of its outcome.
The mock must not contact the daemon or execute real commands, Git operations,
provider changes, or permission grants.

All mocks are preserved in the temporary archive as comparison artifacts.
Existing production behavior and safeguards remain until their replacement
workflows have been implemented and tested.

## Research findings

### Visual reference

The implemented [Agents directory](../apps/portal/src/components/agent-directory.tsx)
and its [stylesheet](../apps/portal/src/components/agent-directory.css) establish
the reference, rather than an unrelated dashboard template:

* Compact heading with a configuration source and small contextual totals
* Search and grouping on one horizontal toolbar
* Full-width team bands, scan-friendly rows, and muted secondary metadata
* Role glyphs that distinguish identities without decorative illustrations
* Green selection with a narrow edge indicator
* A contextual inspector with configuration and prompt-layer views
* Direct navigation from an agent to its team or live terminal
* Semantic color for readiness, attention, failure, and informational states

The [shared stylesheet](../apps/portal/src/styles.css) already supplies IBM Plex
Sans Condensed, light and dark theme tokens, green actions, blue information,
amber warnings, and red failures. Preserve that vocabulary. Reduce competing
surface treatments and use separators, spacing, and type hierarchy to organize
work, not additional containers.

### Current screen inventory

The [destination registry](../apps/portal/src/router/portal-destinations.ts)
defines ten global destinations and three team destinations. The
[route panels](../apps/portal/src/routes/portal-route-panels.tsx) contain global
attention, diagnostics, preferences, help, service, remote, and about surfaces.
Dedicated components own directory, workspaces, providers, messages, and terminals.

| Existing destination | Proposed treatment | Workflow to retain |
| --- | --- | --- |
| Attention | Categorized inbox with compact rows and an action inspector | Distinguish actionable waits, permissions, health, completion, delivery, and unread messages |
| All agents | Reference directory, consistently integrated into the shell | Search, grouping, role identity, source composition, team and terminal navigation |
| Team workspaces | Branch-oriented rows with binding details | Inspect primary versus linked checkout, assign teams, create and remove managed worktrees safely |
| Providers | Readiness directory with a setup inspector | Inspect integrations, versions, authentication, install and update prerequisites |
| Diagnostics | Health summary followed by structured records | Configuration state, provider-state lifecycle, terminal checkpoints |
| Service | Lifecycle summary and chronological events | Inspect service status and deliberate reconnect or restart behavior |
| Remote access | Connection facts, command block, and security state | Loopback-only binding, SSH tunnel guidance, service relationship |
| Preferences | Labeled settings rows grouped by purpose | Browser-only appearance, accessibility, and notification preferences |
| Help | Searchable local topic index and readable article pane | Offline guidance and command discovery |
| About Nanasa | Restrained product identity and release facts | Installed version, build identity, compatibility |
| Team terminals | Compact team header, member strip, terminal work surface | Terminal selection, layout, lease ownership, input safety, reconnect and transcripts |
| Team messages | Conversation list, message timeline, attached composer | Read cursors, recipients, delivery state, drafts, and contextual navigation |
| Team attention | Shared attention view scoped to the selected team | Preserve team context and existing attention actions |

### Local design hypothesis

A shared page frame, toolbar, grouped list, status vocabulary, and optional
inspector can extend the Agents treatment without forcing every task into a
directory. Terminals remain terminal surfaces; messages remain conversations;
settings remain labeled forms. The frame provides consistency and each task
retains its useful information density.

The hypothesis fails if important actions become harder to locate, navigation
loses team context, inspectors crowd the main work, or phone layouts need page-wide
horizontal scrolling. The cheapest discriminating check is an isolated clickable
prototype covering every destination, inspected at desktop and phone widths.

## Proposed experience

### Shared shell

Keep global operations above a compact team tree, with system and utility
destinations below. The revised shell uses team shortcuts rather than embedding
agent management in the sidebar. A Teams directory and System subviews are
proposed in the entity-first brief. Preserve existing deep links and keyboard
destinations during any production rollout. Show the current project and
connection state without making the header a second navigation system. Use one
clear page heading and a contextual primary action where one actually exists.

Keep team navigation stable across Terminals, Messages, and Attention. Selecting
an attention item can lead to its agent, workspace, or terminal without losing
the original context. Browser back and forward must work in the prototype.

### Visual system

* Retain IBM Plex Sans Condensed and readable monospace for machine values
* Use white and soft neutral surfaces, graphite text, and restrained green actions
* Keep blue, amber, and red for meaningful distinctions, with accompanying labels
* Use full-width bands and unframed sections; reserve bordered frames for tools
* Keep controls and repeated item corners at 6px or less
* Use Lucide icons, accessible names, and tooltips on icon-only actions
* Keep compact secondary text readable and long IDs or paths wrappable
* Provide equally deliberate light and dark themes
* Restrict movement to short view transitions and honor reduced motion

### Interaction patterns

Search and filter controls stay near the content they affect. Selection opens a
contextual inspector rather than a new page when users are comparing records.
On narrow screens, the inspector replaces the collection with a named Back
action and focus return, rather than appearing below a long list. Critical decisions use explicit labels,
confirmation, and pending/result feedback, not icon-only actions.

Dialogs must support initial focus, Escape, focus containment, and focus return.
Empty search results offer a reset. Permission and lifecycle actions remain
distinct from informational records. Connection loss must never be represented
as a successful action. Do not invent backend capabilities to support a visual.

## Prototype scope

Build a separate multi-screen React mock with existing dependencies and local
fonts, using the portal's existing Vite server only as a development host.
No new project scaffold or production routing changes are needed.

The replacement prototype starts with newly composed directory, inspector, edit,
create, decision-review, and work-surface patterns. First prove agent editing,
attention-to-terminal navigation, workspace switching, and scoped message
composition. Then extend those same patterns to every current capability and
destination type. Do not present the old component-reuse mock as this replacement.

Simulate representative filters, selection, detail views, theme changes,
preference controls, confirmation dialogs, and local action feedback. Terminal
output is a fixture, not a live PTY. Provider setup, remote health, service state,
versions, permission decisions, and message delivery are illustrative fixtures,
not statements about the user's running environment.

Identify the isolated experience as a design preview in the shell. Keep ordinary
screens free from explanatory design copy. Describe limitations in this plan and
the review handoff instead of filling the interface with prototype instructions.

## Delivery sequence

### Phase 1 Entity-first reset and replacement POC

1. Establish the entity relationships, capability register, and six interaction
   patterns. Distinguish actual UI actions from API-only methods and read-only facts.
2. Build the new presentation without production UI imports or stylesheet overrides.
3. Validate four representative workflows and their safeguards before expanding.
4. Map every current capability to its new entry point, state, result, and evidence.
5. Capture the replacement screens and interaction states. Review visual coherence
   against Agents, action discoverability, responsive behavior, and accessibility.
6. Present the new POC with limitations. The earlier screenshot counts do not
   validate a new design that has not yet been implemented.

### Phase 2 Design approval

Approved to begin production implementation. Continue reviewing each slice for
visual fidelity to Agents, control discoverability, operational status, and
terminal/message ergonomics. Do not infer production parity from the prototype's
API method or screenshot counts.

### Phase 3 Incremental implementation after approval

1. Extract shared page, toolbar, status, and inspector primitives only where the
   approved screens demonstrate actual reuse. Preserve existing public APIs.
2. Apply the shell and shared tokens; verify routing, preferences, keyboard
   navigation, loading, offline, and error boundaries.
3. Migrate Attention, Agents, Team workspaces, and Providers with their existing
   state owners and action safeguards intact.
4. Migrate team terminals, messages, and attention, preserving terminal lifecycle
   and communication semantics rather than rebuilding domain behavior.
5. Migrate diagnostics, service, remote, preferences, help, and about.
6. Finish dialog, command palette, empty, loading, denied, reconnect, stale,
   failure, and long-content states across the shared experience.

Each slice should be independently reviewable and tested before continuing.
Do not combine visual rollout with daemon, schema, provider, or security changes.

## Verification criteria

### Prototype checks

* Every current capability has a mapped new entry point, conditions, and outcome
* No production App, shell, menu, form, dialog, or stylesheet imports in the new UI
* API-only methods do not become extra buttons merely to match a method count
* Every registered global and team destination has a reachable mock surface
* Navigation, browser history, search, selection, and inspector close work
* At least one connected attention-to-terminal and agent-to-team journey works
* Message composition, preferences, and confirmation feedback work locally
* Desktop and mobile screenshots contain readable, non-overlapping content
* No page-wide horizontal overflow at 390px and 1440px widths
* Light and dark themes retain readable status labels and focus indicators
* Keyboard navigation and accessible form names are checked with automated tools
* Reviewers compare repeated-pattern crops at native scale and verify actual icon anchoring, typography hierarchy, spacing, identity consistency, and single-owner dividers
* Full-page screenshots are reviewed alongside crops; obscured captures and unreviewed patterns cannot receive visual sign-off
* No browser runtime errors or unintended daemon requests
* Production source, existing mock, package manifests, and lockfile are unchanged

### Production gates after approval

Use existing portal unit tests and targeted acceptance tests for each migrated
slice. Include routing and history, keyboard focus, roles and accessible names,
attention permissions, workspace safety, terminal lease and reconnect behavior,
message delivery and read cursors, persistent preferences, and offline help.
Run repository-required formatting, lint, type checks, and applicable acceptance
coverage before declaring the production rollout complete.

## Review handoff

The POC is archived under `/tmp/nanasa-portal-mock.Pzupj0`. Its former preview
ports are no longer running. Production work is now tracked in the
[implementation log](portal-ui-implementation.md).

The [current POC review](portal-ui-entity-poc-review.md) records status placement,
capability entry points, independent visual review, verification, and explicit
simulation gaps. The [design brief](portal-ui-entity-design.md) and
[capability register](portal-ui-entity-actions.json) remain the behavioral baseline.

The component-reuse mock and its [visual review](portal-ui-visual-review.md)
remain historical comparison artifacts, not the implementation direction.