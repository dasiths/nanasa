---
title: Accessibility and keyboard operation
description: Keyboard, focus, terminal transcript, motion, contrast, and zoom behavior
ms.date: 2026-08-30
ms.topic: how-to
---

## Portal operation

Routes are deep linkable and announce navigation. Dialogs, menus, tabs, command palette results, and terminal controls provide keyboard operation and focus return. Reduced motion, forced colors, mobile layouts, and 200 percent zoom are supported portal states.

Terminal pinning, maximize state, and grid split ratios are browser-owned preferences. These controls preserve mounted xterm instances, merge independent changes across same-origin tabs, and remove references to deleted runs. Attention sound has a dedicated default-off preference. When enabled, it requires prior browser activation, deduplicates each attention event across same-origin tabs, and fails without interrupting portal operation when audio is unavailable.

## Terminal access

One controller sends input. Observers can select and copy local text without mutating the PTY. Hold Shift while dragging on Linux or Windows. The browser client uses Option as the selection override on macOS clients.

Canvas terminal content is not the only readable surface. Open the bounded DOM transcript for assistive technology and mobile selection. Previous-output checkpoints are labeled by generation, capture time, and truncation and are never presented as live terminal state.

Browser clipboard access requires a trusted user action and reports denial without logging payload data.
