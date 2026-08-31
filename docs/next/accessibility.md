---
title: Accessibility and keyboard operation
description: Keyboard, focus, terminal transcript, motion, contrast, and zoom behavior
ms.date: 2026-08-31
ms.topic: how-to
---

## Portal operation

Routes are deep linkable and announce navigation. Dialogs, menus, tabs, command palette results, and terminal controls provide keyboard operation and focus return. Reduced motion, forced colors, mobile layouts, and 200 percent zoom are supported portal states.

Group navigation contains Terminals, Messages, Attention, and Overview. The desktop
rail separates repository operations from the System and utility disclosures.
On narrow screens, an application drawer exposes the same global destinations
and group switching. Route destinations remain links, while disclosure and
drawer controls report expanded state and return focus when closed.

The Messages route is the canonical history and unread surface. Terminals expose
a quick-compose button that opens the message composer without duplicating
history or unread status. Attention category buttons use pressed state to filter
one result list. Exact waits retain their fenced reply controls, agent health and
completion items link to exact terminals, and delivery summaries link to group
Messages. Durable actions remain in a neutral Progress section.

One numbered repository Attention affordance is visible at a time. The left rail
owns it on desktop, while the workspace header owns it when the rail is hidden.
The selected group's Attention tab has its own scoped review-item count. Unread
counts appear only on Messages surfaces.

Terminal pinning, maximize state, grid split ratios, and per-agent completion
notification opt-ins are browser-owned preferences. These controls preserve
mounted xterm instances, merge independent changes across same-origin tabs, and
remove references to deleted runs or memberships. Completion notifications are
disabled by default and can be enabled from each agent's terminal toolbar. The
toggle affects only future quiet in-app or silent desktop notices; it does not
hide Done, change Attention counts, acknowledge work, or play a completion
sound. Attention sound has a dedicated default-off preference. When enabled, it
requires prior browser activation, deduplicates each urgent attention event
across same-origin tabs, and fails without interrupting portal operation when
audio is unavailable.

## Terminal access

One controller sends input. Observers can select and copy local text without
mutating the PTY. Hold Shift while dragging on Linux or Windows; use Option on
macOS. Completing the selection copies it to the regular browser clipboard.
`Ctrl+C` or `Command+C` copies an existing selection. Without a selection,
`Ctrl+C` remains terminal input.

Some TUIs own their highlighted selection instead of exposing it to xterm. When
such a TUI sends OSC 52, the controller receives a clipboard request containing
only its byte count. Activate Copy to write it to the browser clipboard. A
denied write remains available for retry until the request expires; observers
never receive the request.

Canvas terminal content is not the only readable surface. Open the bounded DOM transcript for assistive technology and mobile selection. Previous-output checkpoints are labeled by generation, capture time, and truncation and are never presented as live terminal state.

Browser clipboard access requires a trusted user action and reports denial
without logging or rendering payload data.
