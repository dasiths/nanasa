<!-- markdownlint-disable-file -->
---
description: Implementation plan for terminal-only runtime, stdio MCP, CRUD, and browser acceptance
applyTo: "**"
---

# Terminal-Only Runtime, MCP, CRUD, and Browser Plan

## User Requests

* Remove model-specific SDK, ACP, RPC, and adapter behavior.
* Run every coding agent as a directly observable and interactive terminal process.
* Route all portal and agent messages through tmux paste plus a separate Enter key.
* Add a Nanasa Streamable HTTP MCP server with DM, multicast, and sender-excluded broadcast tools.
* Route MCP tools through the authoritative daemon and support authenticated remote access.
* Add portal support to rename groups and agents.
* Add portal support to remove agents and groups.
* Add Playwright acceptance for Start All, terminal messaging, preferences, responsive layout, and daemon restart recovery.
* Preserve existing repository-local state instead of resetting it.

## Context Summary

Research is consolidated in `.copilot-tracking/research/2026-08-10/terminal-only-mcp-crud-research.md`. Repository instructions are `AGENTS.md` and `.github/copilot-instructions.md`. Package operations must source `.devcontainer/.env` and preserve its registry configuration.

## Implementation Checklist

### Phase 1: Terminal-only contracts and state
<!-- parallelizable: false -->

* [x] Reduce canonical config to command, kind, cwd, and environment while accepting retired keys as legacy input.
* [x] Reduce message delivery to implicit terminal injection and remove semantic adapter/status contracts.
* [x] Add group rename/delete and membership rename command/result contracts.
* [x] Add an in-place SQLite migration that preserves current records and marks active worker panes for replacement.
* [x] Add focused contract, config, and migration tests.

### Phase 2: Terminal-only daemon runtime
<!-- parallelizable: false -->

* [x] Remove Copilot ACP, Pi RPC, worker clients, worker protocols, and adapter abstractions.
* [x] Launch every configured agent command directly in tmux.
* [x] Narrow the dispatcher to durable terminal injection, retries, expiry, and dead letters.
* [x] Simplify lifecycle, interrupt, recovery, and API composition around tmux and ttyd.
* [x] Remove worker package entry points and obsolete tests.
* [x] Validate the focused daemon slice.

### Phase 3: Group and agent operations
<!-- parallelizable: false -->

* [x] Implement group and membership rename in the store and REST API.
* [x] Implement coordinator-owned group deletion with stop-before-delete semantics.
* [x] Expose membership removal through the portal client.
* [x] Add inline rename and confirmed destructive actions to the group tree.
* [x] Preserve responsive and keyboard-accessible behavior.
* [x] Validate contracts, routes, store behavior, and portal interactions.

### Phase 4: Authenticated HTTP MCP
<!-- parallelizable: false -->

* [x] Register a Streamable HTTP `/mcp` endpoint in the authoritative Fastify daemon.
* [x] Add generation-scoped bearer capabilities bound to each agent run, member, and group.
* [x] Add an explicitly configured bearer principal for remote operator clients.
* [x] Expose DM, multicast, and sender-excluded broadcast tools.
* [x] Bind agent sender identity to verified run claims and reject stopped or stale generations.
* [x] Route every tool through the same durable terminal message command used by the portal.
* [x] Add protocol, Host/Origin, authentication, identity, audience, revocation, and terminal-delivery tests.

### Phase 5: Distribution and documentation
<!-- parallelizable: false -->

* [x] Update package dependencies, CLI help, package bundling, templates, and clean-install tests.
* [x] Remove stale generated ACP/RPC worker output from distributable artifacts.
* [x] Update README and portal documentation for terminal-only semantics and MCP setup.
* [x] Validate package contents and startup.

### Phase 6: Automated browser acceptance
<!-- parallelizable: false -->

* [x] Add Playwright configuration and an isolated package-owned fixture.
* [x] Cover Start All, terminal DM/multicast/broadcast, preferences, and responsive layout.
* [x] Cover group/member rename and delete confirmation workflows.
* [x] Cover graceful daemon restart with surviving tmux panes.
* [x] Ensure deterministic cleanup and useful failure artifacts.

### Phase 7: Final review
<!-- parallelizable: false -->

* [x] Run typecheck, unit/integration tests, lint, formatting, build, package build, smoke, acceptance, and diff checks.
* [x] Verify no SDK, ACP, RPC, adapter, queue, or steer implementation remains in shipped output.
* [x] Browser-test the packaged portal and terminal fixtures without real model prompts.
* [x] Update change and review artifacts.

## Success Criteria

* Every agent starts as its configured command in a tmux pane.
* ttyd is the only browser terminal renderer and direct keyboard channel.
* Every routed message is durable terminal paste plus Enter with no semantic completion claim.
* Existing ACP/RPC worker generations are replaced exactly once without losing group/member/profile records.
* `/mcp` provides authenticated Streamable HTTP DM, multicast, and sender-excluded broadcast tools through the authoritative daemon.
* Groups and members can be renamed and removed from the portal; group removal stops runs before deleting data.
* Playwright acceptance passes for the specified desktop, mobile, messaging, preference, CRUD, and restart workflows.
* Published package output contains no Copilot ACP or Pi RPC workers.
