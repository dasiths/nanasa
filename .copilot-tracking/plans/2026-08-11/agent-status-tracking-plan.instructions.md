<!-- markdownlint-disable-file -->
---
description: Implementation plan for agent status foundation, reporters, trace coverage, and coordinator progress
applyTo: "**"
---

# Agent Status Tracking Implementation Plan

## User Requests

* Implement the generic agent status foundation.
* Add semantic reporters for Claude Code, GitHub Copilot CLI, Pi, and OpenCode.
* Add version-pinned golden trace coverage.
* Expose coordinator progress through MCP and the portal.

## Overview And Objectives

Add a semantic status projection beside the existing process-level `AgentRun`
lifecycle. Tmux remains process truth. Authenticated harness reporters provide
semantic events. A pure reducer produces current status, evidence, attention,
and progress records. Principal agents consume compact MCP tools, while the
portal shows status and attention without interpreting raw events.

## Context Summary

* Architecture research:
  `.copilot-tracking/research/2026-08-11/agent-status-tracking-research.md`
* Vendor evidence:
  `.copilot-tracking/research/subagents/2026-08-11/agent-status-observability-research.md`
* Backend code map:
  `.copilot-tracking/research/subagents/2026-08-11/status-foundation-code-map.md`
* Reporter code map:
  `.copilot-tracking/research/subagents/2026-08-11/status-reporters-code-map.md`
* Repository instructions: `AGENTS.md`, `.github/copilot-instructions.md`
* Markdown and prompt artifact instructions are loaded from hve-core.

## Implementation Checklist

### Phase 1: Contracts And Reducer

<!-- parallelizable: false -->

* [x] Add strict public status, observation, progress, evidence, wait, summary,
  and detail contracts.
* [x] Add statuses to portal snapshots without breaking existing consumers.
* [x] Implement a pure, correlation-aware status reducer.
* [x] Add contract and reducer tests for working, waiting, settled, failure,
  stale reporter, stuck inference, and process exit precedence.

### Phase 2: Persistence And Process Evidence

<!-- parallelizable: false -->

* [x] Add ordered SQLite schema version 2 migrations for status events,
  materialized current state, and task reports.
* [x] Add generation-fenced, idempotent observation ingestion and progress
  reporting in `NanasaStore`.
* [x] Seed and update status from run creation, operator stop, failure, and tmux
  reconciliation.
* [x] Capture owned-pane exit status and signal before recovery replaces a run.
* [x] Add store and runtime tests, including daemon restart behavior.

### Phase 3: Ingestion, MCP, And Reporters

<!-- parallelizable: false -->

* [x] Add an authenticated, loopback-only status ingestion route with a separate
  rate limit and no caller-selected identity.
* [x] Add MCP tools to list/get statuses and report progress.
* [x] Generate bounded fail-open Claude and Copilot hook reporters.
* [x] Generate long-lived Pi and OpenCode reporters with heartbeats and cleanup.
* [x] Degrade reporter incompatibility to process-only status without blocking
  native TUI launch.

### Phase 4: Golden Traces And Portal

<!-- parallelizable: true -->

* [x] Add normalized vendor trace fixtures pinned to supported versions.
* [x] Test each reporter normalizer for ready, activity, waits where supported,
  settlement, retries/failures, and clean end.
* [x] Render semantic status, evidence age, progress, and attention in the group
  tree and selected-group summary.
* [x] Add portal component and API tests for status transitions and attention.

### Phase 5: Validation And Review

<!-- parallelizable: false -->

* [x] Run focused tests after each implementation phase.
* [x] Run typecheck, lint, format check, build, and relevant acceptance tests.
* [x] Review every user request against the final behavior and record remaining
  vendor-version risks.

## Dependencies

* Existing generation-scoped MCP bearer capability
* Existing tmux owner-pane reconciliation and domain-event stream
* Existing per-membership runtime provisioning
* Existing portal snapshot refresh over WebSocket domain events
* External supported agent CLIs, which are optional at runtime

No new package-manager dependency is required for the initial reporters.

## Success Criteria

* Every active membership has an honest status summary, including not started
  and process-only fallback cases.
* Explicit waits never become suspected stuck through silence.
* Unexpected process exit is visible before recovery creates a replacement.
* Old-generation reporters cannot update current status.
* Principal agents can list statuses, inspect details, and report checkpoints.
* The portal shows semantic state and attention without replacing run controls.
* Reporter failure never prevents the native TUI from launching or using tools.
* Golden fixtures document the supported event mapping for all four harnesses.
