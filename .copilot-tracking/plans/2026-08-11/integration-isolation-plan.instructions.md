<!-- markdownlint-disable-file -->
---
description: Implement repository-local coding-agent integration homes and lifecycle commands
applyTo: '**'
---

## User requests

* Keep Nanasa hooks, extensions, plugins, settings, and auth separate from coding
  agents launched outside Nanasa.
* Define agent-type-specific configuration homes in `.nanasa/config.yaml`.
* Support shared, member-specific, and custom repository-local homes.
* Add integration setup, authentication, and diagnostic commands.
* Do not preserve compatibility or add legacy cleanup for this proof of concept.

## Objectives

* Make repository-local isolation the default and invariant.
* Generate all provider integration assets beneath `.nanasa/integrations`.
* Preserve per-run MCP bearer capabilities only in process environments.
* Provide package CLI workflows without modifying provider-global state.

## Context summary

* Repository rules: `.github/copilot-instructions.md`, `AGENTS.md`
* Markdown rules: HVE Core markdown and writing-style instructions
* Research: `.copilot-tracking/research/2026-08-11/integration-isolation-research.md`

## Implementation checklist

### Phase 1: Configuration contract
<!-- parallelizable: false -->

* [x] Add strict `agentConfigHome` schemas and defaults.
* [x] Resolve safe shared, member, and custom integration homes.
* [x] Add integration paths to repository path discovery.

### Phase 2: Runtime provisioning
<!-- parallelizable: false -->

* [x] Move all generated provider files beneath `.nanasa/integrations`.
* [x] Inject provider-specific isolated-home environments.
* [x] Remove global Copilot writes and credential symlinks.

### Phase 3: Package CLI
<!-- parallelizable: false -->

* [x] Add `nanasa setup`.
* [x] Add `nanasa auth <agent-type>` with member selection when required.
* [x] Add non-destructive `nanasa doctor`.
* [x] Bundle reusable CLI administration code.

### Phase 4: Distribution and documentation
<!-- parallelizable: true -->

* [x] Update the template, ignore policy, and README.
* [x] Add sentinel-home and packed-package coverage.

### Phase 5: Validation
<!-- parallelizable: false -->

* [x] Run focused tests after each implementation phase.
* [x] Run workspace typecheck, tests, lint, format, and package tests.

## Dependencies

* Node.js 22
* YAML and Zod configuration parsing
* Provider-supported home environment variables

## Success criteria

* Generated provider state exists only beneath `.nanasa/integrations`.
* A temporary sentinel `HOME` remains unchanged after provisioning.
* All configured scopes resolve deterministically and reject unsafe paths.
* CLI setup, auth, and doctor behavior is covered in package tests.
* Full validation passes.
