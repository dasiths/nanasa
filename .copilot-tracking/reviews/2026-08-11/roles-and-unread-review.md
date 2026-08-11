<!-- markdownlint-disable-file -->
---
title: Roles, system prompt suffix, and unread review
description: Fulfillment and validation review for role settings and durable unread counts
ms.date: 2026-08-11
ms.topic: reference
---

## Metadata

* Plan: `.copilot-tracking/plans/2026-08-11/roles-and-unread-plan.instructions.md`
* Review date: 2026-08-11
* Overall status: Complete

## Request fulfillment

* Complete: Reusable project manager, implementor, and reviewer roles are YAML-owned.
* Complete: Built-in and repository-global Nanasa MCP etiquette is appended to every managed agent.
* Complete: Incoming Human and agent messages have distinct trust and response rules.
* Complete: Group, role, profile, and membership instructions are Markdown-only and compose in deterministic order.
* Complete: Portal group and agent workflows expose group Markdown, profile default roles, profile Markdown, membership role overrides, and assignment Markdown.
* Complete: Read badges survive refresh and exclude messages already read in that browser.

## Quality findings

* Provider defaults, repository instructions, auth, sessions, and unrelated settings remain active.
* Prompt files are regular current-user-owned UTF-8 Markdown files beneath the repository.
* Active prompt-affecting edits fail closed instead of mutating live agents.
* Membership and reusable profile saves are separate, avoiding false cross-file atomicity.
* Read cursors merge monotonically across tabs and clamp to retained message bounds.

## Validation

* `pnpm typecheck`: passed.
* `pnpm lint`: passed.
* `pnpm format:check`: passed.
* `pnpm build`: passed.
* Focused contract, daemon, portal, API, and provider tests: passed.
* Complete `pnpm test`: passed with 44 contract, 139 daemon, 57 portal, and 9 packed-install tests.

## Residual considerations

Read state is browser-local because the portal has no authenticated reader
identity. Prompt changes require a stopped agent; automatic generation-fenced
restart and desired-versus-applied prompt reporting remain suitable follow-up
work.