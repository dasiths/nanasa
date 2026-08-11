<!-- markdownlint-disable-file -->
# Flattened Agent Model Plan

## User Requests

- Remove unnecessary public profile and membership complexity.
- Refactor the alpha configuration directly without compatibility or version handling.
- Preserve layered instructions at every specialization level.

## Context

Research: `.copilot-tracking/research/2026-08-11/flattened-agent-model-research.md`

Follow `.github/copilot-instructions.md` and `AGENTS.md`.

## Phase 1: Contracts And Configuration
<!-- parallelizable: false -->

- [x] Replace `agentTypes` with `integrations`.
- [x] Remove root version and configured profiles.
- [x] Replace group memberships with configured agents.
- [x] Add direct agent CRUD and order contracts.
- [x] Rename configuration-home scopes to integration and agent.
- [x] Reject the old schema strictly.

## Phase 2: Runtime Projection And Prompts
<!-- parallelizable: false -->

- [x] Project configured agents into private SQLite profiles and memberships.
- [x] Preserve stable agent and member identities.
- [x] Compose built-in, global, group, role, and agent instruction layers.
- [x] Adapt provider provisioning, homes, MCP discovery, and status joins.
- [x] Replace profile and membership REST routes with group-agent routes.

## Phase 3: Portal Simplification
<!-- parallelizable: false -->

- [x] Replace two-step profile/membership creation with one Agent form.
- [x] Replace split settings with one Agent Settings form.
- [x] Show inherited global/group/role instructions read-only.
- [x] Use atomic agent CRUD, order, and run routes.
- [x] Remove profile/default-role/override terminology.

## Phase 4: YAML, Templates, And Documentation
<!-- parallelizable: false -->

- [x] Rewrite `.nanasa/config.yaml` to the flattened schema.
- [x] Rewrite the shipped template.
- [x] Update CLI/admin terminology and documentation.
- [x] Remove obsolete profile instruction examples and guidance.

## Phase 5: Validation
<!-- parallelizable: false -->

- [x] Rewrite focused contracts, config, server, portal, and package tests.
- [x] Run full unit, component, package, and static gates.
- [x] Verify all four providers, prompt layers, status, messages, and recovery.
- [x] Verify portal CRUD, ordering, settings, desktop/mobile layout, and restart persistence.

## Success Criteria

- Operators manage only integrations, roles, groups, and agents.
- Profiles and memberships are absent from YAML and portal UX.
- Effective instructions remain deterministic and additive.
- Existing member IDs, runtime homes, messages, runs, and recovery remain valid.
- The old config shape fails validation.
