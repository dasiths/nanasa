<!-- markdownlint-disable-file -->
---
title: Declarative topology and messaging implementation details
description: File-level implementation sequence and validation boundaries
ms.date: 2026-08-11
ms.topic: reference
---

## Context

* Plan: `.copilot-tracking/plans/2026-08-11/declarative-topology-messaging-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-08-11/declarative-topology-messaging-research.md`

## Implementation boundaries

Contracts change first, followed by a focused build and config test. Config
repository and projection changes are validated before message storage changes.
Message backend APIs are complete before the portal stops consuming snapshot
message arrays.

Config reconciliation may retain historical SQLite profile and run rows when
foreign keys require them, but snapshots and new operations expose only active
YAML topology. Filesystem writes happen before projection writes so startup can
repair a partial operation from the authoritative file.

Message deletion refuses active delivery leases. Retention runs within message
submission and deletes delivery rows before message rows. Reply links to removed
messages are nulled before deletion.
