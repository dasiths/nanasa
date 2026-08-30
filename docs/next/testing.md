---
title: Testing and quality gates
description: Static, runtime, browser, migration, security, performance, and release validation
ms.date: 2026-08-30
ms.topic: reference
---

## Local gates

The release gate includes formatting, linting, type checking, unit tests, smoke tests, package build and installation, Chromium acceptance, architecture scans, package security scans, performance budgets, provenance, SBOM validation, documentation drift, migration and rollback fault injection, process-watchdog checks, immutable fixture drift, fixed-seed property models, bounded fuzzing, and a coverage ratchet.

Load `.devcontainer/.env` before every package-manager operation. Its registry values are authoritative and must not be printed or replaced.

## External matrix

GitHub Actions represents Node.js 22 and 24, Linux x64 and arm64, Chromium, Firefox, and WebKit jobs. A local container cannot prove native arm64, every supported distribution, a persistent systemd user manager, or external provider accounts. Release claims remain bounded until those jobs run on their declared runners.
