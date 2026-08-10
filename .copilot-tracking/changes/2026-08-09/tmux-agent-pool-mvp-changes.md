<!-- markdownlint-disable-file -->
---
title: Tmux agent pool MVP changes
description: Complete change inventory for the first Nanasa tmux-backed portal slice
author: Nanasa
ms.date: 2026-08-09
ms.topic: reference
---

## Related Plan

`.copilot-tracking/plans/2026-08-09/tmux-agent-pool-mvp-plan.instructions.md`

## Implementation Date

2026-08-09

## Summary

Implemented a local-first TypeScript workspace with shared contracts, a Fastify
and SQLite daemon, private tmux runtime, terminal and domain WebSockets, and a
responsive React operations portal.

## Added

* Root pnpm, TypeScript, ESLint, and Biome workspace configuration
* `packages/contracts` runtime schemas and contract tests
* `apps/daemon` persistence, APIs, control-event stream, tmux runtime, terminal
  gateway, and integration tests
* `apps/portal` group tree, lifecycle controls, xterm terminal tabs and grid,
  structured message composer, reconnecting clients, responsive styles, and
  portal tests
* Production portal serving and real tmux smoke validation
* Research, planning, details, changes, and review tracking artifacts

## Modified

* `README.md` now documents architecture, setup, development, validation, and
  current native-adapter limitations
* Portal behavior was corrected after browser verification for delayed profiles,
  mobile overlay control, and stable terminal connections
* Tmux shutdown ignores the expected broken-pipe race when a control client exits

## Removed

No product files removed.

## Deviations

* `script(1)` supplies the PTY required by tmux 3.3a control mode
* Native structured adapters remain deferred behind the implemented adapter and
  delivery contracts
* The production JavaScript bundle emits a non-fatal Vite size warning

## Validation

* 30 tests pass: 13 contracts, 12 daemon, and 5 portal
* Type checking, lint, formatting, build, smoke, and diff checks pass
* Browser validation passed desktop, mobile, terminal, message, event, and SPA
  route workflows

## Release Summary

Nanasa now has an executable local MVP for operator-managed groups, tmux-backed
agent terminals, direct browser terminal control, and durable structured message
routing. Native SDK and RPC delivery into live agent contexts is the next phase.