<!-- markdownlint-disable-file -->
---
title: Chat history and persistent agent MCP implementation details
description: File-level execution notes for the chat timeline and agent MCP provisioning increment
---

## Context

* Plan: `.copilot-tracking/plans/2026-08-10/chat-history-agent-mcp-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-08-10/chat-history-agent-mcp-research.md`
* Subagent research: `.copilot-tracking/research/subagents/2026-08-10/agent-mcp-persistence-research.md`
* Instructions: `AGENTS.md`, `.github/copilot-instructions.md`

## Phase 1

Add a typed runtime provisioner owned by the daemon. Use stable membership database IDs for directories, atomic JSON writes, strict permissions, and no token persistence. Add CLI-specific arguments and environment variables immediately before tmux launch. Keep existing authentication homes for Copilot, Claude, and OpenCode. Isolate Pi state because its MCP adapter and sessions share `PI_CODING_AGENT_DIR`.

## Phase 2

Use focused tests with temporary directories and fake profiles. Assert exact generated schemas, placeholder syntax, file modes, symlink rejection, and stable reuse across generations. Add the official Pi adapter through the repository package manager environment and verify its resolved extension entry is included in package output.

## Phase 3

Replace submission-only history rendering with an authoritative timeline. Messages come from the daemon snapshot; local history fills only the short interval before snapshot reconciliation. Resolve operator senders to Human and agent senders to current or recorded member aliases. Sort by group sequence ascending and render delivery summaries with independent disclosure state.

## Phase 4

Extend portal tests and packaged Playwright acceptance. Run a real MCP tools/list probe for supported clients where it can be deterministic and non-interactive. Rebuild and restart the development daemon only after all focused tests pass, preserving tmux sessions when possible.
