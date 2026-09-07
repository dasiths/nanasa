# Test Nanasa

Contributors can run focused checks locally and understand which release claims
need external certification.

## Run local checks

Load the repository registry environment before package-manager operations:

```bash
set -a
source .devcontainer/.env
set +a
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

The wider release gate also checks package installation, Chromium acceptance,
architecture and security scans, performance budgets, provenance, software bill
of materials, documentation drift, schema-exact release and rollback fault
injection, process cleanup, immutable fixtures, fixed-seed property models,
bounded fuzzing, and a coverage ratchet.

Measured performance covers a real 100-terminal tmux fleet, event storms,
default-batch delivery, action scheduling, and slow-consumer closure. Warmed
samples assert median throughput, p95 time and event-loop delay, plus peak heap
and resident-memory deltas. Results go only to ignored test output.

## Run external certification

The continuous integration matrix covers Node.js 22 and 24, Linux x64 and arm64,
and Chromium, Firefox, and WebKit jobs. Manual entry points cover built-in
providers, WebKit, native arm64, Node.js 24, Ubuntu, persistent systemd, and live
SSH. Each entry verifies the exact candidate and fails when its declared runner
or allowlisted credential is unavailable. Provider and SSH output is redacted.

A local container cannot prove native arm64, every supported distribution, a
persistent user manager, a live SSH target, or external provider accounts. Keep
release claims bounded until the relevant jobs pass.

## Certify a provider locally

For membership state, authenticate and certify the same configured agent map key:

```bash
npx nanasa auth login <integration-id> --agent <agent-id>
pnpm certify:provider:local <provider-id> <integration-id> --agent <agent-id>
```

For integration state, omit `--agent` from both commands. Local certification
uses a guarded dirty-tree SHA bypass and defaults to provider launch, reporter,
process, and native-session smoke checks. Add `--full` for native wait
acknowledgement and pane-loss resume. Formal certification always uses the full
profile and an exact commit SHA.

Provider credentials stay in the selected private home. Do not copy them into
fixtures or broker examples.
