<!-- markdownlint-disable-file -->
---
title: Terminal-only runtime, MCP, CRUD, and browser details
description: File-level execution notes for the terminal-only Nanasa increment
---

## Context

* Plan: `.copilot-tracking/plans/2026-08-10/terminal-only-mcp-crud-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-08-10/terminal-only-mcp-crud-research.md`
* Instructions: `AGENTS.md`, `.github/copilot-instructions.md`

## Phase 1

Modify shared contracts, config parsing, and store schema compatibility first. Preserve physical compatibility columns where dropping them would require table rebuilds. Canonical API objects stop exposing retired adapter concepts. Focused success criteria are contract/config tests plus a migration fixture with active semantic worker runs.

## Phase 2

Delete model-specific process, protocol, worker, and adapter modules. Narrow terminal delivery and the durable dispatcher. Simplify tmux launch and coordinator recovery. Remove semantic routes and package entry points. Focused success criteria are daemon unit tests and real tmux/ttyd smoke.

## Phase 3

Add update/delete store methods, coordinator stop-before-group-delete, REST routes, portal client methods, and group-tree controls. Removing an agent means removing the group membership and stopping its run. Profiles remain internal and reusable. Focused success criteria are store, server, API, and portal component tests.

## Phase 4

Register Streamable HTTP MCP directly in Fastify. Agent runs receive generation-scoped bearer capabilities through their tmux environment; remote operators use an explicitly configured bearer credential. Tool handlers call the same internal message service as REST, and sender identity comes only from verified claims. Focused success criteria include Host/Origin validation, stale generation rejection, remote operator access, and sender-excluded agent broadcast.

## Phase 5

Update package metadata and build output only after runtime and MCP stabilize. Source the private registry environment before dependency installation. Update templates and docs to show the minimal config and terminal-only semantics.

## Phase 6

Build the package before Playwright. Use temporary repositories, unique tmux servers, free loopback ports, safe echo agents, and deterministic teardown. Do not invoke real model prompts.

## Phase 7

Run the complete gate and inspect shipped output for removed architecture strings/files. Update durable change/review records and leave the development server usable on port 3210.
