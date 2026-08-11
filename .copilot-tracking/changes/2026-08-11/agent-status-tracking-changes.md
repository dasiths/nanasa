<!-- markdownlint-disable-file -->
---
title: Agent Status Tracking Changes
description: Durable change inventory for status foundation, reporters, traces, MCP, and portal progress
---

## Related Plan

`.copilot-tracking/plans/2026-08-11/agent-status-tracking-plan.instructions.md`

## Implementation Date

2026-08-11

## Summary

Added a generation-fenced semantic agent-status projection beside the existing
tmux process lifecycle. Claude Code, GitHub Copilot CLI, Pi, and OpenCode now
receive private TUI-preserving reporters. Principal agents can inspect status
and publish progress through MCP, while the portal shows state and attention.

## Added

* `apps/daemon/src/agent-status-reducer.ts`
* `apps/daemon/src/agent-status-routes.ts`
* `apps/daemon/src/status-reporter-assets.ts`
* `apps/daemon/test/agent-status-reducer.test.ts`
* `apps/daemon/test/agent-status-store.test.ts`
* `apps/daemon/test/status-reporter-goldens.test.ts`
* Version-pinned reporter fixtures under
  `apps/daemon/test/fixtures/status-reporters/`

## Modified

* `packages/contracts/src/index.ts` and contract tests
* `.devcontainer/Dockerfile` for persistent Playwright Chromium dependencies
* Daemon provisioning, server, MCP, store, coordinator, and tmux runtime
* Daemon provisioning, MCP, migration, recovery, and package-facing tests
* Portal group tree, selected-group summary, styling, and component tests
* `README.md`

## Release Summary

* Status states cover not started, starting, working, waiting, idle, suspected
  stuck, stopped, and crashed.
* Explicit waits dominate silence and concurrent activity.
* SQLite schema version 2 persists bounded observations, reducer correlation
  state, and task progress.
* Tmux records verified exit status/signal before recovery and does not treat
  inspection failure as process death.
* New MCP tools list/get statuses and report progress.
* Reporter data excludes prompts, arguments, output, paths, transcripts, and
  reasoning.
* Copilot uses its documented user hook directory because the installed CLI
  discovers hook-only external plugins but does not activate their hooks.
* All five Playwright acceptance tests pass on desktop and mobile viewports.
