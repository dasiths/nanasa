<!-- markdownlint-disable-file -->
---
description: Implementation plan for Nanasa roles, layered instructions, and durable unread cursors
applyTo: "**"
---

## User Requests

* Research and implement reusable agent roles such as project manager, implementor, and reviewer
* Support agent-specific system prompts and global Nanasa MCP coordination instructions
* Preserve message bubble counts across portal refreshes without counting already-read messages

## Objectives

* Keep roles provider-neutral and reusable across profiles and memberships
* Compose one deterministic Nanasa prompt without replacing provider or repository instructions
* Expose effective roles to MCP clients, status views, and the portal
* Preserve per-browser read position across refresh and tabs
* Keep existing version 1 configuration backward compatible

## Context Summary

* Repository instructions: `.github/copilot-instructions.md`, `AGENTS.md`
* Markdown instructions: HVE Core Markdown and writing-style instructions
* Prompt artifacts: HVE Core prompt-builder instructions
* Research: `.copilot-tracking/research/2026-08-11/roles-and-unread-research.md`
* Subagent research: `.copilot-tracking/research/subagents/2026-08-11/roles-prompts-unread-persistence.md`

## Implementation Checklist

### Phase 1: Contracts and Prompt Resolution

<!-- parallelizable: false -->

* [x] Add backward-compatible role and instruction schemas
* [x] Add secure instruction loading and deterministic prompt composition
* [x] Add built-in Nanasa coordination guidance and MCP initialization instructions
* [x] Add focused contract and resolver tests

### Phase 2: Runtime and Provider Rendering

<!-- parallelizable: false -->

* [x] Pass launch context into runtime provisioning
* [x] Generate private system-prompt suffix and manifest artifacts
* [x] Append prompts through Copilot, Claude, Pi, and OpenCode native mechanisms
* [x] Preserve unrelated provider configuration and repository instruction discovery
* [x] Add trusted terminal message threading metadata
* [x] Add provider and terminal delivery tests

### Phase 3: Role Projection and User Interface

<!-- parallelizable: false -->

* [x] Project role metadata through SQLite topology state
* [x] Expose effective role through member and status discovery
* [x] Support profile defaults and membership overrides in portal creation and editing
* [x] Reject active prompt-affecting changes until restart semantics are explicit
* [x] Add daemon and portal tests

### Phase 4: Durable Unread Cursors

<!-- parallelizable: true -->

* [x] Add a versioned browser-local read cursor hook
* [x] Derive rail and launcher counts from one authoritative cursor
* [x] Mark read only while the message overlay is open
* [x] Handle retention, clear history, malformed storage, and cross-tab synchronization
* [x] Add refresh and unread semantics tests

### Phase 5: Validation and Documentation

<!-- parallelizable: false -->

* [x] Update configuration examples and README guidance
* [x] Run focused and full validation
* [x] Review every user request and record results

## Dependencies

* Existing YAML configuration repository and topology service
* Existing provider-isolated integration homes
* MCP server initialization instructions
* Browser `localStorage` and existing portal synchronization pattern

## Success Criteria

* Existing configuration parses without role fields
* A membership can inherit a profile role or override it
* Every managed provider receives the same Nanasa prompt content without losing native defaults or repository guidance
* MCP member and status discovery includes the effective role
* Portal role changes cannot silently mutate active runs
* Read messages remain read after refresh and new messages increment from the saved cursor
* Retention and history clear never recreate phantom unread counts
* All relevant validation passes