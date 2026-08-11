<!-- markdownlint-disable-file -->
---
title: Agent Status Tracking Research Review
description: Fulfillment and quality review of the agent status architecture recommendation
---

## Review Metadata

* Research: `.copilot-tracking/research/2026-08-11/agent-status-tracking-research.md`
* Vendor evidence: `.copilot-tracking/research/subagents/2026-08-11/agent-status-observability-research.md`
* Reviewer: RPI Agent
* Date: 2026-08-11

## Request Fulfillment

| User request | Status | Evidence |
|---|---|---|
| Explore status tracking for managed TUI agents | Complete | The research compares injected reporters, structured protocols, session logs, tmux heuristics, and cooperative MCP reports |
| Distinguish not started, working, waiting, stuck, and crashed | Complete | The proposed model defines each state, adds idle and stopped, and treats stuck as confidence-qualified inference |
| Evaluate heartbeat and state-change detection | Complete | The lease section separates process, reporter, and progress clocks and evaluates 60-second terminal-output comparison |
| Investigate agent logs, events, hooks, and tool activity | Complete | The harness matrix and vendor sections identify exact Claude, Copilot, Pi, and OpenCode lifecycle surfaces |
| Support a principal agent coordinating group members | Complete | The principal-agent section proposes compact MCP reads, attention events, task reports, and reply-channel metadata |
| Suggest options and alternatives | Complete | Five options are compared, with a selected TUI-preserving approach and an optional structured-control path |

## Quality Findings

No critical, high, or medium-severity defects were found.

The selected approach fits Nanasa's current architecture. It adds a semantic
status plane without making ACP, RPC, SDK, or server workers mandatory after the
repository deliberately removed model-specific runtime adapters. Existing tmux
reconciliation remains process truth, and current per-membership provisioning is
the correct injection boundary.

The status semantics avoid the main category errors:

* Process `running` is not described as model work.
* Settled or idle is not described as successful task completion.
* A known outstanding interaction remains waiting rather than becoming stuck
  through elapsed time.
* A hard crash remains a supervisor observation because in-process hooks cannot
  report their own abrupt death.
* Cooperative model reports are used for semantic progress, not liveness.

The principal-agent API is appropriately reduced. It exposes current state,
attention need, evidence age, progress summary, next step, and reply channel
instead of requiring the coordinator to interpret raw tool events.

Security and privacy are addressed through generation-fenced run identity,
loopback ingestion, strict small payloads, independent rate limiting, and a
default prohibition on prompt text, tool arguments, transcripts, results, and
reasoning content.

## Remaining Validation Gaps

The following are implementation validation tasks rather than research defects:

* Capture version-pinned event traces for all four harnesses.
* Verify Copilot CLI question-wait behavior and isolated per-member hook
  discovery.
* Reconcile OpenCode question reply endpoints with the pinned OpenAPI schema.
* Measure event latency before setting production lease defaults.
* Confirm tmux exit-status fields and behavior across the supported tmux
  versions.

## Validation

* Consolidated and subagent research frontmatter parsed successfully with the
  repository's installed YAML parser.
* Both research files contain the required tracking header, title,
  description, final newline, and ASCII punctuation.
* `git diff --check` reported no whitespace errors for the research artifacts.
* Biome intentionally ignores `.copilot-tracking`, so it processed no files and
  was not counted as a successful formatting validation.

## Overall Status

Complete. The research fulfills the requested exploration and provides a
defensible implementation direction. Product implementation should begin with
generic contracts, process evidence, ingestion, and MCP reads before adding
harness-specific reporters.
