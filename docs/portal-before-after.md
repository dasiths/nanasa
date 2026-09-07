---
title: Old and new Nanasa portal comparison
description: Full HD screenshots of actual old and proposed portals using matching isolated three-team daemon fixtures
ms.date: 2026-09-07
---

## Review scope

The new UI/UX is not accepted. These captures provide evidence for comparison,
not approval to merge or release it. No application code was changed for the
comparison. The operator authorized committing and pushing this review material
to the feature branch; that authorization does not accept the UI/UX.

| Version | Ref | Pinned commit |
| --- | --- | --- |
| Old | Freshly fetched origin/main | `add9ccfd48889fb8b05876dffd2b447a2da15514` |
| New | feat/portal-entity-design | `0b194f76f4252a69bf52508ee6f658f6356d5099` |

Open the [side-by-side HTML gallery](assets/portal-comparison/index.html) for a wider view.
Every image below links to its original **1920 x 1080** PNG. Each screenshot is
a viewport capture at device scale factor 1 and 100% zoom, not a cropped or
stitched mock. Capture timestamp: 2026-09-07T08:21:07.692Z.

## Matching fixture

| Team | Members | Runtime | Workspace |
| --- | --- | --- | --- |
| Backend Team | Backend Manager, Backend Engineer, Backend Reviewer | Three running fixture agents | main |
| Frontend Team | Frontend Manager, Frontend Engineer, Frontend Reviewer | Three running fixture agents | feature/frontend |
| Platform Team | Platform Manager, Platform Engineer, Platform Reviewer | Configured, not started | main |

Both versions ran from separate detached source/build worktrees under /tmp and
separate runtime repositories, databases, ports, and tmux servers. The same
deterministic team/member IDs, role glyphs, instructions, workspace binding,
three delivered messages, and managed browser request were seeded through config
and real daemon APIs. There are no mocked browser responses or simulated UI widgets.

Agents use the safe-echo integration with the OpenCode adapter, not real AI
providers. Reviewer identity uses inherited permissions because a custom echo
launcher cannot enforce a read-only provider policy. Semantic status may be
Unknown because the fixture has no real AI reporter; Unknown is not a failed
launch. We did not fabricate Working, Done, approval, or provider-error states.

## Capture controls and limitations

* Main screens use both persisted dark and light themes; task interactions use
  dark mode. Full HD viewport, locale en-GB, and timezone UTC are fixed.
* Font loading, authenticated snapshots, terminal connections, and delivered
  message outcomes were awaited. The same setup advisory was dismissed through
  the actual UI before main captures. No content was hidden with injected CSS.
* Equivalent selections are used where available. Task-level differences and
  new-only views are named explicitly rather than made to look identical.
* Temporary paths, timestamps, process/run IDs, and revision digests differ
  naturally between independent daemons. No credential files or bootstrap URLs
  are included in the screenshots or manifest.
* No destructive confirmation or provider lifecycle action was applied. The
  invalid workspace request is an intentional real validation failure.
* Full HD does not show every scrolled region at once. The separate task captures
  expose important controls; these are not exhaustive keyboard, accessibility,
  mobile, real-provider, or failure-state certifications.
* The capture manifest records 128 screenshots,
  0 workflow capture gaps, and 0
  browser JavaScript errors. Asset dimensions and SHA-256 hashes are recorded in
  [image audit](assets/portal-comparison/image-audit.json).

## Evidence review

Two read-only reviewers inspected the initial 120 captures through contact sheets
and reopened key originals at full resolution. They identified transient terminal
backgrounds and below-fold action coverage, not wrong entities or themes. The
runner was tightened to wait for every visible terminal's connection and output;
all images were regenerated, and eight lower-scroll captures were added. Original
first-view images remain alongside these supplemental views.

A targeted follow-up review checked all eight supplemental originals and the
previously unsettled menu/palette backgrounds. The missing controls and checkpoint
empty states are now visible. The new plan-approval button still has low-contrast
text near the bottom edge of its scrolled view; this is retained as real UI
evidence, not corrected or hidden for the comparison. Lower command-palette
entries and upper content outside a scrolled viewport remain explicit limitations.

The comparison exposes one reproducible shared issue: workspace validation
feedback appears behind the open dialog. It is recorded separately as OPEN-002 in
[the functional bug ledger](portal-functional-bugs.md); the pinned old/new product
sources were not altered to conceal it. No UI/UX acceptance is implied by review.

## Validation and cleanup

All 128 original PNGs are 1920 x 1080. The offline HTML gallery was opened in
local Playwright Chromium: every image decoded, every section link resolved, and
the gallery had no horizontal overflow at Full HD. Capture scripts passed ESLint;
documentation and local image links were checked. No product test suite is claimed
to have run as part of this documentation task.

Both temporary daemons and their runtime repositories were closed by the harness.
The two detached source/build worktrees and task logs were removed after review;
no comparison tmux processes remained. The current feature branch and the existing
operator frontend worktree were left in place. Screenshots, manifest, image hashes,
contact sheets, and reproduction scripts are retained together as feature-branch
review material, separately from any decision to accept or release the redesign.

## Screens and workflows

### All agents

Matched list-only state with no selected inspector. Old uses configuration-scope, execution, and prompt columns; new uses runtime, model, and role columns. In the new navigation, All agents is a Teams subview. The old initial default selection was explicitly closed for this pair.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old All agents, dark](assets/portal-comparison/old-agents-dark.png)](assets/portal-comparison/old-agents-dark.png) | [![New All agents, dark](assets/portal-comparison/new-agents-dark.png)](assets/portal-comparison/new-agents-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old All agents, light](assets/portal-comparison/old-agents-light.png)](assets/portal-comparison/old-agents-light.png) | [![New All agents, light](assets/portal-comparison/new-agents-light.png)](assets/portal-comparison/new-agents-light.png) |

### Agent configuration

The same Backend Engineer is selected. Both show authored configuration and mapped workspace details; the new inspector adds management, session, and subscription entry points.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Agent configuration, dark](assets/portal-comparison/old-agent-configuration-dark.png)](assets/portal-comparison/old-agent-configuration-dark.png) | [![New Agent configuration, dark](assets/portal-comparison/new-agent-configuration-dark.png)](assets/portal-comparison/new-agent-configuration-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Agent configuration, light](assets/portal-comparison/old-agent-configuration-light.png)](assets/portal-comparison/old-agent-configuration-light.png) | [![New Agent configuration, light](assets/portal-comparison/new-agent-configuration-light.png)](assets/portal-comparison/new-agent-configuration-light.png) |

### Prompt layers

Both show the same global, team, and role instruction-source summary with Team expanded. This compares layer organization and a team-file path, not full instruction contents. No prompt text or provider output was substituted in the browser.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Prompt layers, dark](assets/portal-comparison/old-agent-prompts-dark.png)](assets/portal-comparison/old-agent-prompts-dark.png) | [![New Prompt layers, dark](assets/portal-comparison/new-agent-prompts-dark.png)](assets/portal-comparison/new-agent-prompts-dark.png) |

### Teams directory (new-only)

No direct old equivalent. The old portal organizes teams through its sidebar tree; the new portal adds a dedicated searchable Teams directory. The team-members and team-edit pairs below compare the equivalent tasks.

| Old (dark) | New (dark) |
| --- | --- |
| No direct equivalent | [![New Teams directory (new-only), dark](assets/portal-comparison/new-teams-directory-dark.png)](assets/portal-comparison/new-teams-directory-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| No direct equivalent | [![New Teams directory (new-only), light](assets/portal-comparison/new-teams-directory-light.png)](assets/portal-comparison/new-teams-directory-light.png) |

### Team membership entry point

Task comparison, not identical screens: old opens the team's terminals with members in the tree; new has a dedicated Members tab. Both select Backend Team.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Team membership entry point, dark](assets/portal-comparison/old-team-members-dark.png)](assets/portal-comparison/old-team-members-dark.png) | [![New Team membership entry point, dark](assets/portal-comparison/new-team-members-dark.png)](assets/portal-comparison/new-team-members-dark.png) |

### Edit team

Old opens a group-settings dialog from the sidebar menu; new edits within the selected team's inspector. Neither edit is saved.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Edit team, dark](assets/portal-comparison/old-team-edit-dark.png)](assets/portal-comparison/old-team-edit-dark.png) | [![New Edit team, dark](assets/portal-comparison/new-team-edit-dark.png)](assets/portal-comparison/new-team-edit-dark.png) |

### Create team

Both begin creating Data Team. Old uses a sidebar form; new uses a create dialog in Teams. The new team is not submitted.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Create team, dark](assets/portal-comparison/old-team-create-dark.png)](assets/portal-comparison/old-team-create-dark.png) | [![New Create team, dark](assets/portal-comparison/new-team-create-dark.png)](assets/portal-comparison/new-team-create-dark.png) |

### Review team deletion

Both review deleting Backend Team and its three active agents. No deletion is confirmed. These images compare impact information, not backend deletion correctness.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Review team deletion, dark](assets/portal-comparison/old-team-delete-dark.png)](assets/portal-comparison/old-team-delete-dark.png) | [![New Review team deletion, dark](assets/portal-comparison/new-team-delete-dark.png)](assets/portal-comparison/new-team-delete-dark.png) |

### Add agent

Both use the team-header Add agent control and show the same draft name. This retained dialog is intentionally a largely unchanged workflow.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Add agent, dark](assets/portal-comparison/old-agent-create-dark.png)](assets/portal-comparison/old-agent-create-dark.png) | [![New Add agent, dark](assets/portal-comparison/new-agent-create-dark.png)](assets/portal-comparison/new-agent-create-dark.png) |

### Edit agent

Old uses the sidebar agent-settings dialog; new uses the configuration inspector. Both inspect Backend Engineer with the same authored instructions and role. Save/Cancel fall below the initial new viewport; the next scrolled pair exposes them.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Edit agent, dark](assets/portal-comparison/old-agent-edit-dark.png)](assets/portal-comparison/old-agent-edit-dark.png) | [![New Edit agent, dark](assets/portal-comparison/new-agent-edit-dark.png)](assets/portal-comparison/new-agent-edit-dark.png) |

### Agent editor actions (scrolled)

The Save agent control is scrolled into view in each editor. Compare this with the initial Edit agent pair: the new inspector's actions fall below the first viewport, while the old dialog contains them. Nothing is saved.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Agent editor actions (scrolled), dark](assets/portal-comparison/old-agent-edit-actions-dark.png)](assets/portal-comparison/old-agent-edit-actions-dark.png) | [![New Agent editor actions (scrolled), dark](assets/portal-comparison/new-agent-edit-actions-dark.png)](assets/portal-comparison/new-agent-edit-actions-dark.png) |

### Organize agents

Old exposes reorder, move, and lifecycle commands in an agent menu. New exposes explicit Organize controls in Members, with move/lifecycle actions in Session. These are equivalent task entry points, not equivalent command sets in one view.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Organize agents, dark](assets/portal-comparison/old-agent-organize-dark.png)](assets/portal-comparison/old-agent-organize-dark.png) | [![New Organize agents, dark](assets/portal-comparison/new-agent-organize-dark.png)](assets/portal-comparison/new-agent-organize-dark.png) |

### Review agent removal

Both review removal of Backend Engineer. No removal is confirmed; the other agents continue running.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Review agent removal, dark](assets/portal-comparison/old-agent-remove-dark.png)](assets/portal-comparison/old-agent-remove-dark.png) | [![New Review agent removal, dark](assets/portal-comparison/new-agent-remove-dark.png)](assets/portal-comparison/new-agent-remove-dark.png) |

### Terminal grid

Three real safe-echo PTYs in Backend Team. New adds a role-glyph session strip above the existing live terminal panes. Output is fixture output, not an AI-provider conversation.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Terminal grid, dark](assets/portal-comparison/old-terminal-grid-dark.png)](assets/portal-comparison/old-terminal-grid-dark.png) | [![New Terminal grid, dark](assets/portal-comparison/new-terminal-grid-dark.png)](assets/portal-comparison/new-terminal-grid-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Terminal grid, light](assets/portal-comparison/old-terminal-grid-light.png)](assets/portal-comparison/old-terminal-grid-light.png) | [![New Terminal grid, light](assets/portal-comparison/new-terminal-grid-light.png)](assets/portal-comparison/new-terminal-grid-light.png) |

### Focused terminal

Backend Engineer is focused in both portals. Each viewport contains real terminal output and connection/ownership controls.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Focused terminal, dark](assets/portal-comparison/old-terminal-focused-dark.png)](assets/portal-comparison/old-terminal-focused-dark.png) | [![New Focused terminal, dark](assets/portal-comparison/new-terminal-focused-dark.png)](assets/portal-comparison/new-terminal-focused-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Focused terminal, light](assets/portal-comparison/old-terminal-focused-light.png)](assets/portal-comparison/old-terminal-focused-light.png) | [![New Focused terminal, light](assets/portal-comparison/new-terminal-focused-light.png)](assets/portal-comparison/new-terminal-focused-light.png) |

### Terminal Attention subscriptions

Both open the terminal bell's subscription dialog for Backend Engineer. The existing event and inherited-setting controls remain available.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Terminal Attention subscriptions, dark](assets/portal-comparison/old-terminal-subscriptions-dark.png)](assets/portal-comparison/old-terminal-subscriptions-dark.png) | [![New Terminal Attention subscriptions, dark](assets/portal-comparison/new-terminal-subscriptions-dark.png)](assets/portal-comparison/new-terminal-subscriptions-dark.png) |

### Terminal search

Both open the existing Search toolbar for the focused Backend Engineer terminal.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Terminal search, dark](assets/portal-comparison/old-terminal-search-dark.png)](assets/portal-comparison/old-terminal-search-dark.png) | [![New Terminal search, dark](assets/portal-comparison/new-terminal-search-dark.png)](assets/portal-comparison/new-terminal-search-dark.png) |

### Terminal transcript

Both open the live tmux transcript dialog. No retained historical checkpoint exists in the fixture, so checkpoint selection behavior is not compared.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Terminal transcript, dark](assets/portal-comparison/old-terminal-transcript-dark.png)](assets/portal-comparison/old-terminal-transcript-dark.png) | [![New Terminal transcript, dark](assets/portal-comparison/new-terminal-transcript-dark.png)](assets/portal-comparison/new-terminal-transcript-dark.png) |

### Additional terminal tools

Both open the focused terminal's overflow menu. This compares existing terminal commands within their surrounding shell.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Additional terminal tools, dark](assets/portal-comparison/old-terminal-tools-dark.png)](assets/portal-comparison/old-terminal-tools-dark.png) | [![New Additional terminal tools, dark](assets/portal-comparison/new-terminal-tools-dark.png)](assets/portal-comparison/new-terminal-tools-dark.png) |

### Messages

The same three message bodies are delivered to Backend Engineer in both versions before capture. Old shows a launcher for a modal composer; new attaches audience, intent, recipient, body, and execution controls to the conversation.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Messages, dark](assets/portal-comparison/old-messages-dark.png)](assets/portal-comparison/old-messages-dark.png) | [![New Messages, dark](assets/portal-comparison/new-messages-dark.png)](assets/portal-comparison/new-messages-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Messages, light](assets/portal-comparison/old-messages-light.png)](assets/portal-comparison/old-messages-light.png) | [![New Messages, light](assets/portal-comparison/new-messages-light.png)](assets/portal-comparison/new-messages-light.png) |

### Compose a message

The same draft targets Backend Manager in both portals, independently of the history messages sent to Backend Engineer. Old presents a modal; new keeps composition attached to the conversation. The draft is not sent.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Compose a message, dark](assets/portal-comparison/old-message-compose-dark.png)](assets/portal-comparison/old-message-compose-dark.png) | [![New Compose a message, dark](assets/portal-comparison/new-message-compose-dark.png)](assets/portal-comparison/new-message-compose-dark.png) |

### Delivery details

Both expand recipient details for the latest fixture message after terminal injection is confirmed. Delivery is distinct from durable execution; this does not claim an agent completed the requested work.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Delivery details, dark](assets/portal-comparison/old-message-delivery-dark.png)](assets/portal-comparison/old-message-delivery-dark.png) | [![New Delivery details, dark](assets/portal-comparison/new-message-delivery-dark.png)](assets/portal-comparison/new-message-delivery-dark.png) |

### Review message-history clearing

Both open the history-clear confirmation. Stored message history is not actually deleted.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Review message-history clearing, dark](assets/portal-comparison/old-message-clear-dark.png)](assets/portal-comparison/old-message-clear-dark.png) | [![New Review message-history clearing, dark](assets/portal-comparison/new-message-clear-dark.png)](assets/portal-comparison/new-message-clear-dark.png) |

### Attention inbox

A real managed browser request from Backend Manager populates both inboxes. Old presents actions on the event row; new presents an inspectable row with actions in the selected event's inspector.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Attention inbox, dark](assets/portal-comparison/old-attention-dark.png)](assets/portal-comparison/old-attention-dark.png) | [![New Attention inbox, dark](assets/portal-comparison/new-attention-dark.png)](assets/portal-comparison/new-attention-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Attention inbox, light](assets/portal-comparison/old-attention-light.png)](assets/portal-comparison/old-attention-light.png) | [![New Attention inbox, light](assets/portal-comparison/new-attention-light.png)](assets/portal-comparison/new-attention-light.png) |

### Inspect browser request

Both expose the same example.invalid URL. Old expands Full URL on the row; new opens the event inspector. The URL is not opened and no external site is contacted.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Inspect browser request, dark](assets/portal-comparison/old-attention-url-dark.png)](assets/portal-comparison/old-attention-url-dark.png) | [![New Inspect browser request, dark](assets/portal-comparison/new-attention-url-dark.png)](assets/portal-comparison/new-attention-url-dark.png) |

### Bulk Attention selection

Both select the same request and expose durable bulk dismissal. Dismissal is not applied.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Bulk Attention selection, dark](assets/portal-comparison/old-attention-selected-dark.png)](assets/portal-comparison/old-attention-selected-dark.png) | [![New Bulk Attention selection, dark](assets/portal-comparison/new-attention-selected-dark.png)](assets/portal-comparison/new-attention-selected-dark.png) |

### Workspace overview

Both have main plus a managed feature/frontend checkout assigned to Frontend Team. Old combines assignment and inventory; new starts with a branch directory.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Workspace overview, dark](assets/portal-comparison/old-workspaces-dark.png)](assets/portal-comparison/old-workspaces-dark.png) | [![New Workspace overview, dark](assets/portal-comparison/new-workspaces-dark.png)](assets/portal-comparison/new-workspaces-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Workspace overview, light](assets/portal-comparison/old-workspaces-light.png)](assets/portal-comparison/old-workspaces-light.png) | [![New Workspace overview, light](assets/portal-comparison/new-workspaces-light.png)](assets/portal-comparison/new-workspaces-light.png) |

### Workspace assignment

Old exposes assignments for all teams; new inspects main and shows its current owners plus an assign-another-team control.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Workspace assignment, dark](assets/portal-comparison/old-workspace-assignment-dark.png)](assets/portal-comparison/old-workspace-assignment-dark.png) | [![New Workspace assignment, dark](assets/portal-comparison/new-workspace-assignment-dark.png)](assets/portal-comparison/new-workspace-assignment-dark.png) |

### Create workspace

Both draft feature/platform and select Platform Team without enabling immediate activation. The worktree is not created.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Create workspace, dark](assets/portal-comparison/old-workspace-create-dark.png)](assets/portal-comparison/old-workspace-create-dark.png) | [![New Create workspace, dark](assets/portal-comparison/new-workspace-create-dark.png)](assets/portal-comparison/new-workspace-create-dark.png) |

### Attach existing workspace

Both open the retained attach-existing-worktree form. No filesystem path is submitted.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Attach existing workspace, dark](assets/portal-comparison/old-workspace-attach-dark.png)](assets/portal-comparison/old-workspace-attach-dark.png) | [![New Attach existing workspace, dark](assets/portal-comparison/new-workspace-attach-dark.png)](assets/portal-comparison/new-workspace-attach-dark.png) |

### Review workspace switch

Both review moving the three running Backend agents from main to feature/frontend. This destination is already assigned to Frontend Team. The preview is captured without applying it; it is not evidence the switch would be allowed.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Review workspace switch, dark](assets/portal-comparison/old-workspace-switch-dark.png)](assets/portal-comparison/old-workspace-switch-dark.png) | [![New Review workspace switch, dark](assets/portal-comparison/new-workspace-switch-dark.png)](assets/portal-comparison/new-workspace-switch-dark.png) |

### Workspace removal protection

feature/frontend is assigned and its removal control is disabled. Old shows this in inventory; new shows it in the Maintenance inspector.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Workspace removal protection, dark](assets/portal-comparison/old-workspace-maintenance-dark.png)](assets/portal-comparison/old-workspace-maintenance-dark.png) | [![New Workspace removal protection, dark](assets/portal-comparison/new-workspace-maintenance-dark.png)](assets/portal-comparison/new-workspace-maintenance-dark.png) |

### Workspace validation failure

Both submit the same invalid branch name to the actual API. The returned invalid_worktree_branch error is real. In both versions the feedback is outside the open dialog and dimmed by its backdrop. This is an observed UI issue, not a capture failure. No valid worktree is created.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Workspace validation failure, dark](assets/portal-comparison/old-workspace-error-dark.png)](assets/portal-comparison/old-workspace-error-dark.png) | [![New Workspace validation failure, dark](assets/portal-comparison/new-workspace-error-dark.png)](assets/portal-comparison/new-workspace-error-dark.png) |

### Provider overview

OpenCode's built-in package is selected in both. Old combines overview, plan, and lifecycle in one panel; new initially shows Overview in an inspector. Package readiness is not provider authentication.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Provider overview, dark](assets/portal-comparison/old-provider-overview-dark.png)](assets/portal-comparison/old-provider-overview-dark.png) | [![New Provider overview, dark](assets/portal-comparison/new-provider-overview-dark.png)](assets/portal-comparison/new-provider-overview-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Provider overview, light](assets/portal-comparison/old-provider-overview-light.png)](assets/portal-comparison/old-provider-overview-light.png) | [![New Provider overview, light](assets/portal-comparison/new-provider-overview-light.png)](assets/portal-comparison/new-provider-overview-light.png) |

### Provider plan

Both expose permissions, owned mutations, and command preview. New has a Plan tab; old includes these in the combined detail panel. The initial new viewport cuts off lower metadata and approval; the next scrolled pair exposes them. No approval is submitted.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Provider plan, dark](assets/portal-comparison/old-provider-plan-dark.png)](assets/portal-comparison/old-provider-plan-dark.png) | [![New Provider plan, dark](assets/portal-comparison/new-provider-plan-dark.png)](assets/portal-comparison/new-provider-plan-dark.png) |

### Provider plan approval (scrolled)

The exact-plan approval button is scrolled into view in both versions. This additional viewport exposes the command metadata and approval control below the initial new Plan capture. Approval is not submitted.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Provider plan approval (scrolled), dark](assets/portal-comparison/old-provider-plan-approval-dark.png)](assets/portal-comparison/old-provider-plan-approval-dark.png) | [![New Provider plan approval (scrolled), dark](assets/portal-comparison/new-provider-plan-approval-dark.png)](assets/portal-comparison/new-provider-plan-approval-dark.png) |

### Provider lifecycle

Both expose lifecycle commands. New places them in a Lifecycle tab; old keeps them under the combined preview. No provider mutation is performed.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Provider lifecycle, dark](assets/portal-comparison/old-provider-lifecycle-dark.png)](assets/portal-comparison/old-provider-lifecycle-dark.png) | [![New Provider lifecycle, dark](assets/portal-comparison/new-provider-lifecycle-dark.png)](assets/portal-comparison/new-provider-lifecycle-dark.png) |

### Provider removal review

Both type the same package ID into the conservative removal confirmation. New first expands Remove provider. Removal is not submitted; the fixture references this provider.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Provider removal review, dark](assets/portal-comparison/old-provider-removal-dark.png)](assets/portal-comparison/old-provider-removal-dark.png) | [![New Provider removal review, dark](assets/portal-comparison/new-provider-removal-dark.png)](assets/portal-comparison/new-provider-removal-dark.png) |

### Preferences

Same presentation preferences. Old uses form/card groups and selects; new uses unframed sections and segmented Theme/Density controls. Browser notification permissions are not granted.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Preferences, dark](assets/portal-comparison/old-settings-dark.png)](assets/portal-comparison/old-settings-dark.png) | [![New Preferences, dark](assets/portal-comparison/new-settings-dark.png)](assets/portal-comparison/new-settings-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Preferences, light](assets/portal-comparison/old-settings-light.png)](assets/portal-comparison/old-settings-light.png) | [![New Preferences, light](assets/portal-comparison/new-settings-light.png)](assets/portal-comparison/new-settings-light.png) |

### Role presentation

Both open the existing role-presentation dialog with matching Manager, Engineer, and Reviewer icons and colors. No settings are saved.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Role presentation, dark](assets/portal-comparison/old-roles-dark.png)](assets/portal-comparison/old-roles-dark.png) | [![New Role presentation, dark](assets/portal-comparison/new-roles-dark.png)](assets/portal-comparison/new-roles-dark.png) |

### Diagnostics

Both show actual daemon metadata, configuration status, and provider state. Checkpoints are below the initial new viewport; the separate scrolled pair shows that section. Version/build and random runtime identities legitimately differ.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Diagnostics, dark](assets/portal-comparison/old-diagnostics-dark.png)](assets/portal-comparison/old-diagnostics-dark.png) | [![New Diagnostics, dark](assets/portal-comparison/new-diagnostics-dark.png)](assets/portal-comparison/new-diagnostics-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Diagnostics, light](assets/portal-comparison/old-diagnostics-light.png)](assets/portal-comparison/old-diagnostics-light.png) | [![New Diagnostics, light](assets/portal-comparison/new-diagnostics-light.png)](assets/portal-comparison/new-diagnostics-light.png) |

### Diagnostics checkpoints (scrolled)

The Terminal checkpoints section is scrolled into view. Both fixtures have no retained checkpoints. The new page places this section below its initial Full HD viewport; this pair supplies the missing visible evidence.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Diagnostics checkpoints (scrolled), dark](assets/portal-comparison/old-diagnostics-checkpoints-dark.png)](assets/portal-comparison/old-diagnostics-checkpoints-dark.png) | [![New Diagnostics checkpoints (scrolled), dark](assets/portal-comparison/new-diagnostics-checkpoints-dark.png)](assets/portal-comparison/new-diagnostics-checkpoints-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Diagnostics checkpoints (scrolled), light](assets/portal-comparison/old-diagnostics-checkpoints-light.png)](assets/portal-comparison/old-diagnostics-checkpoints-light.png) | [![New Diagnostics checkpoints (scrolled), light](assets/portal-comparison/new-diagnostics-checkpoints-light.png)](assets/portal-comparison/new-diagnostics-checkpoints-light.png) |

### Service status

Both show the real service descriptor for the temporary fixture. No systemd service is installed or restarted for this comparison.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Service status, dark](assets/portal-comparison/old-service-dark.png)](assets/portal-comparison/old-service-dark.png) | [![New Service status, dark](assets/portal-comparison/new-service-dark.png)](assets/portal-comparison/new-service-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Service status, light](assets/portal-comparison/old-service-light.png)](assets/portal-comparison/old-service-light.png) | [![New Service status, light](assets/portal-comparison/new-service-light.png)](assets/portal-comparison/new-service-light.png) |

### Remote access

Both show real remote-access descriptors. No SSH tunnel is created.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Remote access, dark](assets/portal-comparison/old-remote-dark.png)](assets/portal-comparison/old-remote-dark.png) | [![New Remote access, dark](assets/portal-comparison/new-remote-dark.png)](assets/portal-comparison/new-remote-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Remote access, light](assets/portal-comparison/old-remote-light.png)](assets/portal-comparison/old-remote-light.png) | [![New Remote access, light](assets/portal-comparison/new-remote-light.png)](assets/portal-comparison/new-remote-light.png) |

### Help

Both display shipped generated help. The new layout changes section framing; command descriptions come from each version's registry.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Help, dark](assets/portal-comparison/old-help-dark.png)](assets/portal-comparison/old-help-dark.png) | [![New Help, dark](assets/portal-comparison/new-help-dark.png)](assets/portal-comparison/new-help-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old Help, light](assets/portal-comparison/old-help-light.png)](assets/portal-comparison/old-help-light.png) | [![New Help, light](assets/portal-comparison/new-help-light.png)](assets/portal-comparison/new-help-light.png) |

### About Nanasa

Both open the shipped About view. The displayed configuration-derived identifier is not a substitute for the pinned source SHAs recorded above.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old About Nanasa, dark](assets/portal-comparison/old-release-dark.png)](assets/portal-comparison/old-release-dark.png) | [![New About Nanasa, dark](assets/portal-comparison/new-release-dark.png)](assets/portal-comparison/new-release-dark.png) |

| Old (light) | New (light) |
| --- | --- |
| [![Old About Nanasa, light](assets/portal-comparison/old-release-light.png)](assets/portal-comparison/old-release-light.png) | [![New About Nanasa, light](assets/portal-comparison/new-release-light.png)](assets/portal-comparison/new-release-light.png) |

### More menu

Old keeps providers/preferences/help/about here while System routes are elsewhere; new folds provider and System destinations into More. Operations now contains Workspaces, Teams, Attention.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old More menu, dark](assets/portal-comparison/old-more-dark.png)](assets/portal-comparison/old-more-dark.png) | [![New More menu, dark](assets/portal-comparison/new-more-dark.png)](assets/portal-comparison/new-more-dark.png) |

### Command palette

Both open their actual registered command palette at its initial list position. Lower entries and some descriptions continue beyond this viewport; this pair does not demonstrate every registered command or shortcut.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Command palette, dark](assets/portal-comparison/old-commands-dark.png)](assets/portal-comparison/old-commands-dark.png) | [![New Command palette, dark](assets/portal-comparison/new-commands-dark.png)](assets/portal-comparison/new-commands-dark.png) |

### Connection and system status

Both open the actual System status dialog. Old launches from the header status badge; new launches from contextual project status.

| Old (dark) | New (dark) |
| --- | --- |
| [![Old Connection and system status, dark](assets/portal-comparison/old-system-status-dark.png)](assets/portal-comparison/old-system-status-dark.png) | [![New Connection and system status, dark](assets/portal-comparison/new-system-status-dark.png)](assets/portal-comparison/new-system-status-dark.png) |

## Reproduction

Source scripts: [capture runner](../scripts/capture-portal-comparison.ts) and
[workflow definitions](../scripts/portal-comparison-workflows.ts). Build separate
detached worktrees at the SHAs above. Follow [AGENTS.md](../AGENTS.md) before any
package command; preserve the registry environment and do not print secrets.

```bash
node --import tsx scripts/capture-portal-comparison.ts /tmp/old-source /tmp/new-source docs/assets/portal-comparison
node --import tsx scripts/render-portal-comparison.ts
```

The runner uses each source worktree's real PackageAcceptanceService, closes its
browser context and daemon, and removes its temporary runtime repository in
finally blocks. Source/build worktrees are removed separately after image review.
The current checkout and operator sessions are not used as comparison fixtures.
