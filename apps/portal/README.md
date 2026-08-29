---
title: Nanasa portal
description: Development and production build notes for the Nanasa operational portal
author: Nanasa
ms.date: 2026-08-29
ms.topic: reference
---

## Development

The portal uses relative `/api` URLs for application REST, event WebSocket, and
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
input. Shift+drag selects locally on Linux and Windows. Option+drag performs the
same override on macOS. Trusted copy and paste events are preferred, while
toolbar actions provide a permission-aware fallback. Prompted OSC 52 writes are
controller-only, and reads are rejected.

The portal displays every persisted group message as a shared chronological chat
timeline in a bottom-right floating overlay. Portal senders appear as Human;
authenticated MCP senders show their agent name and stable member ID, so
agent-to-agent messages are visible alongside operator messages. Hovering an
initials badge shows the sender or recipient ID. Each message exposes a collapsed
recipient and delivery summary with live outcomes. A claimed delivery count of
two means one retry followed by success and is displayed as `Retried once`.

The overlay keeps a compact `Type a message...` prompt below history. Activating
it opens a modal for audience, recipients, intent, intent description, and body.
Its launcher persists open state and reports unread messages while closed. On
narrow screens, the overlay becomes an inset full-screen sheet. Terminal tab and
grid layout remain independent, with grid rendering up to three agent columns,
then two and one at smaller breakpoints.

Messages floats over the terminal workspace. Before any portal or agent-originated
delivery, the portal temporarily suspends terminal controllers so the daemon can
paste text into each verified recipient pane and
send Enter separately. A consumed outcome confirms terminal injection, not
semantic completion by the agent CLI.

## Operations and preferences

Agent creation validates `/api/config` with the shared configuration schema and
lists every configured integration and role by display name and key. A
configuration load failure has a dedicated blocking state so the portal cannot
offer stale or hardcoded launch choices.

The selected group header exposes Start all. One in-flight idempotency key is
used until completion, then a live status panel lists started, already-running,
and failed outcomes. Group and agent menus support inline rename and confirmed
removal; removing an active agent stops its run first. Agent rows show
recovery phase, reason, and scheduled retry time. Start is hidden during
continuation; Retry appears only after continuation can no longer proceed.

The workspace header reports agent and running counts. The agent-set revision is
kept internal for safe broadcasts and is not displayed.

Light, dark, and system themes and the terminal tab or grid layout persist in
`localStorage` under `nanasa.portal.preferences.v1`. Storage events synchronize
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