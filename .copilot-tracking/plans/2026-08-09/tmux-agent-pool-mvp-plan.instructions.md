<!-- markdownlint-disable-file -->
---
description: Implementation plan for the first tmux-backed Nanasa agent pool and portal vertical slice
applyTo: "**"
---

# Tmux Agent Pool MVP Plan

## User Requests

* Build the researched tmux-backed pool of GitHub Copilot, Pi, OpenCode, and
  Claude Code processes.
* Provide a web portal with a left tree of operator-created groups and agents.
* Show selected group agents in tabbed or split terminal views.
* Preserve direct browser terminal input through tmux.
* Model structured DMs, multicasts, and broadcasts independently from terminal
  input.
* Support delivery policies including inbox, queue, steer, interrupt, and
  terminal fallback.

## Overview and Objectives

Build a local-first vertical slice that proves the architecture before native
adapter breadth. The MVP owns group and run state, starts agent TUIs in a private
tmux server, streams pane output to a browser, accepts terminal input, and stores
structured messages with explicit delivery policy and per-recipient state.

Native agent adapters are represented by stable interfaces in this phase. Full
SDK, RPC, ACP, and stream-JSON implementations follow after the terminal and
domain boundaries are executable.

## Context Summary

* Research: `.copilot-tracking/research/2026-08-09/agent-pool-tmux-portal-research.md`
* Markdown rules: `hve-core/markdown.instructions.md`
* Writing style: `hve-core/writing-style.instructions.md`
* Prompt artifact rules: `hve-core/prompt-builder.instructions.md`
* Existing development container provides Node 22, pnpm, Docker, and tmux 3.3a.
* Existing uncommitted development-container changes must be preserved.

## Implementation Checklist

### Phase 1: Workspace and contracts
<!-- parallelizable: false -->

* [x] Create a pnpm TypeScript workspace with portal, daemon, and shared packages.
* [x] Define group, agent profile, run, message, audience, delivery policy, and
  terminal protocol schemas.
* [x] Configure type checking, linting, formatting, build, and test scripts.

### Phase 2: Daemon domain and persistence
<!-- parallelizable: true -->

* [x] Implement SQLite-backed groups, memberships, runs, messages, deliveries,
  and append-only domain events.
* [x] Implement REST APIs for snapshots and operator commands.
* [x] Implement control-event WebSocket replay from sequence numbers.

### Phase 3: Tmux runtime and terminal gateway
<!-- parallelizable: true -->

* [x] Implement private tmux server lifecycle and stable pane bindings.
* [x] Implement control-mode parsing, pane output fan-out, snapshots, and
  lifecycle reconciliation.
* [x] Implement terminal WebSocket input, resize, writer lease, and safe paste.
* [x] Add command profiles for Copilot, Pi, OpenCode, and Claude Code.

### Phase 4: Portal application
<!-- parallelizable: true -->

* [x] Build group and agent tree with creation and lifecycle controls.
* [x] Build terminal tabs and responsive grid with xterm.js.
* [x] Build message composer for DM, multicast, and broadcast audiences.
* [x] Expose intent, delivery mode, fallback, and recipient outcomes.

### Phase 5: Integration and validation
<!-- parallelizable: false -->

* [x] Add domain, persistence, tmux parser, and API tests.
* [x] Run type checking, linting, tests, and production builds.
* [x] Start the production server and verify desktop and mobile portal views.
* [x] Record limitations and native-adapter follow-up work.

## Dependencies

* pnpm workspace
* TypeScript
* Fastify and WebSocket support
* React and Vite
* xterm.js and FitAddon
* Zod for shared runtime validation
* SQLite through the Node 22 standard library when supported by validation
* Vitest
* Existing tmux binary and control-mode protocol

## Success Criteria

* An operator can create a group and add a configured agent profile.
* Starting an agent creates a persistent tmux-backed run with stable identifiers.
* The portal displays live terminal output and reconnects from a pane snapshot.
* A browser writer can type, paste, and resize the selected terminal.
* The portal distinguishes Terminal Mode from structured Message Mode.
* Structured messages preserve audience, intent, requested delivery, fallback,
  and per-recipient applied state.
* Automated checks pass and the portal is reachable from the development
  container.