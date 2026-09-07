# Test Nanasa

Required CI uses GitHub-hosted runners and does not need provider keys.

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

## Understand required CI

CI runs for pull requests and pushes to `main`. It checks source quality, unit
tests, migrations, release behavior, package contents, Chromium acceptance, and
security rules. Terminal tests use a local safe echo process inside real tmux
panes. They do not call Copilot, Claude, OpenCode, or Pi.

The final `required` job passes only when every CI job passes. Configure branch
protection to require that job before merging.

## Run compatibility checks

The Compatibility workflow runs only when a maintainer starts it. It accepts an
exact pushed commit SHA and checks:

* Node.js 22 and 24
* Ubuntu 22.04 and 24.04
* Chromium, Firefox, and WebKit
* Native Linux arm64
* Measured performance
* Production dependency audit

These jobs use GitHub-hosted runners and do not use provider keys. The workflow
has no push, pull request, or scheduled trigger.

Measured performance covers a real 100-terminal tmux fleet, event storms,
default-batch delivery, action scheduling, and slow-consumer closure. Warmed
samples assert median throughput, p95 time and event-loop delay, plus peak heap
and resident-memory deltas. Results go only to ignored test output.

## Check a real provider

Real provider checks stay outside required CI and Compatibility. They need the
provider CLI, an account, and private authentication state. For membership
state, authenticate and check the same configured agent map key:

```bash
npx nanasa auth login <integration-id> --agent <agent-id>
pnpm certify:provider:local <provider-id> <integration-id> --agent <agent-id>
```

For integration state, omit `--agent` from both commands. Local certification
defaults to provider launch, reporter, process, and native-session smoke checks.
Add `--full` for native wait acknowledgement and pane-loss resume.

Provider credentials stay in the selected private home. Do not copy them into
fixtures or broker examples.
