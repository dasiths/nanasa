---
title: Nanasa portal
description: Development and production build notes for the Nanasa operational portal
author: Nanasa
ms.date: 2026-08-10
ms.topic: reference
---

## Development

The portal uses relative `/api` URLs for application REST and event WebSocket
traffic. Terminal status responses contain bounded relative `/terminals` URLs,
which the portal mounts as ttyd iframes. Vite proxies both route families to the
daemon at `http://127.0.0.1:3210` by default. The terminal proxy preserves the
browser authority so the daemon and ttyd can enforce same-origin WebSocket
upgrades.

Set `VITE_DAEMON_URL` when the daemon uses another origin:

```bash
VITE_DAEMON_URL=http://127.0.0.1:4210 pnpm --filter @nanasa/portal dev
```

## Terminal views

ttyd is the portal's only terminal provider. Tab layout mounts one iframe for
the selected run. Grid layout mounts one iframe for each visible run. Every
iframe uses the daemon-provided same-origin URL, a descriptive title, and a
same-origin referrer policy. Tabs, status bars, iframe titles, and accessible
terminal names include both the member alias and stable member ID.

Each ttyd endpoint permits one live client. If ttyd asks to reconnect, close any
other tab, grid, or browser showing that run before retrying. Unmounting an
iframe removes only ttyd's disposable tmux client; the owner pane and agent
process continue in the daemon's private tmux server. Starting, retrying,
unavailable, and stopped states render outside the iframe.

ttyd provides 10,000 lines of xterm scrollback. PageUp and PageDown remain input
for the active TUI, and tmux mouse mode forwards wheel events to mouse-aware
applications or uses them for copy-mode scrollback. Full-screen alternate-screen
TUIs own their visible history, so browser scrollbars can remain stationary even
while the application scrolls internally.

The portal displays every persisted group message as a shared chronological chat
timeline. Portal senders appear as Human; authenticated MCP senders use their
membership alias, so agent-to-agent messages are visible alongside operator
messages. Each message exposes a collapsed recipient and delivery summary with
live outcomes.

Desktop layouts place history in a vertical pane beside the horizontal composer.
Tablet and mobile layouts stack the composer above the history pane.

The composer and terminal views remain mounted in one workspace. Before any
portal or agent-originated delivery, the portal temporarily disconnects writable
ttyd clients so the daemon can paste text into each verified recipient pane and
send Enter separately. A consumed outcome confirms terminal injection, not
semantic completion by the agent CLI.

## Operations and preferences

Profile creation validates `/api/config` with the shared configuration schema
and lists every configured agent type by display name and key. A configuration
load failure has a dedicated blocking state so the portal cannot offer stale or
hardcoded launch choices.

The selected group header exposes Start all. One in-flight idempotency key is
used until completion, then a live status panel lists started, already-running,
and failed outcomes. Group and member menus support inline rename and confirmed
removal; removing an active member stops its run first. Member rows show
recovery phase, reason, and scheduled retry time. Start is hidden during
continuation; Retry appears only after continuation can no longer proceed.

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