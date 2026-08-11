<!-- markdownlint-disable-file -->
---
title: Integration isolation plan review
description: Fulfillment and validation review for repository-local provider homes
ms.date: 2026-08-11
ms.topic: reference
---

## Metadata

* Plan: `.copilot-tracking/plans/2026-08-11/integration-isolation-plan.instructions.md`
* Review date: 2026-08-11
* Overall status: Complete

## Request fulfillment

* Complete: Nanasa-generated provider files no longer target global homes.
* Complete: `agentConfigHome` supports `agent-type`, `member`, and safe custom
  repository-local paths.
* Complete: `setup`, `auth`, and non-destructive `doctor` are packaged commands.
* Complete: No legacy compatibility or cleanup workflow was added.
* Complete: Active configuration and shipped template use isolated shared homes.

## Placement and quality

* Policy contracts live in the contracts package and strict YAML parser.
* Path and provider environment logic is shared by runtime and CLI administration.
* Runtime-generated membership MCP overlays remain capability placeholders only.
* Intermediate path components, ownership, and private permissions are checked.
* Custom paths reject traversal, absolute forms, unknown placeholders, reserved
  namespaces, root aliases, and collisions.

## Validation

* `pnpm typecheck`: passed.
* `pnpm test`: passed with 40 contract, 126 daemon, 47 portal, and 9 package tests.
* `pnpm lint`: passed.
* `pnpm format:check`: passed.
* `git diff --check`: passed.
* Active `nanasa setup` and `nanasa doctor`: passed for five agent types.

## Review notes

An `Implementation Validator` review was attempted, but that environment could
not access workspace files. Direct changed-file review and legacy/global path
searches found no remaining production references or blockers.
