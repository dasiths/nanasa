<!-- markdownlint-disable-file -->
---
description: Implementation plan for shared chat history and persistent agent MCP configuration
applyTo: "**"
---

## User Requests

* Show the message area as a conventional group chat with the latest message at the bottom.
* Display Human for portal senders and aliases with initial icons for agents.
* Include agent-to-agent MCP messages in the same history.
* Collapse recipient and delivery details behind an expandable summary button.
* Fix terminal agents that cannot see Nanasa MCP tools.
* Persist agent-specific configuration under `.nanasa/agents/` across restarts.
* Generate readable member IDs as `<agent-type>.<docker-name>`.
* Let agents discover active member IDs through MCP.
* Attribute delivered terminal messages to their authenticated sender.
* Exclude agents from their own broadcasts and reject self-targeted sends.
* Show member IDs in portal terminal labels and titles.
* Route PageUp, PageDown, and wheel input through ttyd and tmux to agent TUIs.
* Display message history as a vertical pane beside the horizontal composer.
* Delete all existing groups, profiles, runs, messages, and agent state.

## Context Summary

Research is recorded in `.copilot-tracking/research/2026-08-10/chat-history-agent-mcp-research.md` and `.copilot-tracking/research/subagents/2026-08-10/agent-mcp-persistence-research.md`. Authoritative CLI references cover Pi MCP Adapter, Claude Code settings and MCP, GitHub Copilot CLI configuration, and OpenCode configuration and MCP servers. Repository package operations must follow `AGENTS.md` and source `.devcontainer/.env`.

## Implementation Checklist

### Phase 1: Persistent agent runtime configuration
<!-- parallelizable: false -->

* [x] Return stable membership identity from run creation.
* [x] Add a hardened provisioner for `.nanasa/agents/<membership-id>/`.
* [x] Generate placeholder-only MCP configuration for every supported CLI.
* [x] Augment launch arguments and environments without replacing existing authentication homes.
* [x] Pin and package Pi MCP Adapter.
* [x] Ignore persistent agent state in Git.

### Phase 2: MCP client validation
<!-- parallelizable: false -->

* [x] Test paths, permissions, generated formats, and command augmentation.
* [x] Verify no bearer token is persisted.
* [x] Exercise supported installed clients against Nanasa MCP where practical.
* [x] Verify run recovery reuses the same membership directory with a fresh token.

### Phase 3: Shared chat timeline
<!-- parallelizable: false -->

* [x] Feed authoritative group messages and outcomes into the message workspace.
* [x] Merge browser-local pending submissions without duplicate message IDs.
* [x] Render chronological messages with Human and agent identities and initials.
* [x] Add per-message expandable recipient and status summaries.
* [x] Keep the latest message at the bottom with respectful auto-scroll behavior.
* [x] Preserve clear-history confirmation and responsive layout.

### Phase 4: Acceptance and documentation
<!-- parallelizable: false -->

* [x] Cover agent-originated chat history and live status updates in tests.
* [x] Cover per-CLI MCP configuration and persistence across restart.
* [x] Run unit, package, formatting, diagnostics, and Playwright gates.
* [x] Update runtime documentation and tracking artifacts.

### Phase 5: Naming, discovery, and terminal interaction
<!-- parallelizable: false -->

* [x] Add collision-safe `docker-names` member IDs using the agent type prefix.
* [x] Add `nanasa.list_members` with alias, ID, agent type, run status, and caller identity.
* [x] Preserve sender-excluded broadcasts and reject agent self-DM or self-multicast.
* [x] Add trusted sender and intent envelopes to terminal delivery.
* [x] Display aliases and member IDs in portal terminal tabs, bars, iframe titles, and labels.
* [x] Enable tmux mouse, xterm scrollback, and browser acceptance for PageUp, PageDown, and wheel.
* [x] Make history a vertical desktop pane beside the composer with responsive stacking.
* [x] Reset repository runtime and domain state, preserving only configuration.

## Success Criteria

* Copilot, Claude Code, Pi, and OpenCode terminal agents can discover Nanasa MCP tools when MCP is enabled.
* Generated configuration survives daemon and run restarts under a stable membership directory.
* No run capability token is written to disk.
* Every persisted group message appears once in chronological chat order.
* Portal senders display as Human and agent senders display their aliases and initials.
* Recipient details expand independently and reflect live authoritative outcomes.
* New messages appear at the bottom without stealing scroll position from a user reading older history.
* New memberships use readable stable IDs and active agents can discover them through MCP.
* Recipients receive trusted sender identity, and agent broadcasts never loop back to the caller.
* Browser PageUp, PageDown, and wheel events reach raw-mode, mouse-aware terminal applications.
* Final live state contains no groups, profiles, memberships, runs, messages, or deliveries.
