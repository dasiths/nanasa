<!-- markdownlint-disable-file -->
---
title: Terminal-only runtime, MCP, CRUD, and browser changes
description: Durable change inventory for the completed terminal-only Nanasa increment
author: Nanasa
ms.date: 2026-08-10
ms.topic: reference
---

## Related plan

`.copilot-tracking/plans/2026-08-10/terminal-only-mcp-crud-plan.instructions.md`

## Terminal-only runtime and persistence

* Removed model-specific SDK, ACP, RPC, worker, protocol, process, and adapter behavior from the active runtime and shipped package
* Launched each configured agent command directly in a tmux pane and retained ttyd as the browser terminal renderer and keyboard channel
* Narrowed durable message delivery to terminal paste followed by a separate Enter key, with retries, expiry, dead letters, and no semantic completion claim
* Migrated the live database in place from `user_version` 0 to 1; integrity remained OK and existing groups, memberships, profiles, runs, messages, and events were preserved
* Replaced active legacy worker generations without resetting repository-local state
* Added ownership and generation fencing to destructive pane operations, including linked-view ownership handling
* Joined wrapped tmux pane capture lines so acceptance assertions reflect the logical command stream

## MCP and remote access

* Hosted authenticated Streamable HTTP MCP at `/mcp` in the authoritative Fastify daemon
* Added generation-scoped agent capabilities and an explicit remote operator bearer principal
* Added DM, multicast, and sender-excluded broadcast tools through the same durable message command service used by the portal
* Kept Nanasa loopback-only and supported remote MCP through an HTTPS reverse proxy that exposes `/mcp`
* Hardened the MCP signing secret directory and file against weak permissions, wrong ownership, and symlink substitution
* Added protocol, Host, Origin, authentication, identity, audience, revocation, stale-generation, and terminal-delivery coverage

## CRUD and portal behavior

* Added group and membership rename plus membership and group removal across contracts, storage, REST, and portal surfaces
* Enforced coordinator-owned stop-before-delete behavior while preserving reusable profiles and append-only events
* Limited snapshots to active memberships and reconciled message recipients and results after group or member changes
* Made inline rename single-flight and restored keyboard focus after save or cancellation
* Remounted ttyd iframes when recovered terminal endpoints become available after daemon restart
* Preserved responsive controls and added mobile destructive-dialog and keyboard-focus coverage

## Acceptance and packaging

* Isolated mutable package repository, database, ports, tmux server, and runtime state per Playwright test
* Covered Start All, terminal DM, multicast, broadcast, preferences, responsive layout, rename, live delete, restart recovery, post-restart input, and mobile destructive actions
* Strengthened live deletion assertions to prove owned panes stop before graph removal and retained data remains available
* Verified direct pane commands for `make`, `pi`, and the Copilot shell
* Verified no workers remain in shipped output
* Extracted Chromium runtime libraries under `/tmp` in the unprivileged container and ran acceptance with `LD_LIBRARY_PATH` pointing to those libraries

## Final validation

* Contract tests: 36 passed
* Daemon tests: 87 passed
* Portal tests: 39 passed
* Package tests: 6 passed
* Real ttyd smoke: 1 passed
* Playwright acceptance: 5 passed
* Typecheck, lint, format check, build, package build, and diff check: passed
* Live database migration: `user_version` 0 to 1, integrity OK, entities preserved
* Shipped output scan: no workers

## Overall status

Complete.
