<!-- markdownlint-disable-file -->
---
title: Tmux agent pool MVP review
description: Fulfillment and validation review for the first Nanasa implementation plan
author: Nanasa
ms.date: 2026-08-09
ms.topic: reference
---

## Review Metadata

* Plan: `.copilot-tracking/plans/2026-08-09/tmux-agent-pool-mvp-plan.instructions.md`
* Review date: 2026-08-09
* Reviewer: RPI Agent direct review

## Request Fulfillment

* Complete: pnpm TypeScript workspace and shared runtime contracts
* Complete: durable groups, profiles, memberships, runs, messages, deliveries,
  and domain events
* Complete: private tmux process lifecycle and control-mode terminal transport
* Complete: portal tree, terminal tabs and grid, browser input, and writer leases
* Complete: DM, multicast, and broadcast composition with intent, delivery mode,
  fallback, and outcomes
* Partial by planned scope: real agent TUIs launch, but native Copilot, Pi,
  OpenCode, and Claude structured adapters remain deferred

## Placement and Quality

Domain contracts live in `packages/contracts`; daemon ownership and persistence
live in `apps/daemon`; portal-specific state and presentation live in
`apps/portal`. Terminal and semantic message transports remain separate.

Direct review found and fixed four lifecycle and browser issues: tmux shutdown
`EPIPE`, delayed profile selection, mobile overlay interception, and unnecessary
terminal WebSocket restarts on snapshot refresh.

## Validation

* `pnpm typecheck`: passed
* `pnpm test`: passed, 30 tests
* `pnpm lint`: passed
* `pnpm format:check`: passed
* `pnpm build`: passed
* `pnpm smoke`: passed real tmux integration
* `git diff --check`: passed
* Production browser: passed desktop and mobile operational workflows

The editor reports one diagnostic inside the published
`@fastify/websocket/node_modules` tsconfig because its development-only
`fastify-tsconfig` package is absent. Project source type checking is unaffected.

## Remaining Work

* Implement native Copilot SDK or ACP delivery
* Implement Pi RPC delivery
* Implement OpenCode HTTP, SDK, or ACP delivery
* Implement Claude Agent SDK or stream-JSON delivery
* Add authentication, worktree isolation, retries, dead letters, and cost controls
* Split the portal bundle when load performance warrants it

## Overall Status

Complete for the planned vertical-slice scope.