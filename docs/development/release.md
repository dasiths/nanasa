# Release and roll back Nanasa

Maintainers can publish an immutable package and activate it without confusing
package readiness with agent-process continuity.

## Keep one identity

Preview versions use semantic prerelease versions and the npm `next` channel.
Stable versions use plain semantic versions and `latest`. A published version is
immutable. Package metadata, build metadata, software bill of materials,
documentation, and release evidence must identify the same commit.

Verify that the selected distribution tag and exact version exist in the target
registry before publishing user instructions.

## Build the release transaction

Resolve and verify the candidate before stopping the daemon. The active and
candidate builds must declare the exact same database schema for an in-place
activation. Create a write-ahead-log-safe verified backup. Stage the database,
configuration, extension lock, generated overlays, and package pointer without
transforming the database.

Stop only the daemon and preserve tmux-owned processes. Activate state artifacts,
commit the package pointer last, start the candidate service, and require bounded
readiness. Browsers receive a typed restart signal and resnapshot. Gateway
WebSockets and attachment pseudo-terminals are not handed off.

If readiness fails, restore the exact prior package pointer and state artifacts
before starting the previous service. Database schema changes require a verified
backup followed by the explicit alpha reset path; release activation does not
upgrade a database.

## Run the dry release

Load the private registry environment, then run the release dry run. It checks
package allowlists, support metadata, size budgets, provenance, SPDX
relationships, documentation, exact-schema activation and rollback, fixtures,
fuzzing, and orphan cleanup without publishing.

Follow the repository release tooling rather than reproducing its commands from
an old document. Keep candidate evidence with the exact commit it verifies.
