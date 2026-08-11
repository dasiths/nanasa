<!-- markdownlint-disable-file -->
---
title: Roles and unread implementation details
description: Phase details and validation criteria for roles, prompts, and read cursors
ms.date: 2026-08-11
ms.topic: reference
---

## Context

* Plan: `.copilot-tracking/plans/2026-08-11/roles-and-unread-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-08-11/roles-and-unread-research.md`

## Phase Details

### Contracts and Resolution

Add `RoleDefinition`, `InstructionReference`, profile defaults, and membership overrides. Implement a pure resolver returning role metadata, ordered sources, normalized text, and SHA-256 revision. Fail configuration loading with precise paths for invalid references.

Success requires deterministic resolver tests and unchanged parsing of the current `.nanasa/config.yaml`.

### Provider Rendering

Write `effective-prompt.md` and `manifest.json` beneath the membership integration directory with private modes. Copilot uses a generated custom agent selected with `--agent`; Claude uses `--append-system-prompt-file`; Pi uses `--append-system-prompt`; OpenCode uses a generated primary agent selected with `--agent`.

Success requires repeated provisioning to preserve provider-owned keys and inject exactly one Nanasa role artifact.

### Projection and Portal

Project role IDs and instruction references through profiles and memberships. Derive role names from validated configuration. Display roles in member details and add role assignment to membership creation and updates. Active role changes return a conflict until a controlled restart operation exists.

Success requires role discovery through REST snapshots, MCP member/status tools, and portal controls.

### Read Cursors

Use one hook for rail and launcher counts. Persist repository/group cursor records with group creation identity. The hook exposes unread calculation and monotonic `markReadThrough`. The workspace receives the authoritative count and callback instead of maintaining local cursors.

Success requires refresh, cross-tab, group switching, retention, and clear-history tests.

### Validation

Run focused tests after each edit slice, then contract, daemon, portal, package, lint, format, and build checks. Record unrelated failures without modifying unrelated code.