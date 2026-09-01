---
title: Testing and quality gates
description: Static, runtime, browser, security, performance, and release validation
ms.date: 2026-09-01
ms.topic: reference
---

## Local gates

The release gate includes formatting, linting, type checking, unit tests, smoke
tests, package build and installation, Chromium acceptance, architecture scans,
package security scans, measured performance budgets, provenance, SBOM
validation, documentation drift, exact-schema release and rollback fault
injection, process-watchdog checks, immutable fixture drift, fixed-seed property
models, bounded fuzzing, and a coverage ratchet. Fixed-seed performance checks
cover a real 100-terminal tmux fleet, event storms, default-batch delivery, real
action scheduling, and slow-consumer closure. Warmed repeated samples assert
median throughput, p95 elapsed time and event-loop delay, and peak heap and RSS
deltas, then write machine-readable results only to ignored test output.

Load `.devcontainer/.env` before every package-manager operation. Its registry values are authoritative and must not be printed or replaced.

## External matrix

GitHub Actions represents Node.js 22 and 24, Linux x64 and arm64, Chromium, Firefox, and WebKit jobs. Manual certification entry points cover the four closed built-in provider profiles, WebKit, native arm64, Node.js 24, Ubuntu, persistent systemd, and live SSH. Each entry point verifies the exact candidate and fails when its declared environment or allowlisted credential is unavailable. Provider and SSH output is redacted.

A local container cannot prove native arm64, every supported distribution, a persistent systemd user manager, a live SSH target, or external provider accounts. Release claims remain bounded until those jobs run on their declared runners.

## Local provider certification

Local provider certification can exercise a dirty working tree without creating
a release candidate. For the default membership scope, authenticate and certify
the same stable configured agent ID:

```bash
node bin/nanasa.js auth login <integration-id> --agent <agent-id>
pnpm certify:provider:local <provider-id> <integration-id> --agent <agent-id>
```

For `providerState.scope: integration`, omit `--agent` from both commands.
Local certification defaults to the smoke profile: real provider launch,
reporter readiness, process identity, and native-session reporting. Add
`--full` to include model-driven native wait acknowledgement and pane-loss
resume recovery. Formal CI and release certification always runs the full
profile.

The local command uses `NANASA_CERT_CANDIDATE_SHA=ignore` together with the
required `NANASA_CERT_LOCAL=true` guard. CI and GitHub Actions reject this
bypass. Formal certification continues to require an exact commit SHA.

Provider CLIs own and persist their credentials in the private integration
home. Nanasa passes the same scoped home to local certification and does not
copy credentials into fixtures or environment broker files.

Provider compilation defaults to manual mode. Packages that require compilation
must be compiled outside Nanasa and imported as resolved signed packages. Set
`NANASA_PROVIDER_COMPILER_MODE=sandboxed` only on a host where Bubblewrap
namespace and filesystem isolation passes its startup probe.
