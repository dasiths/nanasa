<!-- markdownlint-disable-file -->
---
title: Ttyd terminal provider implementation details
description: File operations and validation gates for the Nanasa ttyd migration
author: Nanasa
ms.date: 2026-08-09
ms.topic: reference
---

## Runtime Shape

`TmuxRuntime` creates durable owner panes in one group session and deterministic
view sessions with one linked window per run. `TtydSupervisor` starts a ttyd
server for each active run. `TerminalEndpointRegistry` exposes only ready
loopback upstreams. Fastify proxies a bounded same-origin path to each ttyd.

## View Session Rules

* Name view sessions from a hash of the run ID
* Link exactly the persisted owner window
* Remove the temporary bootstrap window
* Set `prefix None`, `prefix2 None`, `status off`, and `destroy-unattached off`
* Set the linked window to `window-size latest`
* Never move or duplicate the owner pane process

## Ttyd Process Rules

Spawn with direct argv and `shell: false`. Use loopback, port zero, a bounded
base path, writable mode, one client, origin checks, and `xterm-256color`.
Parse the selected port from bounded startup output and probe the index before
publishing readiness.

## Proxy Rules

Register a Fastify 5 compatible proxy under `/terminals/:endpointKey`. Preserve
the base path and query string. Permit only the index, token, and WebSocket
routes. Resolve upstreams synchronously from the endpoint registry. Return 503
while ttyd is starting or in backoff.

## Portal Rules

Use same-origin iframe URLs returned by the daemon. Tab mode mounts one iframe.
Grid mode mounts one iframe per visible run. Removing an iframe disconnects only
the disposable tmux client created by ttyd.

## Removals

* `apps/daemon/src/terminal-gateway.ts`
* `apps/daemon/src/tmux-control.ts`
* Custom terminal protocol schemas and parser tests
* `apps/portal/src/terminal-client.ts`
* Portal xterm.js and FitAddon dependencies

## Validation Gates

1. Contracts and supervisor unit tests
2. Real tmux and ttyd integration tests
3. Proxy HTTP and WebSocket tests
4. Portal tests and production build
5. Browser desktop/mobile render, input, resize, disconnect, reconnect, and grid
6. Full repository checks