<!-- markdownlint-disable-file -->
---
title: Roles, system prompt suffix, and unread changes
description: Implementation record for reusable roles, layered Markdown instructions, portal settings, and read cursors
ms.date: 2026-08-11
ms.topic: reference
---

## Related plan

`.copilot-tracking/plans/2026-08-11/roles-and-unread-plan.instructions.md`

## Summary

Nanasa now resolves reusable roles and layered Markdown instructions into a
private system-prompt suffix for every managed launch. The portal supports role
and instruction settings during agent creation and through separate membership
and reusable-profile edits. Browser-local read cursors preserve unread counts
across refreshes without recounting messages already read.

## Added

* Canonical role, Markdown instruction, profile default, and membership override contracts
* Built-in Nanasa MCP etiquette and Human-versus-agent incoming-message rules
* Secure deterministic system-prompt suffix resolver and private manifest
* Provider-native Copilot, Claude, Pi, and OpenCode suffix rendering
* SQLite schema version 4 membership role projection
* Profile update route and portal agent settings dialog
* Group-specific Markdown instruction layer and group settings dialog
* Repository-global, group-specific, and role-specific Markdown instruction files
* Versioned, retention-aware, cross-tab browser read cursors

## Modified

* MCP initialization publishes Nanasa coordination etiquette
* Member and status discovery expose effective roles
* Terminal envelopes expose trusted message, conversation, reply, sender, and intent metadata
* Group and agent flows accept group, profile, role override, and assignment instructions
* Active prompt-affecting changes return restart-required conflicts
* README and starter configuration document Markdown-only layered suffixes

## Removed

* Plain-text `.nanasa/instructions/*.txt` assets
* Duplicate in-memory unread cursors in the portal

## Release summary

Restart Nanasa to load the new role catalog. Stop an affected agent before
changing role or instruction settings so the next run receives a consistent
system-prompt suffix.