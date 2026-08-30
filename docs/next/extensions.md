---
title: Provider extensions
description: Data-only provider package trust, planning, health, rollback, and removal
ms.date: 2026-08-30
ms.topic: concept
---

## Extension boundary

Provider extensions contain strict data and reviewed assets. They select closed Nanasa-owned strategies. They cannot execute JavaScript, shell callbacks, builds, startup hooks, event hooks, or portal code.

## Lifecycle

Install verifies paths, links, devices, archive budgets, digests, signatures, compatibility, requested permissions, and repository trust. Planning produces a deterministic digest. Commit updates owned generated overlays and the extension lock.

Health states distinguish current, outdated, drifted, incompatible, untrusted, unavailable, and not installed. Repair and remove touch only ledger-owned state. Active runs retain immutable adapter snapshots.
