<!-- markdownlint-disable-file -->
---
title: Agent Status Tracking Implementation Details
description: Phase-by-phase file operations and validation for agent status tracking
---

## Context References

* Plan: `.copilot-tracking/plans/2026-08-11/agent-status-tracking-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-08-11/agent-status-tracking-research.md`
* Backend map: `.copilot-tracking/research/subagents/2026-08-11/status-foundation-code-map.md`
* Reporter map: `.copilot-tracking/research/subagents/2026-08-11/status-reporters-code-map.md`

## Phase 1 Details

Modify `packages/contracts/src/index.ts` and contract tests. Add
`apps/daemon/src/agent-status-reducer.ts` and focused reducer tests. Keep the
reducer pure and persistable. Use matching operation/request IDs, not latest
event order, to close concurrent tools and waits.

Success requires focused contract and reducer tests plus contracts build.

## Phase 2 Details

Refactor store migrations into ordered version steps. Add JSON-backed status
current state, bounded normalized observations, and task reports. Integrate
lifecycle observations into existing run transactions. Extend tmux pane
inspection with ownership, dead status, signal, and PID; unavailable tmux
inspection must not look like process death.

Success requires migration, deduplication, generation-fence, lifecycle,
restart, and process-exit tests.

## Phase 3 Details

Add a dedicated route module. Reuse bearer authentication, but accept agents
only and apply an independent rate limit. Add MCP reads and cooperative progress
reporting. Extend `AgentRuntimeProvisioner` to generate local reporter files and
configuration. Command reporters always exit successfully and use bounded
requests. Long-lived reporters queue without awaiting network delivery.

Success requires route, MCP, provisioning, and reporter normalization tests.

## Phase 4 Details

Store sanitized vendor inputs under daemon test fixtures with explicit version
metadata. Fixtures contain no credentials, prompts, commands, paths, model
reasoning, or tool results. Add status display to `GroupTree` and the selected
group's operational counts. Preserve current start, stop, and recovery actions.

Success requires fixture tests, portal tests, and responsive acceptance checks.

## Phase 5 Details

Run the repository validation suite with `.devcontainer/.env` loaded before
every pnpm invocation. Record unrelated failures without changing unrelated
code. Review status semantics, privacy, generation fencing, and process-only
degradation before completion.
