---
title: Release and rollback
description: Immutable prerelease identity, backup, migration, activation, readiness, and channels
ms.date: 2026-08-30
ms.topic: how-to
---

## Identity and channels

Preview versions use semantic prerelease identity and the npm `next` channel. Stable versions use plain semantic versions and `latest`. Published versions are immutable. Package, build metadata, SBOM, documentation, and release evidence must identify the same commit.

## Release transaction

Resolve and verify the candidate before stopping the daemon. Probe schema compatibility, create a WAL-safe verified backup, stage the database, configuration, extension lock, overlays, and package pointer, then migrate the staged database. Stop only the daemon and preserve tmux-owned processes.

Activate state artifacts, commit the package pointer last, start the candidate service, and require bounded readiness. A failed readiness check restores the exact old code and state set. An older package cannot read a newer schema unless compatibility metadata allows it; otherwise restore the verified backup.

## Dry run

The release dry run validates package allowlists, support metadata, size budgets, provenance, SPDX relationships, documentation, migrations, rollback, fixtures, fuzzing, and orphan cleanup without publishing.
