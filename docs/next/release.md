---
title: Release and rollback
description: Immutable prerelease identity, backup, activation, readiness, and channels
ms.date: 2026-09-01
ms.topic: how-to
---

## Identity and channels

Preview versions use semantic prerelease identity and the npm `next` channel. Stable versions use plain semantic versions and `latest`. Published versions are immutable. Package, build metadata, SBOM, documentation, and release evidence must identify the same commit.

## Release transaction

Resolve and verify the candidate before stopping the daemon. The active and
candidate builds must declare the same exact database schema. Create a WAL-safe
verified backup, then stage the database, configuration, extension lock,
overlays, and package pointer without transforming the database. Stop only the
daemon and preserve tmux-owned processes.

Activate state artifacts, commit the package pointer last, start the candidate
service, and require bounded readiness. A failed readiness check restores the
exact old code and state set. Schema changes require a verified backup followed
by `nanasa reset --from-alpha`; release activation does not upgrade databases.

## Dry run

The release dry run validates package allowlists, support metadata, size
budgets, provenance, SPDX relationships, documentation, exact-schema release
state, rollback, fixtures, fuzzing, and orphan cleanup without publishing.
