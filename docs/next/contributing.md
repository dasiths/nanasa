---
title: Contributing
description: Architecture, validation, documentation, and safety requirements for changes
ms.date: 2026-08-30
ms.topic: how-to
---

## Change boundaries

Preserve one daemon authority, SQLite durable facts, tmux process and PTY ownership, portal-owned presentation, provider-neutral services, and data-only extensions. Do not add compatibility readers, duplicate control planes, arbitrary plugin execution, or terminal injection as semantic acknowledgement.

## Validation

Run the checks documented in [Testing](testing.md). Update generated references with the documentation generator and commit deliberate fixture changes with their new digest manifest. Keep fault injection deterministic and process cleanup exact.

Before package operations, load the repository package-registry environment. Never commit or print its contents. Review package artifacts for source maps, tests, credentials, databases, terminal data, provider state, and private registry information.
