---
title: Testing and quality gates
description: Static, runtime, browser, migration, security, performance, and release validation
ms.date: 2026-08-30
ms.topic: reference
---

## Local gates

The release gate includes formatting, linting, type checking, unit tests, smoke tests, package build and installation, Chromium acceptance, architecture scans, package security scans, measured performance budgets, provenance, SBOM validation, documentation drift, migration and rollback fault injection, process-watchdog checks, immutable fixture drift, fixed-seed property models, bounded fuzzing, and a coverage ratchet. Fixed-seed performance checks cover a real 100-terminal tmux fleet, event storms, default-batch delivery, real action scheduling, and slow-consumer closure. Warmed repeated samples assert median throughput, p95 elapsed time and event-loop delay, and peak heap and RSS deltas, then write machine-readable results only to ignored test output.

Load `.devcontainer/.env` before every package-manager operation. Its registry values are authoritative and must not be printed or replaced.

## External matrix

GitHub Actions represents Node.js 22 and 24, Linux x64 and arm64, Chromium, Firefox, and WebKit jobs. Manual certification entry points cover the four closed built-in provider profiles, WebKit, native arm64, Node.js 24, Ubuntu, persistent systemd, and live SSH. Each entry point verifies the exact candidate and fails when its declared environment or allowlisted credential is unavailable. Provider and SSH output is redacted.

A local container cannot prove native arm64, every supported distribution, a persistent systemd user manager, a live SSH target, or external provider accounts. Release claims remain bounded until those jobs run on their declared runners.
