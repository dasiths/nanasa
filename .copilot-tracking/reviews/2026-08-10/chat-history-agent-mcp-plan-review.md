<!-- markdownlint-disable-file -->
---
title: Chat history and persistent agent MCP review
description: Final fulfillment and validation review for shared chat history and agent MCP provisioning
ms.date: 2026-08-10
ms.topic: reference
---

## Review metadata

* Plan: `.copilot-tracking/plans/2026-08-10/chat-history-agent-mcp-plan.instructions.md`
* Review status: Complete
* Specialized validator status: Blocked because its session had no workspace tools; direct review completed in the orchestrator

## User request fulfillment

* Shared conventional chat history: complete
* Latest message at the bottom: complete
* Human label and actor initials: complete
* Agent aliases and initials: complete
* Agent-to-agent MCP messages in history: complete
* Expandable recipients and live delivery status: complete
* Nanasa tools visible in supported agent CLIs: complete
* Persistent agent-specific configuration under `.nanasa/agents/`: complete
* Pi MCP Adapter integration: complete
* Readable member IDs and MCP member discovery: complete
* Trusted sender attribution and self-excluded broadcast: complete
* Portal terminal member IDs: complete
* PageUp, PageDown, wheel, and scrollback routing: complete
* Vertical history pane and responsive stacking: complete
* Destructive reset of existing state: complete
* Group-row and terminal-tab copy controls: complete
* Live retrying, rejected, revoked, and dead-letter events: complete
* Portal-created three-agent group: complete
* Floating persistent Messages launcher and responsive overlay: complete
* Modal composer and intent descriptions: complete
* Sender IDs, avatar tooltips, retry wording, and revision removal: complete
* Three-column responsive grid cap and modal alignment: complete

## Placement and quality

* The daemon owns MCP client provisioning because it owns run identity and launch environment.
* Stable membership database IDs prevent group collisions and path traversal.
* Generated files contain token placeholders only; generation capabilities remain in process environments.
* The portal renders daemon messages as authoritative history and uses browser state only for pending cache and local clear markers.
* Terminal-writer suspension now follows active delivery state, so portal and agent-originated sends share one safe handoff.

## Validation evidence

* 36 contract tests, 95 daemon tests, 45 portal tests, and 6 package tests passed.
* All 5 packaged Playwright scenarios passed.
* Real packaged acceptance listed tools with an agent capability, sent an agent DM, delivered it to the recipient terminal, and rendered `From: Alpha` with consumed status.
* Typecheck, lint, formatting, diagnostics, builds, and diff checks passed.
* Desktop and mobile live screenshots showed no overflow, visible terminals, and correct message collapse behavior.
* Live Copilot, Claude, and Pi diagnostics found Nanasa MCP.
* Playwright created Agent Team with the requested profiles, copied a live member ID, and started all three agents.

## Residual risk

* OpenCode config generation is covered by focused tests and authoritative schema references, but no OpenCode member is active in the live group used for manual diagnostics.
* Client upgrades can change configuration formats; pinned package and focused config tests make such drift visible.

## Overall status

Complete
