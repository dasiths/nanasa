<!-- markdownlint-disable-file -->
---
title: Declarative topology and bounded messaging research
description: Alpha design for YAML topology ownership, SQLite runtime state, message limits, retention, and pagination
ms.date: 2026-08-11
ms.topic: concept
---

## User requirements

* Move profiles, groups, memberships, and aliases into `.nanasa/config.yaml`.
* Keep ephemeral and transactional runtime state in SQLite.
* Reject oversized REST and MCP messages with actionable file-path guidance.
* Retain a bounded number of messages and delete authoritative history from the
  portal.
* Initially display the latest 20 messages, lazy-load older pages, and default
  the history viewport to the newest message.
* Apply alpha-grade migration, validation, and recovery behavior.

## Ownership model

YAML owns desired topology:

* Agent types and integration-home policies
* Reusable agent profiles
* Groups, memberships, routing member IDs, and aliases
* Message retention policy

SQLite owns transactional and historical state:

* Materialized topology projection and tombstones needed by foreign keys
* Run generations, desired state, terminal bindings, and recovery
* Messages, delivery leases, retries, and sequence high-water marks
* Semantic status reducer state and bounded evidence
* Domain event ordering and idempotency results

## Topology consistency

Config writes are serialized and atomic. The daemon writes a same-directory
temporary file, synchronizes it, renames it, and then reconciles SQLite. If the
process stops between those steps, startup treats YAML as authoritative and
repairs the SQLite projection. Runtime-destructive API operations stop affected
runs before removing YAML entries.

Existing alpha data is imported into YAML only when the topology sections are
absent. Stable IDs are preserved. Explicit empty topology sections remain empty
and are never re-imported.

## Message limits

* Message text: at most 1,048,576 UTF-8 bytes
* Message/MCP request envelope: at most 6,356,992 bytes
* Default page size: 20; maximum page size: 100
* Default retention: 1,000 messages per group

Oversized errors recommend a repository-relative file path only after content
has been placed in the checkout shared by recipients. They do not recommend
absolute paths or client-local `/tmp` paths, and Nanasa does not automatically
open a path supplied in a message.

## Pagination and deletion

Message pages use exclusive positive `before` and `after` group-sequence
cursors. Results are always ascending for rendering. Deleting history removes
messages and deliveries in SQLite, preserves the group sequence high-water
mark, and clears message bodies from idempotency payloads and future domain
events.

The portal owns no message-body cache in local storage. It loads the latest 20,
scrolls to the bottom after initial layout, requests older pages near the top,
and compensates scroll height after prepend. Live messages append without
moving a reader who has scrolled upward.

## Research sources

* Subagent topology research returned in the current session
* `.copilot-tracking/research/subagents/2026-08-11/message-limits-retention-history-pagination.md`
* GitHub Copilot and MCP configuration research from the current session
* Current contracts, daemon store/routes, portal API/hooks, and message workspace
