<!-- markdownlint-disable-file -->
---
title: Tmux agent pool MVP implementation details
description: Phase-by-phase file operations and validation gates for the first Nanasa portal slice
author: Nanasa
ms.date: 2026-08-09
ms.topic: reference
---

## Context References

* Plan: `.copilot-tracking/plans/2026-08-09/tmux-agent-pool-mvp-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-08-09/agent-pool-tmux-portal-research.md`
* Planning log: `.copilot-tracking/plans/logs/2026-08-09/tmux-agent-pool-mvp-log.md`

## Phase 1 Details

Create `apps/daemon`, `apps/portal`, and `packages/contracts`. Keep package
boundaries explicit and use TypeScript project references or workspace package
exports. Root scripts must run all checks without hidden global dependencies.

Success gate: contracts compile, tests run, and the portal and daemon production
builds resolve workspace imports.

## Phase 2 Details

The daemon is the sole SQLite writer. Repositories expose typed domain methods,
not SQL rows. Commands append domain events in the same transaction as state
changes. Initial message delivery may remain queued when no native adapter is
available, but requested and applied modes must remain explicit.

Success gate: API tests create groups, add members, create messages, and retrieve
recipient delivery outcomes after restart.

## Phase 3 Details

Use `tmux -L nanasa` and one session per group with one window per run. Parse
control-mode command blocks separately from asynchronous notifications. Decode
octal-escaped pane output. Use `capture-pane -p -e` for initial terminal state.

Terminal input accepts typed frames for input, paste, resize, and writer-lease
operations. Paste content travels through stdin to a unique named tmux buffer.

Success gate: an automated shell fixture emits output, accepts input, survives a
browser disconnect, and returns a snapshot on reconnect.

## Phase 4 Details

The first screen is the operational portal. Use a persistent left group tree,
compact toolbar, terminal tabs/grid, and a lower or side activity/message region.
Avoid marketing content and decorative cards. Maintain stable terminal sizes and
mobile overflow behavior.

Success gate: operator workflows fit desktop and mobile viewports without text
overlap; terminal focus and group selection remain predictable.

## Phase 5 Details

Run targeted tests after each implementation phase, then full typecheck, lint,
test, and build. Start the daemon and portal development servers. Exercise REST,
WebSocket, and tmux lifecycle behavior. Use browser screenshots and interaction
checks when browser tooling is available.

## Known Deferred Work

* Native Copilot SDK adapter
* Pi RPC adapter
* OpenCode HTTP or ACP adapter
* Claude stream-JSON or Agent SDK adapter
* Authentication, multi-user RBAC, and remote runners
* Worktree orchestration and patch merging