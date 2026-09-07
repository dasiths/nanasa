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

## Publish a tagged release

Push a version tag that matches `package.json`, such as
`v0.1.0-next.11.0`. The tagged commit must belong to `main`.

The Release workflow runs required CI, builds the package with the commit time,
and runs the release gate. It creates these files:

* npm package tarball
* Build metadata
* SPDX software bill of materials
* SHA-256 checksums
* GitHub build provenance

The workflow publishes the files in a GitHub Release through the `release`
environment. Configure protection rules for that environment before the first
release. The workflow does not use provider keys.

Set the repository variable `NANASA_PUBLISH_NPM` to `true` to also publish the
tarball to npm. npm trusted publishing must allow this repository and workflow.
Publication uses GitHub OIDC and does not need a stored npm token. Leave the
variable unset when GitHub Releases are the only publication target.

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

Keep candidate evidence with the exact commit it verifies.
