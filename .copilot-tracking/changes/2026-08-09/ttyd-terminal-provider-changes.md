---
title: Ttyd terminal provider changes
description: Durable change inventory for replacing the custom browser terminal path with ttyd
author: Nanasa
ms.date: 2026-08-09
ms.topic: reference
---

## Related plan

`.copilot-tracking/plans/2026-08-09/ttyd-terminal-provider-plan.instructions.md`

## Summary

ttyd is now Nanasa's sole browser terminal provider. tmux remains the durable
owner of each agent pane, while the daemon supervises ephemeral per-run ttyd
children and proxies bounded same-origin endpoint paths to the portal.

## Added

* Deterministic single-window tmux view sessions linked to durable owner windows
* Per-run `TtydSupervisor` processes on unpublished loopback ports
* Terminal endpoint registry with starting, ready, backoff, unavailable, stopping, and stopped states
* Restricted HTTP and WebSocket proxy routes under `/terminals/:endpointKey`
* Terminal status discovery under `/api/runs/:runId/terminal`
* Portal ttyd iframe tabs, grid, retry states, same-origin referrer policy, and one-client guidance
* Real two-run ttyd/tmux lifecycle coverage and coordinator stop-order coverage
* Vite development proxying for `/terminals` HTTP and WebSocket requests

## Modified

* `TmuxRuntime` now owns durable panes, view sessions, and reconciliation only
* Run coordination withdraws ttyd, removes the view session, and then stops the owner pane
* Daemon shutdown terminates ttyd children without terminating active tmux panes or valid views
* Contracts expose provider state and same-origin URL without loopback details
* The repository smoke command runs the real ttyd runtime integration target
* Root and portal documentation describe the final provider and durability model

## Removed

* Custom terminal frame contracts and writer-lease protocol
* Tmux control-mode capture, replay, input, resize, and pause transport
* Daemon custom terminal gateway and `/api/terminal` WebSocket route
* Portal terminal client, xterm.js renderer, and FitAddon dependencies

## Security and lifecycle properties

* ttyd binds only to `127.0.0.1` on a random unpublished port
* Endpoint keys, view names, and base paths are derived from validated run IDs
* Proxy routing accepts only index, token, and tty WebSocket paths
* WebSocket upgrades require same-origin authority and the `tty` subprotocol
* Credentials and untrusted forwarding headers are stripped before loopback forwarding
* ttyd command arguments are fixed direct argv with URL arguments disabled
* One browser client is enforced by ttyd for each run
* Browser and daemon disconnects do not terminate durable owner panes

## Known risks and deferrals

ttyd 1.7.7 dates from March 2024. It is pinned and checksum-verified, but its age
requires a production security and compatibility review against the latest ttyd
release.

Ungraceful daemon-crash PID manifests and exact child adoption remain deferred.
The current implementation safely covers graceful child termination and
tmux-authoritative restart reconciliation without adopting unknown processes.

Native structured adapters for GitHub Copilot CLI, Pi, OpenCode, and Claude Code
remain outside this migration. Their terminal processes run normally, while
structured messages remain queued in the daemon.

## Validation

* Typecheck, lint, format check, and production build pass
* 57 automated tests pass
* Real ttyd 1.7.7 and tmux smoke passes
* Tracked diff whitespace check passes
* Desktop and mobile browser verification passed for tabs, two-run grid, input
	isolation, resize, reconnect history, and one-client enforcement
* Live Vite HTTP and WebSocket proxying passed on the same-origin terminal path