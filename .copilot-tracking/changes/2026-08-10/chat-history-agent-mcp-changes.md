<!-- markdownlint-disable-file -->
---
title: Chat history and persistent agent MCP changes
description: Implementation record for the shared chat timeline and per-membership MCP client provisioning
ms.date: 2026-08-10
ms.topic: reference
---

## Related plan

`.copilot-tracking/plans/2026-08-10/chat-history-agent-mcp-plan.instructions.md`

## Summary

* Replaced submission cards with an authoritative chronological group-chat timeline.
* Added Human and agent identities, initials, delivery summaries, and expandable recipient status.
* Added browser cache deduplication, local clear markers, and bottom-aware scrolling.
* Added hardened per-membership agent directories and generated MCP client configuration.
* Added automatic Copilot, Claude Code, Pi, and OpenCode MCP wiring.
* Added the official pinned Pi MCP Adapter available from the required package mirror.
* Generalized terminal writer handoff to agent-originated MCP messages.
* Enabled MCP in the repository production start script while retaining installed CLI opt-in.
* Added readable type-prefixed member IDs with Docker-style names and collision retries.
* Added active-member discovery, agent self-target rejection, and trusted sender envelopes.
* Added member IDs to terminal labels and enabled PageUp, PageDown, wheel, and scrollback routing.
* Changed desktop Messages to a horizontal composer with a vertical history pane.
* Removed all existing live domain and runtime state at the user's request.
* Added clipboard copy controls beside group-row and terminal-tab member IDs.
* Published retrying, rejected, revoked, and dead-letter transitions as `delivery.status-changed` events.
* Created Agent Team through Playwright with GitHub Copilot, Claude Copilot, and PI, then started all three.

## Added

* `apps/daemon/src/agent-runtime-provisioner.ts`
* `apps/daemon/test/agent-runtime-provisioner.test.ts`
* Chat/MCP research, plan, details, planning log, changes log, and review log under `.copilot-tracking/`

## Modified

* Daemon run creation, tmux launch, server composition, package dependencies, and tests
* Portal app data flow, message workspace, styles, tests, and browser acceptance
* Package fixture MCP support and package-install checks
* Root and portal documentation, ignore rules, scripts, and lockfile

## Validation

* Contract tests: 36 passed
* Daemon tests: 95 passed
* Portal tests: 44 passed
* Package tests: 6 passed
* Playwright acceptance: 5 passed
* Typecheck, ESLint, Biome, diagnostics, build, package build, and diff checks passed
* Live Copilot `/mcp` lists Nanasa
* Live Claude `mcp list` reports Nanasa connected
* Live Pi reports one connected MCP server and the configured Nanasa tools
* Live agent capabilities list all four Nanasa tools
* Three private agent roots contain no expanded run capability
* Live Agent Team has three active readable IDs and three running generation-1 agents
