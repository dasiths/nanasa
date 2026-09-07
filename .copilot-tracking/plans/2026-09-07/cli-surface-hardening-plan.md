---
title: CLI surface hardening plan
description: Phased implementation plan for consistent Nanasa defaults, startup settings, commands, tests, and documentation
ms.date: 2026-09-07
ms.topic: plan
---

## Objective

Make plain `nanasa start` launch the complete local team coordination product, align
foreground and systemd startup, and remove verified command and documentation footguns.

The authoritative research is
`.copilot-tracking/research/2026-09-07/cli-surface-footguns-research.md`.

## Contract

* MCP is enabled by default on the loopback listener
* `--no-mcp` and `NANASA_MCP_ENABLED=false` are explicit opt-outs
* CLI flags override environment variables, which override product defaults
* `service install` accepts and persists host, port, and MCP startup settings
* Control commands derive their default API URL from `NANASA_HOST` and `NANASA_PORT`
* Invalid startup values fail before service files are installed or a daemon is spawned
* Command declarations, generated references, help, guides, and examples agree
* Existing security rules continue to prohibit non-loopback control-plane binding

## Phase 1: Characterize startup behavior

* [x] Add tests for the default and explicit MCP states
* [x] Add tests for host and port flag precedence over environment variables
* [x] Add service installation tests for persisted host, port, and MCP values
* [x] Add control-client tests for host and port URL derivation

### Phase 1 success criteria

The tests fail against the current implementation for the expected contract reasons and
do not depend on a live provider or external network.

## Phase 2: Unify startup settings

* [x] Default daemon MCP startup to enabled
* [x] Add `--no-mcp` while retaining `--mcp` compatibility
* [x] Resolve common service settings with flag, environment, and default precedence
* [x] Persist resolved service host, port, and MCP state in owner-only `service.env`
* [x] Derive the control API fallback URL from `NANASA_HOST` and `NANASA_PORT`
* [x] Remove the redundant package-script-only MCP default

### Phase 2 success criteria

Foreground CLI, direct daemon, package script, and installed systemd service all resolve
to loopback host 127.0.0.1, port 3210, portal enabled, and MCP enabled unless the operator
supplies an explicit override.

## Phase 3: Repair command declarations and completion

* [x] Allow the optional group filter on `status list`
* [x] Allow the optional member filter on `wait list`
* [x] Remove the nonexistent migration family from help
* [x] Generate family and subcommand completion for Bash, Zsh, Fish, and PowerShell
* [x] Add grammar and completion contract tests

### Phase 3 success criteria

Every advertised family exists, supported filters pass argument validation, and all four
shell completion formats include registry-backed second-level commands.

## Phase 4: Repair documentation and examples

* [x] Update top-level help and the CLI reference with the precedence contract
* [x] Replace normal `start --mcp` examples with plain `start`
* [x] Document `--no-mcp` as an explicit diagnostic or single-agent opt-out
* [x] Document shared control command options and API URL derivation
* [x] Clarify service installation startup options and persistence
* [x] Regenerate `docs/reference/cli.json`

### Phase 4 success criteria

A user can follow the README, quickstart, MCP guide, service guide, or multi-agent example
and obtain the same complete startup behavior without discovering an undocumented flag.

## Phase 5: Validate the release surface

* [x] Run focused package CLI and daemon tests
* [x] Run reference generation checks
* [ ] Run documentation validation (blocked by unrelated `docs/portal-functional-bugs.md`)
* [x] Run formatting, lint, and type checking for touched files
* [x] Run the broader package test when focused checks pass
* [x] Record any unrelated failures without modifying unrelated code

### Phase 5 success criteria

All focused tests pass, generated artifacts match source declarations, documentation links
and examples validate, and no touched file has a static diagnostic.

## Stop conditions

Stop and correct the active phase if a change:

* Exposes MCP or the control API on a non-loopback listener
* Stores an operator or provider credential in authored configuration
* Changes the control request or response schema
* Breaks service removal, upgrade, rollback, or retained tmux process behavior
* Requires a live provider credential for validation
* Makes direct daemon, packaged CLI, and systemd defaults diverge again

## Deferred follow-up

Add accepted option metadata to each CLI command declaration. Use it to reject irrelevant
global options and generate command-specific help and richer completion. This is a registry
schema change and is intentionally separate from the immediate startup and correctness fixes.
