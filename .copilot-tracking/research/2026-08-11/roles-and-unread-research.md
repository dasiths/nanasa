<!-- markdownlint-disable-file -->
---
title: Roles and unread persistence research
description: Selected architecture for reusable roles, layered instructions, and durable portal read cursors
ms.date: 2026-08-11
ms.topic: reference
---

## Scope

Implement reusable provider-neutral roles, layered Nanasa instructions, native provider prompt injection, role discovery and display, trusted message threading metadata, and durable browser-local unread counts.

## Selected Architecture

Nanasa configuration remains the source of truth. Add optional top-level instructions, group instructions, reusable roles, profile defaults and instructions, and membership role overrides and instructions. Existing configuration remains valid.

Effective role resolution is membership role, then profile default role, then no role. System-prompt suffix order is built-in Nanasa coordination and incoming-message etiquette, top-level Markdown instructions, group Markdown instructions, role Markdown instructions, profile Markdown instructions, and membership Markdown instructions. The exact normalized UTF-8 bytes are hashed and written to a private generated suffix for each launch.

Provider adapters append the generated Nanasa prompt while preserving provider defaults, repository instructions, user preferences, authentication, sessions, and managed policy. Role permission policies may narrow provider permissions but never elevate them.

Unread state belongs to the browser until the portal has authenticated operator identities. Persist a versioned cursor per repository and group in local storage. Count only retained messages after the cursor:

$$
\operatorname{unread}=\min\left(\operatorname{retainedCount},\max\left(0,\operatorname{latestSeq}-\max\left(\operatorname{cursor},\operatorname{oldestSeq}-1\right)\right)\right)
$$

The cursor advances only while the message overlay is open. Group selection alone does not mark messages read.

## Evidence

* `AgentRuntimeProvisioner.provision` owns provider configuration immediately before tmux launch
* `App` and `MessageWorkspace` currently maintain separate in-memory read cursors
* `GroupMessageState` already contains latest sequence, oldest retained sequence, and retained count
* MCP server initialization supports server instructions
* Copilot and OpenCode support named custom agents; Claude and Pi support append-system-prompt files or file paths
* Portal REST has no authenticated reader identity, so server-side read cursors would conflate browsers

## Constraints

* Instruction files must be regular UTF-8 Markdown files beneath the real repository root
* Reject NULs, path traversal, symlink escapes, duplicates, files over 64 KiB, and composites over 256 KiB
* Never persist prompt contents or credentials in SQLite
* Never mutate a live run prompt
* Preserve provider-owned configuration and repository instruction discovery
* Terminal message envelopes need trusted message, conversation, and reply identifiers before threaded replies can be required

## Validation Targets

* Resolver ordering, validation, normalization, and stable hashes
* Provider command and generated configuration preservation
* Role projection and MCP/status discovery
* Trusted terminal envelope metadata
* Unread persistence across refresh, cross-tab synchronization, retention, and clear-history gaps
* Existing contract, daemon, portal, package, lint, format, and build checks