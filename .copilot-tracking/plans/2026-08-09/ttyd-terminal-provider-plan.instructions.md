<!-- markdownlint-disable-file -->
---
description: Implementation plan for making ttyd the sole Nanasa browser terminal provider
applyTo: "**"
---

# Ttyd Terminal Provider Plan

## User Requests

* Replace Nanasa's custom browser terminal renderer and input protocol with ttyd.
* Keep tmux as the durable owner so agent sessions survive browser and daemon
  disconnects.
* Preserve portal terminal tabs and grid views.
* Re-architect terminal supervision, proxying, lifecycle, and tests around this
  ownership model.

## Architecture Decision

Use one loopback-only ttyd process per active run. Each ttyd process attaches to
a deterministic per-run tmux view session containing one linked owner window.
The original group tmux session and pane remain the durable process owners.

The Fastify daemon owns ttyd children and exposes them through a same-origin,
per-run HTTP and WebSocket proxy. The portal renders ttyd in iframes. Nanasa
continues to own groups, runs, messages, and authorization.

## Context

* Primary research:
  `.copilot-tracking/research/2026-08-09/agent-pool-tmux-portal-research.md`
* Focused research:
  `.copilot-tracking/research/subagents/2026-08-09/ttyd-rearchitecture.md`
* Phase 2 log:
  `.copilot-tracking/plans/logs/2026-08-09/ttyd-terminal-provider-log.md`
* Current terminal implementation uses tmux control mode, `capture-pane`, a
  custom WebSocket, and portal-owned xterm.js.
* A live ttyd 1.7.7 comparison rendered Copilot frames materially better than
  the custom replay path.

## Implementation Checklist

### Phase 1: Packaging and contracts
<!-- parallelizable: false -->

* [x] Pin and install verified ttyd binaries for amd64 and arm64 in the dev
  container.
* [x] Add the maintained Fastify HTTP and WebSocket proxy dependency.
* [x] Replace custom terminal frame contracts with terminal endpoint status
  contracts.

### Phase 2: Tmux and ttyd runtime
<!-- parallelizable: false -->

* [x] Simplify `TmuxRuntime` to durable process, view-session, and reconciliation
  responsibilities.
* [x] Implement per-run ttyd supervision on random loopback ports.
* [x] Implement endpoint registry, readiness, restart backoff, and graceful
  shutdown without killing active tmux panes.
* [x] Add same-origin HTTP and WebSocket proxy routes scoped to active runs.

### Phase 3: Portal migration
<!-- parallelizable: false -->

* [x] Replace portal xterm.js and custom WebSocket clients with ttyd iframes.
* [x] Preserve terminal tabs, responsive grid, loading, unavailable, and stopped
  states.
* [x] Remove custom terminal provider dependencies and source files.

### Phase 4: Migration validation
<!-- parallelizable: false -->

* [x] Add unit and integration tests for view sessions, ttyd supervision,
  proxying, reconnect, and cleanup.
* [x] Verify two concurrent runs remain isolated.
* [x] Verify browser and daemon disconnects do not terminate agent panes.
* [x] Verify desktop and mobile rendering, input, resize, tabs, and grid.
* [x] Update documentation, changes, and review artifacts.

Automated migration validation, real ttyd/tmux smoke checks, and desktop and
mobile browser checks are complete.

## Security Requirements

* Bind ttyd only to `127.0.0.1` on unpublished random ports.
* Disable ttyd URL arguments and shell invocation.
* Set writable mode, same-origin checking, and one browser client per run.
* Disable tmux prefix keys and status in per-run view sessions.
* Resolve proxy targets only from daemon-owned run state.
* Preserve the complete validated ttyd base path and reject unsupported routes.
* Do not expose loopback ports in public API responses.

## Success Criteria

* ttyd is the only browser terminal provider in product code.
* Closing an iframe, browser, or daemon leaves the agent pane running in tmux.
* Reopening the portal reaches the same pane and terminal history.
* Tabs mount one ttyd client; grid mounts one isolated ttyd client per run.
* Two ttyd clients cannot switch one another's group-session current window.
* Portal rendering matches ttyd's native terminal behavior.
* Typecheck, tests, lint, formatting, build, real tmux/ttyd smoke, and browser
  verification pass.
