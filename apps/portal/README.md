---
title: Nanasa portal
description: Development and production build notes for the Nanasa operational portal
author: Nanasa
ms.date: 2026-08-31
ms.topic: reference
---

## Development

The portal uses relative `/api/v1` URLs for application REST, event WebSocket, and
`nanasa-terminal.v1` traffic. The daemon remains at
`http://127.0.0.1:3210` by default.

Set `VITE_DAEMON_URL` when the daemon uses another origin:

```bash
VITE_DAEMON_URL=http://127.0.0.1:4210 pnpm --filter @nanasa/portal dev
```

## Terminal views

The portal owns xterm and selected addons. Tab layout mounts the selected run,
while grid layout mounts each visible run. Tabs, status bars, and accessible
terminal names include both the member alias and stable member ID.

One controller and bounded observers can view a run. Observers receive output
and can copy local selections, but cannot send input, paste, resize, focus, or
approve effects. Unmounting a view removes only its disposable attachment.

xterm provides 10,000 lines of local scrollback. PageUp and PageDown remain input
for the active TUI, and tmux mouse mode forwards wheel events to mouse-aware
applications or uses them for copy-mode scrollback. Full-screen alternate-screen
TUIs own their visible history, so browser scrollbars can remain stationary even
while the application scrolls internally.

The daemon enables tmux extended-key reporting and external-only clipboard signaling for the
private server. Modified Enter bindings therefore reach compatible TUIs. Agent
PTYs disable software flow control so `Ctrl+S` and `Ctrl+Q` remain application
input. Shift+drag selects locally and copies the completed selection on Linux
and Windows. Option+drag performs the same action on macOS. `Ctrl+C` or
`Command+C` copies an existing selection; without a selection, `Ctrl+C` remains
PTY input. Trusted copy and paste events are preferred, while toolbar actions
provide a permission-aware fallback. Prompted OSC 52 writes are controller-only,
and reads are rejected. TUI-owned selections can send tmux-wrapped OSC 52 to the
controller. The portal keeps a denied request available for another trusted
Copy click until it is replaced, expires, or the controller role is lost.

The Messages group route displays every persisted group message as a shared
chronological timeline. Portal senders appear as Human; authenticated MCP senders
show their agent name and stable member ID, so agent-to-agent messages remain
visible alongside operator messages. Hovering an initials badge shows the sender
or recipient ID. Each message exposes a collapsed recipient and delivery summary
with live outcomes. A claimed delivery count of two means one retry followed by
success and is displayed as `Retried once`.

Terminals expose a small quick-compose launcher. It opens the same audience,
recipient, intent, and body composer without duplicating message history, unread
state, action progress, or exact waits. The Messages tab owns unread state and
history. The Attention tab uses the retained `/activity` route for approvals,
exact waits, health, completions, delivery summaries, and durable work progress.
Unread messages remain a Messages count, while active and historical actions
appear as neutral progress rather than review badge units.

The daemon serializes every automated delivery through the terminal input arbiter
and rechecks exact runtime identity before pasting text and sending Enter. A
`terminal_injected` outcome confirms transport, not semantic completion by the
agent CLI. Terminal tab and grid layout remain independent, with grid rendering
up to three agent columns, then two and one at smaller breakpoints.

## Operations and preferences

The horizontal group navigation contains Terminals, Messages, Attention, and
Overview. Repository-wide Attention, All agents, and Checkouts live in the left
rail. Extensions, Diagnostics, Service, and Remote access are grouped under
System. Preferences, Help, About Nanasa, and theme selection are available from
the rail utility menu. The desktop rail owns the repository Attention count.
Narrow screens hide that rail and expose the same count through the workspace
header and application drawer.

Agent creation validates `/api/v1/config` with the shared configuration schema and
lists every configured integration and role by display name and key. A
configuration load failure has a dedicated blocking state so the portal cannot
offer stale or hardcoded launch choices.

The selected group header exposes Start all. One in-flight idempotency key is
used until completion, then a live status panel lists started, already-running,
and failed outcomes. Group and agent menus support inline rename and confirmed
removal; removing an active agent stops its run first. Agent rows show
one user-facing status and any scheduled retry time. Agent details retain raw
backend, terminal, and recovery diagnostics. Start is hidden during continuation;
Retry appears only after continuation can no longer proceed.

The workspace header reports agent and running counts. The agent-set revision is
kept internal for safe broadcasts and is not displayed.

Light, dark, and system themes and the terminal tab or grid layout persist in
`localStorage` under `nanasa.portal.preferences.v2`. Storage events synchronize
open tabs. Malformed values and unavailable storage use system theme and tab
layout while controls remain usable. Browser-local message cache and clear
markers use separate versioned keys. Preferences are independent of group
selection.

## Production build

`pnpm --filter @nanasa/portal build` creates static assets in `dist`. The portal
keeps relative API paths so the assets can be served from the daemon origin or
behind a reverse proxy.

Run `pnpm build` followed by `pnpm start` from the repository root to serve the
bundle from the Fastify daemon. The daemon uses an extensionless SPA fallback
without masking `/api` routes or missing asset responses.

Set `NANASA_SERVE_PORTAL=false` to disable static serving, or set
`NANASA_PORTAL_PATH` to serve a different build directory.